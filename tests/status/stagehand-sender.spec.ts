import type {Socket} from 'dgram';
import * as ip from 'ip-address';
import {mockDevice, readMock} from 'tests/utils';

import {EventEmitter} from 'events';

import {PROLINK_HEADER} from 'src/constants';
import DeviceManager from 'src/devices';
import StatusEmitter from 'src/status';
import PositionEmitter from 'src/status/position';
import {CDJStatus} from 'src/types';
import {encodeStagehandNumber, restoreSenderNumber} from 'src/virtualcdj/stagehand';

/**
 * A player sends a Stagehand its own number in byte 33 hidden behind a
 * checksum of the packet and the MAC it announced (seen on CDJ-3000 firmware
 * 3.22: a player's 0x0b stream arrives with byte 33 cycling through values
 * like 0xf4, 0x84 and 0x90, which decode to its number with its own MAC).
 * The parsers read the number from there.
 */
describe('a player sender number hidden in byte 33', () => {
  const player = mockDevice({
    id: 3,
    ip: new ip.Address4('192.168.1.35'),
    macAddr: Uint8Array.of(0x00, 0x11, 0x22, 0x33, 0x44, 0x55),
  });
  const otherPlayer = mockDevice({
    id: 4,
    ip: new ip.Address4('192.168.1.36'),
    macAddr: Uint8Array.of(0xc8, 0x3d, 0xfc, 0x10, 0x20, 0x30),
  });
  const devices = new Map([
    [player.id, player],
    [otherPlayer.id, otherPlayer],
  ]);

  const hidden = (packet: Buffer, from = player) => {
    const copy = Buffer.from(packet);
    encodeStagehandNumber(copy, 33, from.id, from.macAddr);
    return copy;
  };

  const positionPacket = () => {
    const packet = Buffer.alloc(0x3c);
    packet.set(PROLINK_HEADER, 0);
    packet[10] = 0x0b;
    packet[0x20] = 0x00;
    packet[0x21] = 0x03;
    packet.writeUInt16BE(0x0038, 0x22);
    packet.writeUInt32BE(180, 0x24);
    packet.writeUInt32BE(45500, 0x28);
    packet.writeUInt32BE(1202, 0x30);
    return packet;
  };

  describe('restoreSenderNumber', () => {
    it('puts back the number the sender hid, using the sender MAC', async () => {
      const packet = hidden(await readMock('status-simple.dat'));
      expect(packet[33] & 0x80).toBe(0x80);

      const restored = restoreSenderNumber(packet, '192.168.1.35', devices);
      expect(restored[33]).toBe(3);
      expect(restored.subarray(0, 33)).toEqual(packet.subarray(0, 33));
      expect(restored.subarray(34)).toEqual(packet.subarray(34));
      // the received buffer is left as it came
      expect(packet[33] & 0x80).toBe(0x80);
    });

    it('goes by the address the packet came from', () => {
      const packet = hidden(positionPacket(), otherPlayer);
      expect(restoreSenderNumber(packet, '192.168.1.36', devices)[33]).toBe(4);
    });

    it('leaves a plain number, an unknown sender and a short packet alone', async () => {
      const plain = await readMock('status-simple.dat');
      expect(restoreSenderNumber(plain, '192.168.1.35', devices)).toBe(plain);

      const packet = hidden(positionPacket());
      expect(restoreSenderNumber(packet, '192.168.1.99', devices)).toBe(packet);
      expect(restoreSenderNumber(packet, undefined, devices)).toBe(packet);

      const short = Buffer.from(packet.subarray(0, 20));
      expect(restoreSenderNumber(short, '192.168.1.35', devices)).toBe(short);
    });
  });

  describe('in Stagehand mode', () => {
    function fakeSocket() {
      const ee = new EventEmitter();
      return {
        socket: ee as unknown as Socket,
        send: (msg: Buffer, address: string) => ee.emit('message', msg, {address}),
      };
    }
    const deviceManager = {devices} as unknown as DeviceManager;

    it('reports the right player in a status', async () => {
      const {socket, send} = fakeSocket();
      const statuses: CDJStatus.State[] = [];
      new StatusEmitter(socket, true, deviceManager).on('status', s => statuses.push(s));

      send(hidden(await readMock('status-simple.dat')), '192.168.1.35');

      expect(statuses.map(s => s.deviceId)).toEqual([3]);
    });

    it('reports the right player in a position', () => {
      const {socket, send} = fakeSocket();
      const positions: CDJStatus.PositionState[] = [];
      new PositionEmitter(socket, true, deviceManager).on('position', p =>
        positions.push(p)
      );

      send(hidden(positionPacket(), otherPlayer), '192.168.1.36');
      send(hidden(positionPacket()), '192.168.1.35');

      expect(positions.map(p => p.deviceId)).toEqual([4, 3]);
    });

    it('is not applied outside Stagehand mode', async () => {
      const {socket, send} = fakeSocket();
      const statuses: CDJStatus.State[] = [];
      new StatusEmitter(socket, false, deviceManager).on('status', s => statuses.push(s));

      const packet = hidden(await readMock('status-simple.dat'));
      send(packet, '192.168.1.35');

      expect(statuses.map(s => s.deviceId)).toEqual([packet[33]]);
    });
  });
});
