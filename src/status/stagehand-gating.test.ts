import type {Socket} from 'dgram';
import {describe, expect, it, vi} from 'vitest';

import {EventEmitter} from 'events';

import {PROLINK_HEADER} from 'src/constants';

import StatusEmitter from './index';

/**
 * The Stagehand 0x39 mixer-state parser is reverse-engineered from a DJM-A9.
 * It must only run when the network was brought online in Stagehand mode; in
 * 'active' (and passive) mode it would misread other mixers' faders (e.g. the
 * XDJ-AZ, NP3-327). These tests pin the gating so it can't silently re-leak.
 */

/** A well-formed 0x39 mixer-state packet (266 bytes, header + type byte). */
function makeMixerStatePacket(): Buffer {
  const packet = Buffer.alloc(266);
  Buffer.from(PROLINK_HEADER).copy(packet, 0);
  packet[10] = 0x39;
  return packet;
}

function fakeSocket(): {socket: Socket; send: (msg: Buffer) => void} {
  const ee = new EventEmitter();
  return {
    socket: ee as unknown as Socket,
    send: (msg: Buffer) => ee.emit('message', msg),
  };
}

describe('StatusEmitter Stagehand gating', () => {
  it('does NOT emit mixerState for a 0x39 packet in active mode (default)', () => {
    const {socket, send} = fakeSocket();
    const emitter = new StatusEmitter(socket); // default: stagehandMode = false
    const onMixerState = vi.fn();
    emitter.on('mixerState', onMixerState);

    send(makeMixerStatePacket());

    expect(onMixerState).not.toHaveBeenCalled();
  });

  it('emits mixerState for a 0x39 packet in Stagehand mode', () => {
    const {socket, send} = fakeSocket();
    const emitter = new StatusEmitter(socket, true); // stagehandMode = true
    const onMixerState = vi.fn();
    emitter.on('mixerState', onMixerState);

    send(makeMixerStatePacket());

    expect(onMixerState).toHaveBeenCalledTimes(1);
  });
});
