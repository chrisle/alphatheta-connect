import {Socket} from 'dgram';

import {PROLINK_HEADER} from 'src/constants';
import DeviceManager from 'src/devices';
import {Device, DeviceType} from 'src/types';
import {Announcer, getVirtualCDJ} from 'src/virtualcdj';

/**
 * Regression coverage for NP3-356: a virtual CDJ that keeps a contested player
 * number knocks the real player holding it off the network mid-set.
 */
describe('Announcer device ID conflicts', () => {
  const mockIface = {
    address: '192.168.1.100',
    mac: '00:11:22:33:44:55',
    family: 'IPv4' as const,
    netmask: '255.255.255.0',
    internal: false,
    cidr: '192.168.1.100/24',
    scopeid: undefined,
  };

  /**
   * Build the 0x08 packet a device sends to defend a player number it owns.
   */
  const makeConflictPacket = (defendedId: number) => {
    const packet = Buffer.alloc(0x29);
    packet.set(Buffer.from(PROLINK_HEADER), 0);
    packet[0x0a] = 0x08;
    packet[0x24] = defendedId;
    return packet;
  };

  /** A peer as [device id, model name]; names are matched to channel counts. */
  type Peer = number | [number, string];

  const setup = (vcdjId: number, peers: Peer[], fullStartup = true) => {
    let messageHandler: ((msg: Buffer) => void) | undefined;

    const mockSocket = {
      send: jest.fn(),
      on: jest.fn((event: string, handler: (msg: Buffer) => void) => {
        if (event === 'message') {
          messageHandler = handler;
        }
      }),
      off: jest.fn(),
    } as unknown as Socket;

    const devices = new Map<number, Device>(
      peers.map(peer => {
        const [id, name] = Array.isArray(peer) ? peer : [peer, `CDJ-${peer}`];
        const device = getVirtualCDJ(mockIface, id, name);
        // Mixers announce as their own device type, which is what tells the
        // announcer how many player numbers the rig can hand out.
        if (name.startsWith('DJM') || name === 'EUPHONIA') {
          device.type = DeviceType.Mixer;
        }
        return [id, device];
      })
    );
    const mockDeviceManager = {devices} as unknown as DeviceManager;

    const vcdj = getVirtualCDJ(mockIface, vcdjId);
    const announcer = new Announcer(
      vcdj,
      mockSocket,
      mockDeviceManager,
      mockIface,
      fullStartup
    );

    return {
      announcer,
      vcdj,
      mockSocket,
      sendConflict: (id: number) => messageHandler?.(makeConflictPacket(id)),
    };
  };

  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('moves off a contested ID during startup', () => {
    const {announcer, vcdj, sendConflict} = setup(5, [1, 2, 5]);

    announcer.start();
    sendConflict(5);
    announcer.stop();

    expect(vcdj.id).not.toBe(5);
  });

  it('stays in the 1-6 range so remotedb queries keep working', () => {
    // Player 5 is contested and 1, 2 are live — 6 is the only free player
    // number, and dropping to 7+ would silently lose streaming-track metadata.
    const {announcer, vcdj, sendConflict} = setup(5, [1, 2, 5]);

    announcer.start();
    sendConflict(5);
    announcer.stop();

    expect(vcdj.id).toBe(6);
  });

  it('keeps the same device object so remotedb and control follow the new ID', () => {
    // remotedb, localdb and control are handed this exact object when the
    // network connects; replacing it would leave us announcing as one ID and
    // querying as another.
    const {announcer, vcdj, sendConflict} = setup(5, [5]);

    announcer.start();
    const before = vcdj;
    sendConflict(5);
    announcer.stop();

    expect(vcdj).toBe(before);
    expect(vcdj.id).toBe(6);
  });

  it('answers a conflict raised after startup has finished', () => {
    // The listener used to be torn down when keep-alive began ~4s in, so a
    // player powering on later fought us for the slot forever.
    const {announcer, vcdj, mockSocket, sendConflict} = setup(5, [1, 2]);

    announcer.start();

    // Run out the startup stages (4 stages x 3 packets @ 300ms) into keep-alive
    jest.advanceTimersByTime(5000);
    expect(mockSocket.off).not.toHaveBeenCalled();

    sendConflict(5);
    announcer.stop();

    expect(vcdj.id).toBe(6);
  });

  it('ignores a conflict defending another device ID', () => {
    const {announcer, vcdj, sendConflict} = setup(5, [1, 2]);

    announcer.start();
    sendConflict(2);
    announcer.stop();

    expect(vcdj.id).toBe(5);
  });

  it('keeps announcing after moving to the new ID', () => {
    const {announcer, vcdj, mockSocket, sendConflict} = setup(5, [1, 5]);

    announcer.start();
    sendConflict(5);

    // Run the restarted startup sequence out into keep-alive, then look only
    // at the keep-alive packets, which carry the device ID at byte 0x24.
    jest.advanceTimersByTime(5000);
    (mockSocket.send as jest.Mock).mockClear();
    jest.advanceTimersByTime(3000);
    announcer.stop();

    expect(mockSocket.send).toHaveBeenCalled();
    const announcedIds = (mockSocket.send as jest.Mock).mock.calls.map(
      ([packet]: [Uint8Array]) => packet[0x24]
    );
    expect(new Set(announcedIds)).toEqual(new Set([vcdj.id]));
  });

  it('stops announcing when every ID is occupied', () => {
    const allIds = Array.from({length: 32}, (_, i) => i + 1);
    const {announcer, mockSocket, sendConflict} = setup(5, allIds);

    announcer.start();
    sendConflict(5);
    (mockSocket.send as jest.Mock).mockClear();

    jest.advanceTimersByTime(5000);

    expect(mockSocket.send).not.toHaveBeenCalled();
  });

  it('detaches the conflict listener on stop', () => {
    const {announcer, mockSocket} = setup(5, [1]);

    announcer.start();
    announcer.stop();

    expect(mockSocket.off).toHaveBeenCalledWith('message', expect.any(Function));
  });

  it('moves above the mixer, not just to the next free number', () => {
    // A DJM-V10 can assign every number 1-6, so 6 sitting free is not ours to
    // take — the player on channel 6 would arrive and contest it too.
    const {announcer, vcdj, sendConflict} = setup(5, [1, 2, 5, [33, 'DJM-V10']]);

    announcer.start();
    sendConflict(5);
    announcer.stop();

    expect(vcdj.id).toBe(7);
  });

  it('stays in the remotedb range when the mixer leaves room', () => {
    const {announcer, vcdj, sendConflict} = setup(5, [1, 2, 5, [33, 'DJM-A9']]);

    announcer.start();
    sendConflict(5);
    announcer.stop();

    expect(vcdj.id).toBe(6);
  });

  it('watches for conflicts even without the full startup protocol', () => {
    const {announcer, vcdj, sendConflict} = setup(5, [1, 5], false);

    announcer.start();
    sendConflict(5);
    announcer.stop();

    expect(vcdj.id).toBe(6);
  });
});
