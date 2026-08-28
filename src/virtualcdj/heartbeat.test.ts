import type {Socket} from 'dgram';
import {Address4} from 'ip-address';
import {beforeEach, describe, expect, it, vi} from 'vitest';

import {EventEmitter} from 'events';

import {STATUS_PORT} from 'src/constants';
import DeviceManager from 'src/devices';
import {Device, DeviceType} from 'src/types';

import {
  makeStagehandMixerHeartbeat,
  makeStagehandPlayerHeartbeat,
  StagehandHeartbeat,
} from './heartbeat';

/**
 * Byte-for-byte fixtures captured from the real iOS Stagehand app (device name
 * "Stagehand"). These are the exact payloads it unicasts at ~4 Hz — the mixer
 * frame to a DJM-A9, the player frame to a CDJ-3000 — from Phase 4/5 pcaps
 * (§4.14.2 and the 0x68 keep-alive decode).
 */
const REAL_MIXER_HEARTBEAT = Buffer.from(
  '5173707431576d4a4f4c' + // magic Qspt1WmJOL
    '3a' + // type 0x3a
    '537461676568616e6400000000000000000000' + // "Stagehand" + NUL pad (19 bytes)
    '210200fe0004001c0000', // trailer
  'hex'
);

const REAL_PLAYER_HEARTBEAT = Buffer.from(
  '5173707431576d4a4f4c' + // magic Qspt1WmJOL
    '68' + // type 0x68
    '537461676568616e6400000000000000000000' + // "Stagehand" + NUL pad (19 bytes)
    '030100' + // 0x03 persona, 0x01 subkind, 0x00 flag
    '3a0000', // 0x3a model-code stamp + 2 reserved
  'hex'
);

function makeDevice(overrides: Partial<Device> = {}): Device {
  return {
    id: 1,
    name: 'CDJ-3000',
    type: DeviceType.CDJ,
    macAddr: new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05]),
    ip: new Address4('192.168.1.35'),
    ...overrides,
  };
}

function stagehandVcdj(): Device {
  return makeDevice({
    id: 200,
    name: 'Stagehand',
    type: DeviceType.Stagehand,
    ip: new Address4('192.168.1.130'),
  });
}

describe('Stagehand heartbeat packets', () => {
  it('mixer heartbeat matches the real iOS Stagehand 0x3a frame byte-for-byte', () => {
    const packet = makeStagehandMixerHeartbeat(stagehandVcdj());
    expect(packet.length).toBe(40);
    expect(Buffer.from(packet).equals(REAL_MIXER_HEARTBEAT)).toBe(true);
  });

  it('player heartbeat matches the real iOS Stagehand 0x68 frame byte-for-byte', () => {
    const packet = makeStagehandPlayerHeartbeat(stagehandVcdj());
    expect(packet.length).toBe(36);
    expect(Buffer.from(packet).equals(REAL_PLAYER_HEARTBEAT)).toBe(true);
  });

  it('substitutes the configured device name into the 19-byte name field', () => {
    const packet = makeStagehandMixerHeartbeat(
      stagehandVcdj() // name "Stagehand"
    );
    // Name occupies offsets 11..29; ASCII "Stagehand" then NUL padding.
    expect(Buffer.from(packet.subarray(11, 20)).toString('ascii')).toBe('Stagehand');
    expect(Array.from(packet.subarray(20, 30))).toEqual(Array(10).fill(0));
  });

  it('truncates an over-long name to the 19-byte field without overrunning', () => {
    const packet = makeStagehandMixerHeartbeat(
      stagehandVcdj() // replaced below
    );
    const longName = makeStagehandMixerHeartbeat({
      ...stagehandVcdj(),
      name: 'A'.repeat(40),
    });
    expect(longName.length).toBe(40);
    // Trailer still lands at offset 30.
    expect(Array.from(longName.subarray(30))).toEqual([
      0x21, 0x02, 0x00, 0xfe, 0x00, 0x04, 0x00, 0x1c, 0x00, 0x00,
    ]);
    void packet;
  });
});

describe('StagehandHeartbeat', () => {
  let socket: Socket;
  let sends: Array<{msg: Uint8Array; port: number; address: string}>;

  beforeEach(() => {
    sends = [];
    socket = {
      send: (msg: Uint8Array, port: number, address: string, cb?: () => void) => {
        sends.push({msg, port, address});
        cb?.();
      },
    } as unknown as Socket;
  });

  function deviceManagerWith(devices: Device[]): DeviceManager {
    const dm = new DeviceManager(new EventEmitter() as unknown as Socket);
    for (const d of devices) {
      dm.devices.set(d.id, d);
    }
    return dm;
  }

  it('heartbeats the mixer with 0x3a and the CDJ with 0x68 to port 50002', () => {
    const mixer = makeDevice({
      id: 33,
      name: 'DJM-A9',
      type: DeviceType.Mixer,
      ip: new Address4('192.168.1.53'),
    });
    const cdj = makeDevice({
      id: 1,
      name: 'CDJ-3000',
      type: DeviceType.CDJ,
      ip: new Address4('192.168.1.35'),
    });
    const dm = deviceManagerWith([mixer, cdj]);

    const hb = new StagehandHeartbeat(stagehandVcdj(), socket, dm);
    hb.start();
    hb.stop();

    expect(sends).toHaveLength(2);
    const toMixer = sends.find(s => s.address === '192.168.1.53');
    const toCdj = sends.find(s => s.address === '192.168.1.35');
    expect(toMixer?.port).toBe(STATUS_PORT);
    expect(toCdj?.port).toBe(STATUS_PORT);
    expect(toMixer?.msg[10]).toBe(0x3a);
    expect(toCdj?.msg[10]).toBe(0x68);
  });

  it('never heartbeats itself or other Stagehand / rekordbox peers', () => {
    const self = stagehandVcdj(); // id 200
    const otherStagehand = makeDevice({
      id: 201,
      type: DeviceType.Stagehand,
      ip: new Address4('192.168.1.131'),
    });
    const rekordbox = makeDevice({
      id: 17,
      type: DeviceType.Rekordbox,
      ip: new Address4('192.168.1.40'),
    });
    const dm = deviceManagerWith([self, otherStagehand, rekordbox]);

    const hb = new StagehandHeartbeat(self, socket, dm);
    hb.start();
    hb.stop();

    expect(sends).toHaveLength(0);
  });

  it('stops sending after stop()', () => {
    vi.useFakeTimers();
    const cdj = makeDevice();
    const dm = deviceManagerWith([cdj]);
    const hb = new StagehandHeartbeat(stagehandVcdj(), socket, dm);

    hb.start(); // one immediate send
    expect(sends).toHaveLength(1);
    hb.stop();
    vi.advanceTimersByTime(2000);
    expect(sends).toHaveLength(1);
    vi.useRealTimers();
  });
});
