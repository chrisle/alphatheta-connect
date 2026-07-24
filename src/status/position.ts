import StrictEventEmitter from 'strict-event-emitter-types';

import {Socket} from 'dgram';
import {EventEmitter} from 'events';

import {CDJStatus} from 'src/types';

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
   * @param beatSocket A UDP socket to receive position packets on port 50001
   * @param stagehandMode Enable Stagehand-only VU-meter parsing. Off by default
   *   so non-Stagehand connections behave as they did before Stagehand.
   */
  constructor(beatSocket: Socket, stagehandMode = false) {
    this.#stagehandMode = stagehandMode;
    beatSocket.on('message', this.#handlePosition);
  }

  // Bind public event emitter interface
  on: Emitter['on'] = this.#emitter.addListener.bind(this.#emitter);
  off: Emitter['off'] = this.#emitter.removeListener.bind(this.#emitter);
  once: Emitter['once'] = this.#emitter.once.bind(this.#emitter);

  #handlePosition = (message: Buffer) => {
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
