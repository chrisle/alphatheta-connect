import type {Socket} from 'dgram';

import {EventEmitter} from 'events';

import DeviceManager from 'src/devices';
import {ProlinkNetwork} from 'src/network';
import StatusEmitter from 'src/status';
import PositionEmitter from 'src/status/position';
import {
  decodeStagehandNumber,
  getStagehandMac,
  STAGEHAND_STARTUP_INTERVAL,
} from 'src/virtualcdj/stagehand';

// The database services drag in the kaitai-compiled PDB parser, which has no
// jest build; connect() only constructs them, so stand-ins are enough here.
jest.mock('src/db', () => ({__esModule: true, default: class Database {}}));
jest.mock('src/localdb', () => ({__esModule: true, default: class LocalDatabase {}}));
jest.mock('src/remotedb', () => ({__esModule: true, default: class RemoteDatabase {}}));

/**
 * A CDJ-3000 keeps one record per peer IP and ignores a later claim from that
 * IP under a different MAC or device number, so a disconnect/connect cycle
 * must re-present the identity it first announced. These tests pin that the
 * Stagehand identity is derived from the interface and survives reconnects.
 */

const iface = {
  address: '192.168.1.100',
  netmask: '255.255.255.0',
  family: 'IPv4' as const,
  mac: '00:11:22:33:44:55',
  internal: false,
  cidr: '192.168.1.100/24',
};

function fakeSocket() {
  const ee = new EventEmitter() as EventEmitter & {
    send: jest.Mock;
    close: jest.Mock;
  };
  ee.send = jest.fn((...args: unknown[]) => {
    const callback = args[args.length - 1];
    if (typeof callback === 'function') {
      callback(null, 0);
    }
  });
  ee.close = jest.fn((cb?: () => void) => {
    cb?.();
    ee.emit('close');
  });
  return ee;
}

function makeNetwork(vcdjId?: number) {
  const announceSocket = fakeSocket();
  const beatSocket = fakeSocket();
  const statusSocket = fakeSocket();
  const network = new ProlinkNetwork({
    config: {iface, connectMethod: 'stagehand', vcdjId},
    announceSocket: announceSocket as unknown as Socket,
    beatSocket: beatSocket as unknown as Socket,
    statusSocket: statusSocket as unknown as Socket,
    deviceManager: new DeviceManager(announceSocket as unknown as Socket),
    statusEmitter: new StatusEmitter(statusSocket as unknown as Socket, true),
    positionEmitter: new PositionEmitter(beatSocket as unknown as Socket, true),
  });
  return {network, announceSocket, beatSocket};
}

/** Announce-socket packets of one type, as sent so far. */
const sentOfType = (socket: ReturnType<typeof fakeSocket>, type: number) =>
  socket.send.mock.calls
    .map(([packet]) => packet as Uint8Array)
    .filter(packet => packet[10] === type);

describe('Stagehand identity across reconnects', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('claims with a MAC derived from the interface, not a random one', () => {
    const {network, announceSocket} = makeNetwork();
    network.connect();
    jest.advanceTimersByTime(STAGEHAND_STARTUP_INTERVAL * 4);

    const [claim] = sentOfType(announceSocket, 0x02);
    expect(claim).toBeDefined();
    expect(Array.from(claim.subarray(40, 46))).toEqual(
      Array.from(getStagehandMac(iface))
    );
    network.disconnect();
  });

  it('keeps the same device number and MAC after disconnect/connect', () => {
    const {network, announceSocket} = makeNetwork();

    network.connect();
    jest.advanceTimersByTime(STAGEHAND_STARTUP_INTERVAL * 7);
    const [firstKeepAlive] = sentOfType(announceSocket, 0x06);
    expect(firstKeepAlive).toBeDefined();
    network.disconnect();
    announceSocket.send.mockClear();

    network.connect();
    jest.advanceTimersByTime(STAGEHAND_STARTUP_INTERVAL * 7);
    const [secondKeepAlive] = sentOfType(announceSocket, 0x06);
    expect(secondKeepAlive).toBeDefined();
    network.disconnect();

    // Byte 36 is the device number, 38-43 the protocol-layer MAC.
    expect(secondKeepAlive[36]).toBe(firstKeepAlive[36]);
    expect(Array.from(secondKeepAlive.subarray(38, 44))).toEqual(
      Array.from(firstKeepAlive.subarray(38, 44))
    );
  });

  it('announces as 0x3a, hidden behind the checksum, unless told otherwise', () => {
    const {network, announceSocket} = makeNetwork();
    network.connect();
    jest.advanceTimersByTime(STAGEHAND_STARTUP_INTERVAL * 7);

    const [claim] = sentOfType(announceSocket, 0x02);
    const [keepAlive] = sentOfType(announceSocket, 0x06);
    expect(claim[46]).toBe(0x3a);
    expect(keepAlive[36] & 0x80).toBe(0x80);
    expect(decodeStagehandNumber(keepAlive, 36, getStagehandMac(iface))).toBe(0x3a);
    network.disconnect();
  });

  it('announces a device number from 0x36 to 0x3f that it is given', () => {
    const {network, announceSocket} = makeNetwork(0x37);
    network.connect();
    jest.advanceTimersByTime(STAGEHAND_STARTUP_INTERVAL * 7);

    const [keepAlive] = sentOfType(announceSocket, 0x06);
    expect(decodeStagehandNumber(keepAlive, 36, getStagehandMac(iface))).toBe(0x37);
    network.disconnect();
  });

  it.each([141, 0x35, 0x40, 211])(
    'refuses the device number %i, which no player takes from a Stagehand',
    id => {
      const {network} = makeNetwork(id);
      expect(() => network.connect()).toThrow(/device number must be 54 to 63/);
    }
  );

  it('lets go of the players it sent keys to before its sockets close', async () => {
    const {network, beatSocket} = makeNetwork();
    network.connect();
    const control = network.control!;
    const player = {ip: {address: '192.168.1.35'}} as Parameters<
      typeof control.transport
    >[0];

    await control.transport(player, 0x1a, true);
    beatSocket.send.mockClear();
    network.disconnect();
    await network.close();

    const sent = beatSocket.send.mock.calls.map(([packet]) => packet as Uint8Array);
    expect(sent).toHaveLength(1);
    expect(sent[0][10]).toBe(0x07);
    expect(Buffer.from(sent[0]).readUInt16BE(36)).toBe(2); // disconnect
    expect(beatSocket.close).toHaveBeenCalled();
  });
});
