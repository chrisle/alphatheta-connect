import StrictEventEmitter from 'strict-event-emitter-types';

import {RemoteInfo, Socket} from 'dgram';
import {EventEmitter} from 'events';

import type DeviceManager from 'src/devices';
import {CDJStatus} from 'src/types';
import {restoreSenderNumber} from 'src/virtualcdj/stagehand';

import {positionFromPacket, vuFromPacket} from './utils';

interface PositionEvents {
  /**
   * Fired when an absolute position packet is received from a CDJ-3000+.
   * These packets are sent approximately every 30ms while a track is loaded.
   */
  position: (position: CDJStatus.PositionState) => void;
  /**
   * Fired when real-time VU levels are received from the mixer under Stagehand connection.
   */
  vu: (vu: CDJStatus.VUState) => void;
}

type Emitter = StrictEventEmitter<EventEmitter, PositionEvents>;

/**
 * The position emitter reports absolute playhead position updates from CDJ-3000+ devices.
 * These packets provide precise track position independent of beat grids, enabling
 * accurate timecode, lighting cue, and video synchronization even during scratching,
 * reverse play, loops, and needle jumps.
 */
class PositionEmitter {
  /**
   * The EventEmitter which reports position updates
   */
  #emitter: Emitter = new EventEmitter();

  /**
   * Whether experimental Stagehand VU-meter (0x58) parsing is active.
   */
  #stagehandMode: boolean;

  /**
   * The devices announced on the link. In Stagehand mode a player's packets
   * carry its number behind a checksum of its MAC, which is looked up here.
   */
  #deviceManager: DeviceManager | undefined;

  /**
   * @param beatSocket A UDP socket to receive position packets on port 50001
   * @param stagehandMode Enable Stagehand-only VU-meter parsing. Off by default
   *   so non-Stagehand connections behave as they did before Stagehand.
   * @param deviceManager Lets Stagehand mode restore the sender's device
   *   number in a position packet, which players send hidden behind a checksum.
   */
  constructor(beatSocket: Socket, stagehandMode = false, deviceManager?: DeviceManager) {
    this.#stagehandMode = stagehandMode;
    this.#deviceManager = deviceManager;
    beatSocket.on('message', this.#handlePosition);
  }

  // Bind public event emitter interface
  on: Emitter['on'] = this.#emitter.addListener.bind(this.#emitter);
  off: Emitter['off'] = this.#emitter.removeListener.bind(this.#emitter);
  once: Emitter['once'] = this.#emitter.once.bind(this.#emitter);

  #handlePosition = (received: Buffer, rinfo?: RemoteInfo) => {
    const message =
      this.#stagehandMode && this.#deviceManager !== undefined
        ? restoreSenderNumber(received, rinfo?.address, this.#deviceManager.devices)
        : received;

    // Stagehand VU meter (type 0x58) — only parsed in Stagehand mode.
    if (this.#stagehandMode && message.length >= 11 && message[10] === 0x58) {
      const vu = vuFromPacket(message);
      if (vu !== undefined) {
        this.#emitter.emit('vu', vu);
        return;
      }
    }

    const position = positionFromPacket(message);

    if (position !== undefined) {
      this.#emitter.emit('position', position);
    }
  };
}

export default PositionEmitter;
