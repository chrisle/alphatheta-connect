import {Socket} from 'dgram';

import {PROLINK_HEADER, STATUS_PORT} from 'src/constants';
import DeviceManager from 'src/devices';
import {type Logger, noopLogger} from 'src/logger';
import {Device, DeviceType} from 'src/types';

/**
 * Cadence of the Stagehand unicast keep-alive, in milliseconds.
 *
 * The real iOS Stagehand app heartbeats every discovered player and the mixer
 * at ~4 Hz (250ms median inter-packet gap in captured traffic). This is the
 * stream that keeps AlphaTheta hardware unicasting live state (`0x39` mixer
 * fader/EQ, `0x58` VU on the mixer; `0x69` slim status, waveform families on
 * the CDJs) to our IP — subnet-broadcast presence alone (the `0x06` keep-alive)
 * is not enough to bootstrap it.
 */
export const STAGEHAND_HEARTBEAT_INTERVAL = 250;

/**
 * Builds a Stagehand name field for a unicast frame.
 *
 * Unlike the 20-byte {@link buildName} used by the broadcast announce/claim
 * frames, unicast frames carry a 19-byte name field (offsets 11..29) with the
 * device type / model bytes beginning at offset 30. The name is ASCII, NUL
 * padded.
 */
function buildUnicastName(name: string): Uint8Array {
  const field = new Uint8Array(19);
  field.set(Buffer.from(name, 'ascii').subarray(0, 19));
  return field;
}

/**
 * Build the Stagehand mixer keep-alive (`0x3a`, 40 bytes).
 *
 * Verified byte-for-byte against the real iOS Stagehand app unicasting to a
 * DJM-A9 at 4 Hz (Phase 4/5 captures §4.14.2). The 10-byte trailer
 * `21 02 00 fe 00 04 00 1c 00 00` is constant across every observed sample —
 * byte 33 (`0xfe`) is a VCDJ sentinel, not our runtime device number, so no
 * per-device bytes vary here.
 */
export function makeStagehandMixerHeartbeat(vcdj: Device): Uint8Array {
  const parts = [
    ...PROLINK_HEADER, // 0-9: magic
    0x3a, // 10: type 0x3a (mixer keep-alive)
    ...buildUnicastName(vcdj.name), // 11-29: name (19 bytes)
    0x21,
    0x02,
    0x00,
    0xfe,
    0x00,
    0x04,
    0x00,
    0x1c,
    0x00,
    0x00, // 30-39: constant trailer
  ];
  return Uint8Array.from(parts);
}

/**
 * Build the Stagehand player keep-alive (`0x68`, 36 bytes).
 *
 * Verified byte-for-byte against the real iOS Stagehand app unicasting to a
 * CDJ-3000 at ~2-4 Hz. Body (offsets 30-35) is `03 01 00 3a 00 00`: `0x03`
 * persona/channel, `0x01` device subkind, `0x00` flag, `0x3a` Stagehand
 * model-code stamp, two reserved bytes. Constant across every observed sample.
 */
export function makeStagehandPlayerHeartbeat(vcdj: Device): Uint8Array {
  const parts = [
    ...PROLINK_HEADER, // 0-9: magic
    0x68, // 10: type 0x68 (player keep-alive)
    ...buildUnicastName(vcdj.name), // 11-29: name (19 bytes)
    0x03,
    0x01,
    0x00,
    0x3a,
    0x00,
    0x00, // 30-35: constant body
  ];
  return Uint8Array.from(parts);
}

/**
 * Unicasts Stagehand keep-alive frames to every discovered player and mixer so
 * that AlphaTheta hardware begins (and keeps) pushing live state to our IP.
 *
 * The {@link StagehandAnnouncer} makes us *visible* on the network via subnet
 * broadcast; this heartbeat is what makes hardware actually *talk back*. It
 * targets the mixer with `0x3a` and each CDJ with `0x68`, mirroring the real
 * iOS Stagehand app. Frames are sent from the status socket (port 50002) to
 * each device's port 50002, which is where their unicast state replies land and
 * where {@link StatusEmitter} listens for them.
 */
export class StagehandHeartbeat {
  #statusSocket: Socket;
  #vcdj: Device;
  #deviceManager: DeviceManager;
  #logger: Logger;
  #intervalHandle?: NodeJS.Timeout;

  constructor(
    vcdj: Device,
    statusSocket: Socket,
    deviceManager: DeviceManager,
    logger: Logger = noopLogger
  ) {
    this.#vcdj = vcdj;
    this.#statusSocket = statusSocket;
    this.#deviceManager = deviceManager;
    this.#logger = logger;
  }

  start() {
    if (this.#intervalHandle !== undefined) {
      return;
    }

    this.#logger.info('Starting Stagehand heartbeat (unicast keep-alive)');
    this.#sendHeartbeats();
    this.#intervalHandle = setInterval(
      () => this.#sendHeartbeats(),
      STAGEHAND_HEARTBEAT_INTERVAL
    );
  }

  #sendHeartbeats() {
    for (const device of this.#deviceManager.devices.values()) {
      // Never heartbeat ourselves.
      if (device.id === this.#vcdj.id) {
        continue;
      }

      let packet: Uint8Array | null = null;
      switch (device.type) {
        case DeviceType.Mixer:
          packet = makeStagehandMixerHeartbeat(this.#vcdj);
          break;
        case DeviceType.CDJ:
          packet = makeStagehandPlayerHeartbeat(this.#vcdj);
          break;
        default:
          // Rekordbox / other Stagehand peers are not heartbeat targets.
          continue;
      }

      this.#statusSocket.send(packet, STATUS_PORT, device.ip.address, err => {
        if (err) {
          this.#logger.debug(
            `Stagehand heartbeat to ${device.name} (${device.ip.address}) failed: ${err.message}`
          );
        }
      });
    }
  }

  stop() {
    this.#logger.info('Stopping Stagehand heartbeat');
    if (this.#intervalHandle !== undefined) {
      clearInterval(this.#intervalHandle);
      this.#intervalHandle = undefined;
    }
  }
}
