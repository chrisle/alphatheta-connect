import {Socket} from 'dgram';

import {BEAT_PORT, PROLINK_HEADER, STATUS_PORT} from 'src/constants';
import {isPlaying} from 'src/mixstatus/utils';
import type StatusEmitter from 'src/status';
import {CDJStatus, Device, DeviceType} from 'src/types';
import {buildName} from 'src/utils';
import {udpSend} from 'src/utils/udp';

import {LoadSource, makeLoadTrackPacket} from './load';
import {
  makeStagehandConnectPacket,
  makeStagehandPrefWritePacket,
  makeStagehandTransportPacket,
  StagehandKey,
} from './stagehand';

export {LoadSource, makeLoadTrackPacket} from './load';
export {StagehandKey} from './stagehand';

interface Options {
  hostDevice: Device;
  device: Device;
  playState: CDJStatus.PlayState.Cued | CDJStatus.PlayState.Playing;
}

const STATE_MAP = {
  [CDJStatus.PlayState.Cued]: 0x01,
  [CDJStatus.PlayState.Playing]: 0x00,
};

/**
 * Generates the packet used to control the playstate of CDJs in active connection mode
 */
export const makePlaystatePacket = ({hostDevice, device, playState}: Options) =>
  Uint8Array.from([
    ...PROLINK_HEADER,
    ...[0x02],
    ...buildName(hostDevice),
    ...[0x01, 0x00],
    ...[hostDevice.id],
    ...[0x00, 0x04],
    ...new Array(4)
      .fill(0x00)
      .map((_, i) => (i === device.id ? STATE_MAP[playState] : 0)),
  ]);

export default class Control {
  #hostDevice: Device;
  /**
   * The socket used to send control packets
   */
  #beatSocket: Socket;
  /**
   * The socket bound to the status port, which the Load Track command must
   * leave from: a CDJ-3000 ignores it from any other port. Absent when the
   * control service was built without one.
   */
  #statusSocket: Socket | null;
  /**
   * The status of every player, as last reported. A Stagehand has one
   * play/pause key and no other way to start or stop a player, so `play` and
   * `pause` read the state from here. Absent when the control service was
   * built without a status emitter.
   */
  #statusEmitter: StatusEmitter | null;
  #statuses = new Map<number, CDJStatus.State>();
  /**
   * The players (by address) we have sent a Stagehand connect frame to. A
   * player obeys our key events only after one.
   */
  #connected = new Map<string, Device>();

  constructor(
    beatSocket: Socket,
    hostDevice: Device,
    statusSocket: Socket | null = null,
    statusEmitter: StatusEmitter | null = null
  ) {
    this.#beatSocket = beatSocket;
    this.#statusSocket = statusSocket;
    this.#statusEmitter = statusEmitter;
    this.#hostDevice = hostDevice;
    statusEmitter?.on('status', this.#onStatus);
  }

  #onStatus = (status: CDJStatus.State) => {
    this.#statuses.set(status.deviceId, status);
  };

  /**
   * Take control of a player as a Stagehand, so that it obeys our key events.
   * Sent once, before the first key to a player, by everything below that
   * sends keys; call it again if a player has been restarted.
   */
  async connect(device: Device) {
    const p = makeStagehandConnectPacket(this.#hostDevice);
    await udpSend(this.#beatSocket, p, BEAT_PORT, device.ip.address);
    this.#connected.set(device.ip.address, device);
  }

  /**
   * Let go of every player we took control of, and stop following their
   * status.
   */
  async disconnect() {
    this.#statusEmitter?.off('status', this.#onStatus);

    const players = [...this.#connected.values()];
    this.#connected.clear();
    const p = makeStagehandConnectPacket(this.#hostDevice, false);
    await Promise.all(
      players.map(d => udpSend(this.#beatSocket, p, BEAT_PORT, d.ip.address))
    );
  }

  /**
   * Send one Stagehand key event (0x07) carrying `key` with the press /
   * release flag, for keys the named methods do not cover. See
   * {@link StagehandKey}.
   */
  async transport(device: Device, key: number, press: boolean) {
    if (!this.#connected.has(device.ip.address)) {
      await this.connect(device);
    }
    const p = makeStagehandTransportPacket(this.#hostDevice, key, press);
    await udpSend(this.#beatSocket, p, BEAT_PORT, device.ip.address);
  }

  /**
   * Tell a player to load a track, as rekordbox does when a row is dragged
   * onto a deck: the Load Track command (0x19) from our status port to the
   * player's. The player answers 0x1a and the load shows in its next status.
   *
   * `source` names where the track lives: a device number and its slot (a
   * player's USB or SD, or the rekordbox slot of a library served over the
   * link).
   */
  async loadTrack(device: Device, trackId: number, source: LoadSource) {
    if (this.#statusSocket === null) {
      throw new Error(
        'loadTrack needs the status socket; connect through ProlinkNetwork'
      );
    }
    const p = makeLoadTrackPacket(this.#hostDevice, device, trackId, source);
    await udpSend(this.#statusSocket, p, STATUS_PORT, device.ip.address);
  }

  /**
   * Start or stop a CDJ on the network.
   * Delegates automatically to Stagehand-specific transport control if connected in Stagehand mode.
   */
  async setPlayState(device: Device, playState: Options['playState']) {
    if (this.#hostDevice.type === DeviceType.Stagehand) {
      if (playState === CDJStatus.PlayState.Playing) {
        await this.play(device);
      } else {
        await this.pause(device);
      }
      return;
    }

    const packet = makePlaystatePacket({hostDevice: this.#hostDevice, device, playState});
    await udpSend(this.#beatSocket, packet, BEAT_PORT, device.ip.address);
  }

  /**
   * Press the Stagehand PLAY/PAUSE key once: it starts a stopped player and
   * stops a playing one.
   */
  async togglePlayPause(device: Device) {
    await this.transport(device, StagehandKey.PlayPause, true);
    await this.transport(device, StagehandKey.PlayPause, false);
  }

  /**
   * Start a player, unless it is playing already: the Stagehand key only
   * toggles, so this goes by the last status the player reported, and throws
   * when there has been none.
   */
  async play(device: Device) {
    if (!isPlaying(this.#lastStatus(device))) {
      await this.togglePlayPause(device);
    }
  }

  /**
   * Stop a player, unless it is stopped already. Like `play` it goes by the
   * last status the player reported, and throws when there has been none.
   */
  async pause(device: Device) {
    if (isPlaying(this.#lastStatus(device))) {
      await this.togglePlayPause(device);
    }
  }

  #lastStatus(device: Device) {
    const status = this.#statuses.get(device.id);
    if (status === undefined) {
      throw new Error(
        `no status heard from player ${device.id} yet; play and pause need to know whether it is playing`
      );
    }
    return status;
  }

  /**
   * Send Stagehand SEEK forward command
   * @param press - true to start seek, false to release
   */
  seekForward(device: Device, press: boolean) {
    return this.transport(device, StagehandKey.SeekForward, press);
  }

  /**
   * Send Stagehand SEEK backward command
   * @param press - true to start seek, false to release
   */
  seekBackward(device: Device, press: boolean) {
    return this.transport(device, StagehandKey.SeekBackward, press);
  }

  /**
   * Send Stagehand SKIP track command
   * @param press - true to start skip, false to release
   */
  skip(device: Device, press: boolean) {
    return this.transport(device, StagehandKey.SkipForward, press);
  }

  /**
   * Send Stagehand preference write command (0x6b packet) to port 50002
   */
  async setPreference(
    device: Device,
    options: {onAir?: 'on' | 'off'; quantize?: number}
  ) {
    const p = makeStagehandPrefWritePacket(this.#hostDevice, options);
    await udpSend(this.#beatSocket, p, STATUS_PORT, device.ip.address);
  }
}
