import * as ip from 'ip-address';

import {Socket} from 'dgram';
import {NetworkInterfaceInfoIPv4} from 'os';

import {ANNOUNCE_PORT, PROLINK_HEADER} from 'src/constants';
import DeviceManager from 'src/devices';
import {type Logger, noopLogger} from 'src/logger';
import {Device, DeviceID, DeviceType} from 'src/types';
import {buildName, getBroadcastAddress} from 'src/utils';

export const STAGEHAND_STARTUP_INTERVAL = 305;
export const STAGEHAND_KEEP_ALIVE_INTERVAL = 2000;

export enum StagehandStartupStage {
  InitialAnnounce = 0x0a,
  SecondStageClaim = 0x02,
  KeepAlive = 0x06,
}

/**
 * The protocol-layer MAC a Stagehand device embeds in its 0x02 claim and 0x06
 * keep-alive: the AlphaTheta OUI (c8:3d:fc) followed by the low three bytes of
 * the interface's own MAC.
 *
 * This must stay stable for the life of the host. A CDJ-3000 records a peer by
 * the identity in its claim, and once it holds a record for our IP it ignores
 * later claims from the same IP that carry a different MAC or device number:
 * the new peer never receives the unicast status/position stream. Observed on
 * emulated CDJ-3000 firmware 3.20: a freshly randomized identity on every
 * connect() was served once and then never again until the player rebooted,
 * while the previously registered identity kept being served immediately.
 */
export function getStagehandMac(iface: NetworkInterfaceInfoIPv4): Uint8Array {
  const ifaceMac = iface.mac.split(':').map(s => parseInt(s, 16));
  return Uint8Array.from([0xc8, 0x3d, 0xfc, ...ifaceMac.slice(3, 6)]);
}

/**
 * The device number a Stagehand announces itself as.
 *
 * A player takes a Stagehand's number from the numbers `0x36` to `0x3f`, which
 * it reserves for this device class; `0x3a` is the one the iPad app uses. The
 * numbers 141 to 211 seen in captures of the app are not numbers: they are the
 * same `0x3a` as a player sees it after {@link encodeStagehandNumber} hid it
 * behind a checksum, which differs from packet to packet.
 */
export const STAGEHAND_DEVICE_ID = 0x3a;
export const STAGEHAND_MIN_DEVICE_ID = 0x36;
export const STAGEHAND_MAX_DEVICE_ID = 0x3f;

/**
 * The checksum a player mixes into a Stagehand's device number: the sum of the
 * first 64 bytes of the packet (all of it when it is shorter), counting the
 * byte that holds the number as 0, plus the last three bytes of the protocol
 * MAC the sender announced in its keep-alive.
 */
function numberChecksum(packet: Uint8Array, offset: number, mac: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < Math.min(packet.length, 64); i++) {
    sum += i === offset ? 0 : packet[i];
  }
  for (const byte of mac.subarray(-3)) {
    sum += byte;
  }
  return sum;
}

/**
 * Writes the sender's device number into `packet[offset]` the way a player
 * expects it from a Stagehand: with the top bit set, the low seven bits being
 * the number XOR {@link numberChecksum}. The player undoes this on ports 50001
 * and 50002, so every packet that carries the number this way (the keep-alive
 * at 0x24, the type 0x07 key frames and the mixer heartbeat at 0x21) needs it
 * written last, once every other byte is in place. A plain value below 0x80 is
 * taken as it is.
 *
 * @param packet - The finished packet, with `packet[offset]` still unset
 * @param offset - Where the number sits in the packet
 * @param id - The device number, at most 0x7f
 * @param mac - The protocol-layer MAC announced in the keep-alive
 */
export function encodeStagehandNumber(
  packet: Uint8Array,
  offset: number,
  id: number,
  mac: Uint8Array
) {
  if (!Number.isInteger(id) || id < 0 || id > 0x7f) {
    throw new RangeError(`Stagehand device number ${id} does not fit in 7 bits`);
  }
  packet[offset] = 0x80 | ((id ^ numberChecksum(packet, offset, mac)) & 0x7f);
}

/**
 * The device number in `packet[offset]`: what {@link encodeStagehandNumber}
 * hid there, or the byte itself when its top bit is clear.
 *
 * @param mac - The protocol-layer MAC the packet's sender announced
 */
export function decodeStagehandNumber(
  packet: Uint8Array,
  offset: number,
  mac: Uint8Array
): number {
  const value = packet[offset];
  return value & 0x80 ? (value ^ numberChecksum(packet, offset, mac)) & 0x7f : value;
}

/**
 * A player sends a Stagehand its frames with its own number in byte 33 hidden
 * the same way (see {@link encodeStagehandNumber}), summed with the MAC the
 * player announced. The status and position parsers read the number there, so
 * this puts it back: it returns a copy of `message` with the number restored,
 * or `message` itself when byte 33 is plain, or when no announced device has
 * the sender's address, so there is no MAC to decode it with.
 *
 * @param address - Where the message came from
 * @param devices - The devices announced on the link, from the device manager
 */
export function restoreSenderNumber(
  message: Buffer,
  address: string | undefined,
  devices: Map<DeviceID, Device>
): Buffer {
  if (message.length <= 33 || (message[33] & 0x80) === 0) {
    return message;
  }
  const sender = [...devices.values()].find(d => d.ip.address === address);
  if (sender === undefined) {
    return message;
  }
  const restored = Buffer.from(message);
  restored[33] = decodeStagehandNumber(message, 33, sender.macAddr);
  return restored;
}

/**
 * Constructs a virtual Stagehand Device.
 *
 * @param iface - The network interface to use
 * @param id - The device number to use (defaults to {@link STAGEHAND_DEVICE_ID})
 * @param name - The device name (defaults to 'Stagehand')
 * @param macAddr - The protocol-layer MAC (defaults to one derived from iface)
 */
export const getVirtualStagehand = (
  iface: NetworkInterfaceInfoIPv4,
  id: DeviceID = STAGEHAND_DEVICE_ID,
  name = 'Stagehand',
  macAddr = getStagehandMac(iface)
): Device => ({
  id,
  name,
  type: DeviceType.Stagehand,
  ip: new ip.Address4(iface.address),
  macAddr,
});

/**
 * Build Stagehand stage 0x0a packet: Initial announcement.
 * Sent 3 times at 305ms intervals.
 */
export function makeStagehand0aPacket(device: Device): Uint8Array {
  const parts = [
    ...PROLINK_HEADER, // 10 bytes
    ...[0x0a, 0x00], // 2 bytes packet type (0x0a)
    ...buildName(device), // 20 bytes device name
    ...[0x01, 0x03], // 2 bytes protocol / structure bytes
    ...[0x00, 0x25], // 2 bytes packet length (37)
    ...[DeviceType.Stagehand], // 1 byte device type (0x05)
  ];
  return Uint8Array.from(parts);
}

/**
 * Build Stagehand stage 0x02 packet: Second-stage device number claim.
 * Sent 3 times at 305ms intervals with counter N (1, 2, 3).
 */
export function makeStagehand02Packet(
  device: Device,
  mac: Uint8Array,
  counter: number
): Uint8Array {
  const parts = [
    ...PROLINK_HEADER, // 10 bytes
    ...[0x02, 0x00], // 2 bytes packet type (0x02)
    ...buildName(device), // 20 bytes device name
    ...[0x01, 0x03], // 2 bytes protocol / structure bytes
    ...[0x00, 0x32], // 2 bytes packet length (50)
    ...device.ip.toArray(), // 4 bytes IP
    ...mac, // 6 bytes identifier
    ...[device.id], // 1 byte device number being claimed
    ...[counter], // 1 byte counter
    ...[DeviceType.Stagehand], // 1 byte device type (0x05)
    ...[0x01], // 1 byte constant
  ];
  return Uint8Array.from(parts);
}

/**
 * Build Stagehand stage 0x06 packet: Keep-alive.
 * Sent every 2.0s after startup complete.
 *
 * The device number at 0x24 is encoded (see {@link encodeStagehandNumber}): a
 * plain number there, or one that does not decode to 0x36..0x3f, files the
 * peer under another number and the players never answer it.
 */
export function makeStagehand06Packet(device: Device, mac: Uint8Array): Uint8Array {
  const parts = [
    ...PROLINK_HEADER, // 10 bytes
    ...[0x06, 0x00], // 2 bytes packet type (0x06)
    ...buildName(device), // 20 bytes device name
    ...[0x01, 0x03], // 2 bytes protocol / structure bytes
    ...[0x00, 0x36], // 2 bytes packet length (54)
    ...[0x00], // 1 byte device number, encoded below
    ...[0x01], // 1 byte constant
    ...mac, // 6 bytes identifier
    ...device.ip.toArray(), // 4 bytes IP
    ...[0x01, 0x00, 0x00, 0x00], // 4 bytes constant
    ...[DeviceType.Stagehand], // 1 byte device-type (0x05)
    ...[0x20], // 1 byte trailing byte
  ];
  const packet = Uint8Array.from(parts);
  encodeStagehandNumber(packet, 0x24, device.id, mac);
  return packet;
}

export class StagehandAnnouncer {
  #announceSocket: Socket;
  #vcdj: Device;
  #intervalHandle?: NodeJS.Timeout;
  #currentStage: StagehandStartupStage = StagehandStartupStage.InitialAnnounce;
  #stageCounter = 0;
  #iface: NetworkInterfaceInfoIPv4;
  #logger: Logger;
  #onStartupComplete?: () => void;
  #mac: Uint8Array;

  constructor(
    vcdj: Device,
    announceSocket: Socket,
    deviceManager: DeviceManager,
    iface: NetworkInterfaceInfoIPv4,
    logger: Logger = noopLogger
  ) {
    this.#vcdj = vcdj;
    this.#announceSocket = announceSocket;
    this.#iface = iface;
    this.#logger = logger;
    this.#mac = vcdj.macAddr;
  }

  get ready(): Promise<void> {
    if (this.#currentStage === StagehandStartupStage.KeepAlive) {
      return Promise.resolve();
    }
    return new Promise(resolve => {
      this.#onStartupComplete = resolve;
    });
  }

  start() {
    this.#logger.info(
      `Starting Stagehand announcer: device name "${this.#vcdj.name}", ID ${this.#vcdj.id}`
    );
    this.#startStartup();
  }

  #startStartup() {
    this.#currentStage = StagehandStartupStage.InitialAnnounce;
    this.#stageCounter = 0;
    this.#sendStagePackets();
  }

  #sendPacket(packet: Uint8Array) {
    const broadcastAddr = getBroadcastAddress(this.#iface);
    this.#announceSocket.send(packet, ANNOUNCE_PORT, broadcastAddr);
  }

  #sendStagePackets() {
    this.#stageCounter++;

    let packet: Uint8Array;
    switch (this.#currentStage) {
      case StagehandStartupStage.InitialAnnounce:
        packet = makeStagehand0aPacket(this.#vcdj);
        this.#logger.debug(
          `Stagehand sending stage 0x0a (announce) packet ${this.#stageCounter}/3`
        );
        break;
      case StagehandStartupStage.SecondStageClaim:
        packet = makeStagehand02Packet(this.#vcdj, this.#mac, this.#stageCounter);
        this.#logger.debug(
          `Stagehand sending stage 0x02 (claim) packet ${this.#stageCounter}/3`
        );
        break;
      case StagehandStartupStage.KeepAlive:
        this.#logger.info(
          'Stagehand join sequence complete, transitioning to keep-alive'
        );
        this.#startKeepAlive();
        this.#onStartupComplete?.();
        this.#onStartupComplete = undefined;
        return;
    }

    this.#sendPacket(packet);

    if (this.#stageCounter >= 3) {
      this.#advanceStage();
    }

    this.#intervalHandle = setTimeout(
      () => this.#sendStagePackets(),
      STAGEHAND_STARTUP_INTERVAL
    );
  }

  #advanceStage() {
    this.#stageCounter = 0;

    switch (this.#currentStage) {
      case StagehandStartupStage.InitialAnnounce:
        this.#currentStage = StagehandStartupStage.SecondStageClaim;
        break;
      case StagehandStartupStage.SecondStageClaim:
        this.#currentStage = StagehandStartupStage.KeepAlive;
        break;
    }
  }

  #startKeepAlive() {
    if (this.#intervalHandle) {
      clearTimeout(this.#intervalHandle);
      this.#intervalHandle = undefined;
    }

    const sendKeepAlive = () => {
      const packet = makeStagehand06Packet(this.#vcdj, this.#mac);
      this.#logger.debug('Stagehand sending keep-alive packet');
      this.#sendPacket(packet);
    };

    sendKeepAlive();

    this.#intervalHandle = setInterval(sendKeepAlive, STAGEHAND_KEEP_ALIVE_INTERVAL);
  }

  stop() {
    this.#logger.info('Stopping Stagehand announcer');
    if (this.#intervalHandle !== undefined) {
      clearInterval(this.#intervalHandle);
      clearTimeout(this.#intervalHandle);
      this.#intervalHandle = undefined;
    }
  }
}
