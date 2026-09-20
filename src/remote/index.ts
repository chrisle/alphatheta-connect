/**
 * The remote: on the Pro DJ Link network as a Stagehand, the way the iPad app
 * joins, driving players with the transport packets the app's Sound Check
 * sends and remembering the last status each player reported. The REST API
 * over it is in `./server`.
 */
import {NetworkInterfaceInfoIPv4, networkInterfaces} from 'os';

import {LoadSource} from 'src/control';
import {Logger} from 'src/logger';
import {bringOnlineStagehand, NetworkConfig, ProlinkNetwork} from 'src/network';
import {CDJStatus, Device, DeviceType, MediaSlot, MediaSlotInfo} from 'src/types';
import {getMatchingInterface} from 'src/utils';

/**
 * The Stagehand transport opcodes (packet 0x07) the iPad app was captured
 * sending, besides play (0x0f then 0x14 pressed) and pause (0x14 released),
 * which `Control` sends itself. These are held while pressed.
 */
export const TransportOp = {
  SkipForward: 0x18,
  SkipBackward: 0x19,
  SeekForward: 0x1a,
  SeekBackward: 0x1b,
} as const;

/**
 * The device numbers the Stagehand app was seen using: 141..=211.
 */
const STAGEHAND_FIRST_NUMBER = 141;
const STAGEHAND_NUMBER_COUNT = 71;

const TAP_MS = 100;

export class RemoteError extends Error {}

export class NoPlayerError extends RemoteError {
  constructor(number: number) {
    super(`no player ${number} on the link`);
  }
}

export class CueUnknownError extends RemoteError {
  constructor() {
    super(
      'cue has no known Stagehand opcode; set the cue opcode once one is found (probe with POST /players/<n>/op)'
    );
  }
}

export interface RemoteOptions {
  /** Interface name or address; default: the one the first player heard is on. */
  iface?: string;
  /** Device number 141..211; default: one derived from the interface's MAC. */
  number?: number;
  /** The Stagehand opcode for CUE, once one is found. */
  cueOp?: number;
  logger?: Logger;
}

/**
 * A player as the API reports it: its identity from the keep-alives and its
 * last status, when it has sent one.
 */
export interface Player {
  number: number;
  name: string;
  ip: string;
  status?: CDJStatus.State;
}

function resolveIface(hint: string): NetworkInterfaceInfoIPv4 {
  const all = networkInterfaces();
  for (const [name, infos] of Object.entries(all)) {
    for (const info of infos ?? []) {
      if (info.family !== 'IPv4' || info.internal) {
        continue;
      }
      if (name === hint || info.address === hint) {
        return info;
      }
    }
  }
  const available = Object.entries(all)
    .flatMap(([name, infos]) =>
      (infos ?? [])
        .filter(i => i.family === 'IPv4' && !i.internal)
        .map(i => `${name}:${i.address}`)
    )
    .join(', ');
  throw new RemoteError(`no interface "${hint}"; available: ${available}`);
}

/**
 * A device number that does not change between runs. A CDJ-3000 keeps one
 * record per peer address and ignores a later claim from that address under
 * another number or MAC until it reboots, so a random number per run may
 * never be served.
 */
function numberFor(iface: NetworkInterfaceInfoIPv4) {
  const mac = iface.mac.split(':').map(b => parseInt(b, 16));
  const last = mac[5] ?? 0;
  return STAGEHAND_FIRST_NUMBER + (last % STAGEHAND_NUMBER_COUNT);
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export class Remote {
  #network: ProlinkNetwork;
  #statuses = new Map<number, CDJStatus.State>();
  #cueOp?: number;

  private constructor(network: ProlinkNetwork, cueOp?: number) {
    this.#network = network;
    this.#cueOp = cueOp;
    this.#status.on('status', s => this.#statuses.set(s.deviceId, s));
  }

  get #status() {
    const emitter = this.#network.statusEmitter;
    if (emitter === null) {
      throw new RemoteError('not connected to the link');
    }
    return emitter;
  }

  /**
   * Join the link and start collecting status. Resolves once the Stagehand
   * join sequence is through and keep-alives are running.
   */
  static async join(opts: RemoteOptions = {}): Promise<Remote> {
    const network = await bringOnlineStagehand({
      logger: opts.logger,
    } as Omit<NetworkConfig, 'connectMethod'>);

    let iface: NetworkInterfaceInfoIPv4;
    if (opts.iface !== undefined) {
      iface = resolveIface(opts.iface);
    } else {
      opts.logger?.info('waiting for a player to pick the interface');
      const dm = network.deviceManager;
      const first = await new Promise<Device>(resolve => dm.once('connected', resolve));
      const match = getMatchingInterface(first.ip);
      if (match === null) {
        throw new RemoteError(`no local interface matches ${first.ip.address}`);
      }
      iface = match;
    }

    network.configure({iface, vcdjId: opts.number ?? numberFor(iface)});
    network.connect();
    if (!network.isConnected()) {
      throw new RemoteError('failed to connect to the link');
    }
    await network.startupReady;

    const me = network.virtualDevice;
    opts.logger?.info(`on the link as "${me?.name}" #${me?.id} at ${iface.address}`);
    return new Remote(network, opts.cueOp);
  }

  get network() {
    return this.#network;
  }

  /**
   * Our own device as announced.
   */
  get me(): Device | null {
    return this.#network.virtualDevice;
  }

  /**
   * Every device heard on the link, by number.
   */
  get devices(): Device[] {
    return [...this.#network.deviceManager.devices.values()].sort((a, b) => a.id - b.id);
  }

  /**
   * The players, with the last status each one sent.
   */
  get players(): Player[] {
    return this.devices
      .filter(d => d.type === DeviceType.CDJ)
      .map(d => ({
        number: d.id,
        name: d.name,
        ip: d.ip.address,
        status: this.#statuses.get(d.id),
      }));
  }

  player(number: number): Device {
    const device = this.#network.deviceManager.devices.get(number);
    if (device === undefined || device.type !== DeviceType.CDJ) {
      throw new NoPlayerError(number);
    }
    return device;
  }

  get #control() {
    const control = this.#network.control;
    if (control === null) {
      throw new RemoteError('not connected to the link');
    }
    return control;
  }

  get #me() {
    const me = this.#network.virtualDevice;
    if (me === null) {
      throw new RemoteError('not connected to the link');
    }
    return me;
  }

  play(number: number) {
    return this.#control.play(this.player(number));
  }

  pause(number: number) {
    return this.#control.pause(this.player(number));
  }

  /**
   * Press and release the cue button, once its opcode is known.
   */
  cue(number: number) {
    if (this.#cueOp === undefined) {
      throw new CueUnknownError();
    }
    return this.tap(number, this.#cueOp, TAP_MS);
  }

  /**
   * Hold fast-forward for `holdMs`.
   */
  fastForward(number: number, holdMs: number) {
    return this.tap(number, TransportOp.SeekForward, holdMs);
  }

  /**
   * Hold rewind for `holdMs`.
   */
  rewind(number: number, holdMs: number) {
    return this.tap(number, TransportOp.SeekBackward, holdMs);
  }

  skipForward(number: number) {
    return this.tap(number, TransportOp.SkipForward, TAP_MS);
  }

  skipBackward(number: number) {
    return this.tap(number, TransportOp.SkipBackward, TAP_MS);
  }

  /**
   * One transport packet: `op` pressed or released.
   */
  transport(number: number, op: number, press: boolean) {
    return this.#control.transport(this.player(number), op, press);
  }

  /**
   * Press `op`, hold it for `holdMs`, release it.
   */
  async tap(number: number, op: number, holdMs: number) {
    await this.transport(number, op, true);
    await sleep(holdMs);
    await this.transport(number, op, false);
  }

  /**
   * What is in a player's USB and SD slots, as the player answers a media
   * query; a slot it does not answer for is left out.
   */
  async media(number: number): Promise<MediaSlotInfo[]> {
    const device = this.player(number);
    const slots: MediaSlotInfo[] = [];
    for (const slot of [MediaSlot.USB, MediaSlot.SD]) {
      try {
        slots.push(
          await this.#status.queryMediaSlot({hostDevice: this.#me, device, slot})
        );
      } catch {
        // an empty slot is not answered for
      }
    }
    return slots;
  }

  /**
   * Tell a player to load a track from `source` (another player's stick, or a
   * library served over the link).
   */
  loadTrack(number: number, trackId: number, source: LoadSource) {
    return this.#control.loadTrack(this.player(number), trackId, source);
  }

  async leave() {
    this.#network.disconnect();
    await this.#network.close();
  }
}
