import {readMock} from 'tests/utils';

import {Socket} from 'dgram';
import {EventEmitter} from 'events';

import {PROLINK_HEADER} from 'src/constants';
import DeviceManager from 'src/devices';
import StatusEmitter from 'src/status';
import PositionEmitter from 'src/status/position';

/**
 * The Pro DJ Link ports are ordinary UDP ports, and other software on the
 * network can send anything to them. Each listener below runs inside its
 * socket's 'message' event, so a parser that throws there escapes as an
 * uncaught exception in the host app. Datagrams that are not ours, or that are
 * cut short, must be dropped without throwing and without emitting anything.
 */

jest.useFakeTimers();

/**
 * Datagrams that are not Pro DJ Link packets. The last two are long enough to
 * reach the Stagehand parsers and carry their type bytes at offset 0x0a.
 */
const foreignDatagrams = [
  Buffer.from([]),
  Buffer.from([0xde, 0xad, 0xbe, 0xef]),
  Buffer.from('not a prolink packet'),
  Buffer.from([0x00, ...PROLINK_HEADER, 0x06]),
  Buffer.alloc(0x300, 0x39),
  Buffer.alloc(0x300, 0x58),
];

/**
 * Every prefix of a packet that is shorter than `below` bytes.
 */
function truncations(packet: Buffer, below = packet.length) {
  return Array.from({length: below}, (_, length) => packet.subarray(0, length));
}

function fakeSocket() {
  const socket = new EventEmitter() as Socket;
  const send = (message: Buffer) => socket.emit('message', message);

  return {socket, send};
}

function positionPacket() {
  const packet = Buffer.alloc(0x40);

  PROLINK_HEADER.forEach((byte, i) => (packet[i] = byte));

  packet[0x20] = 0x00;
  packet[0x21] = 0x03;
  packet.writeUInt16BE(0x0038, 0x22);

  return packet;
}

describe('DeviceManager', () => {
  it('ignores datagrams that are not announce packets', async () => {
    const {socket, send} = fakeSocket();
    const dm = new DeviceManager(socket, {deviceTimeout: 100});

    const connected = jest.fn();
    dm.on('connected', connected);

    const announce = await readMock('announce-cdj-2.dat');

    for (const packet of [...foreignDatagrams, ...truncations(announce, 0x30)]) {
      expect(() => send(packet)).not.toThrow();
    }

    expect(connected).not.toHaveBeenCalled();

    // The listener is still attached and still tracks real devices
    send(announce);
    expect(connected).toHaveBeenCalledTimes(1);
  });
});

describe('StatusEmitter', () => {
  it.each([false, true])(
    'ignores datagrams that are not status packets (stagehand: %s)',
    async stagehandMode => {
      const {socket, send} = fakeSocket();
      const emitter = new StatusEmitter(socket, stagehandMode);

      const events = jest.fn();
      emitter.on('status', events);
      emitter.on('mediaSlot', events);
      emitter.on('onAir', events);
      emitter.on('mixerState', events);

      const status = await readMock('status-simple.dat');
      const mediaSlot = await readMock('media-slot-usb.dat');

      const packets = [
        ...foreignDatagrams,
        ...truncations(status, 0xcc),
        ...truncations(mediaSlot),
      ];

      for (const packet of packets) {
        expect(() => send(packet)).not.toThrow();
      }

      expect(events).not.toHaveBeenCalled();

      // The listener is still attached and still reports real status
      send(status);
      expect(events).toHaveBeenCalledTimes(1);
    }
  );
});

describe('PositionEmitter', () => {
  it.each([false, true])(
    'ignores datagrams that are not position packets (stagehand: %s)',
    stagehandMode => {
      const {socket, send} = fakeSocket();
      const emitter = new PositionEmitter(socket, stagehandMode);

      const events = jest.fn();
      emitter.on('position', events);
      emitter.on('vu', events);

      const position = positionPacket();

      for (const packet of [...foreignDatagrams, ...truncations(position, 0x34)]) {
        expect(() => send(packet)).not.toThrow();
      }

      expect(events).not.toHaveBeenCalled();

      // The listener is still attached and still reports real positions
      send(position);
      expect(events).toHaveBeenCalledTimes(1);
    }
  );
});
