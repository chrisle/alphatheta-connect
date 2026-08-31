import * as ip from 'ip-address';

import {Socket} from 'dgram';

import DeviceManager from 'src/devices';
import {Device, DeviceType} from 'src/types';
import {
  makeAnnouncePacket,
  pickAvailableDeviceId,
  playerNumberCeiling,
} from 'src/virtualcdj';

/**
 * The player-number choice keys off `device.name` and `device.type` as they
 * come off the wire. Everything else is unit-tested against hand-built device
 * objects, which cannot catch the table being keyed on a string the parser
 * never produces — null padding, a type byte read from the wrong offset, a
 * model name that arrives differently than it is written down.
 *
 * These tests push real announce packets through the real parser and the real
 * DeviceManager, and only then ask which player number we would take.
 */
describe('player number selection from announce packets', () => {
  // A real DeviceManager arms a 10s disconnect timer per device; without fake
  // timers those keep the jest process alive after the run.
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  const announcePacketFor = (id: number, name: string, type: DeviceType): Buffer => {
    const device: Device = {
      id,
      name,
      type,
      ip: new ip.Address4('192.168.1.10'),
      macAddr: new Uint8Array([0x00, 0x11, 0x22, 0x33, 0x44, 0x55]),
    };
    return Buffer.from(makeAnnouncePacket(device));
  };

  /**
   * A DeviceManager fed by the packets a rig would broadcast, exactly as
   * bringOnline() wires it to the announce socket.
   */
  const rigOnTheNetwork = (peers: Array<[number, string, DeviceType]>) => {
    let handleAnnounce: ((msg: Buffer) => void) | undefined;
    const socket = {
      on: (event: string, handler: (msg: Buffer) => void) => {
        if (event === 'message') {
          handleAnnounce = handler;
        }
      },
    } as unknown as Socket;

    const deviceManager = new DeviceManager(socket);
    for (const [id, name, type] of peers) {
      handleAnnounce!(announcePacketFor(id, name, type));
    }

    return deviceManager;
  };

  const chosenPlayerNumber = (deviceManager: DeviceManager) => {
    const devices = [...deviceManager.devices.values()];
    return pickAvailableDeviceId(
      devices.map(d => d.id),
      {preferPlayerRange: true, playerCeiling: playerNumberCeiling(devices)}
    );
  };

  it('reads a model name back off the wire without padding', () => {
    const deviceManager = rigOnTheNetwork([[33, 'DJM-V10', DeviceType.Mixer]]);

    const mixer = deviceManager.devices.get(33)!;
    // buildName pads to 20 bytes; if that padding survived, no table lookup
    // would ever match.
    expect(mixer.name).toBe('DJM-V10');
    expect(mixer.type).toBe(DeviceType.Mixer);
  });

  it('takes player 5 on a real DJM-A9 rig', () => {
    const deviceManager = rigOnTheNetwork([
      [1, 'CDJ-3000', DeviceType.CDJ],
      [2, 'CDJ-3000', DeviceType.CDJ],
      [33, 'DJM-A9', DeviceType.Mixer],
    ]);

    expect(playerNumberCeiling([...deviceManager.devices.values()])).toBe(4);
    expect(chosenPlayerNumber(deviceManager)).toBe(5);
  });

  it('takes player 7 on a real DJM-V10 rig', () => {
    const deviceManager = rigOnTheNetwork([
      [1, 'CDJ-3000', DeviceType.CDJ],
      [2, 'CDJ-3000', DeviceType.CDJ],
      [33, 'DJM-V10', DeviceType.Mixer],
    ]);

    expect(chosenPlayerNumber(deviceManager)).toBe(7);
  });

  it('takes player 4 on a real DJM-V5 rig', () => {
    const deviceManager = rigOnTheNetwork([
      [1, 'CDJ-3000', DeviceType.CDJ],
      [33, 'DJM-V5', DeviceType.Mixer],
    ]);

    expect(chosenPlayerNumber(deviceManager)).toBe(4);
  });

  it('never lands on a player number a CDJ announced', () => {
    // The reported rig: a second CDJ-3000 sitting on player 5, which is what
    // the old hardcoded choice collided with.
    const deviceManager = rigOnTheNetwork([
      [1, 'CDJ-3000', DeviceType.CDJ],
      [5, 'CDJ-3000', DeviceType.CDJ],
      [33, 'DJM-A9', DeviceType.Mixer],
    ]);

    const chosen = chosenPlayerNumber(deviceManager);

    expect(chosen).toBe(6);
    expect(deviceManager.devices.has(chosen!)).toBe(false);
  });

  it('falls back to the 1-6 sweep when the rig has no mixer', () => {
    const deviceManager = rigOnTheNetwork([
      [1, 'CDJ-3000', DeviceType.CDJ],
      [2, 'CDJ-3000', DeviceType.CDJ],
    ]);

    expect(playerNumberCeiling([...deviceManager.devices.values()])).toBeUndefined();
    expect(chosenPlayerNumber(deviceManager)).toBe(6);
  });

  it('reads the mixer even when it announces after the players', () => {
    // Discovery order is whatever the network delivers; the DJM is usually
    // not first, which is why the choice waits for discovery to settle.
    const deviceManager = rigOnTheNetwork([
      [1, 'CDJ-3000', DeviceType.CDJ],
      [2, 'CDJ-3000', DeviceType.CDJ],
      [3, 'CDJ-3000', DeviceType.CDJ],
      [33, 'DJM-V10', DeviceType.Mixer],
    ]);

    expect(chosenPlayerNumber(deviceManager)).toBe(7);
  });

  it('would have taken a live player number before the fix', () => {
    // Pins the regression itself: the old code used a constant 5 regardless
    // of what was on the network.
    const deviceManager = rigOnTheNetwork([
      [1, 'CDJ-3000', DeviceType.CDJ],
      [5, 'CDJ-3000', DeviceType.CDJ],
      [33, 'DJM-A9', DeviceType.Mixer],
    ]);

    const hardcodedOldChoice = 5;
    expect(deviceManager.devices.has(hardcodedOldChoice)).toBe(true);
    expect(chosenPlayerNumber(deviceManager)).not.toBe(hardcodedOldChoice);
  });
});
