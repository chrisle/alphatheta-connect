import {Socket} from 'dgram';
import {EventEmitter} from 'events';

import {BEAT_PORT, PROLINK_HEADER, STATUS_PORT} from 'src/constants';
import Control from 'src/control';
import {
  makeStagehandConnectPacket,
  makeStagehandPrefWritePacket,
  makeStagehandTransportPacket,
  StagehandKey,
} from 'src/control/stagehand';
import type StatusEmitter from 'src/status';
import {CDJStatus, Device, DeviceType} from 'src/types';
import {decodeStagehandNumber} from 'src/virtualcdj/stagehand';

describe('Stagehand Control', () => {
  // The iPad's own MAC is not known, only that the last three bytes of it sum
  // to 0x36 (mod 128) in every capture below. These sum to 54, 0x36.
  const hostDevice: Device = {
    id: 0x3a,
    name: 'Stagehand',
    type: DeviceType.Stagehand,
    ip: {address: '192.168.1.130'} as any,
    macAddr: new Uint8Array([0xc8, 0x3d, 0xfc, 0x10, 0x12, 0x14]),
  };

  const cdjDevice: Device = {
    id: 1,
    name: 'CDJ-3000',
    type: DeviceType.CDJ,
    ip: {address: '192.168.1.35'} as any,
    macAddr: new Uint8Array([0x00, 0x11, 0x22, 0x33, 0x44, 0x55]),
  };

  describe('makeStagehandTransportPacket', () => {
    // The iPad app's PLAY pair to a CDJ-3000, as captured 2026-05-23
    // (stagehand-allproto-20260523T142615.pcap): 0x0f then 0x14, both
    // pressed. Byte 33 is the app's device number, 0x3a, behind a checksum
    // that changes with every packet.
    const CAPTURED_PLAY_0F =
      '5173707431576d4a4f4c07537461676568616e6400000000000000000000030100f700300000003a0001000f00010000';
    const CAPTURED_PLAY_14 =
      '5173707431576d4a4f4c07537461676568616e6400000000000000000000030100e800300000003a0001001400010000';
    // Seek forward released.
    const CAPTURED_SEEK_FORWARD_RELEASE =
      '5173707431576d4a4f4c07537461676568616e6400000000000000000000030100ed00300000003a0001001a00000000';

    it("is the iPad app's packet byte for byte", () => {
      expect(
        Buffer.from(makeStagehandTransportPacket(hostDevice, 0x0f, true)).toString('hex')
      ).toBe(CAPTURED_PLAY_0F);
      expect(
        Buffer.from(makeStagehandTransportPacket(hostDevice, 0x14, true)).toString('hex')
      ).toBe(CAPTURED_PLAY_14);
      expect(
        Buffer.from(makeStagehandTransportPacket(hostDevice, 0x1a, false)).toString('hex')
      ).toBe(CAPTURED_SEEK_FORWARD_RELEASE);
    });

    it('carries the sender number 0x3a behind the checksum in every capture', () => {
      for (const hex of [
        CAPTURED_PLAY_0F,
        CAPTURED_PLAY_14,
        CAPTURED_SEEK_FORWARD_RELEASE,
      ]) {
        const packet = Buffer.from(hex, 'hex');
        expect(packet[33] & 0x80).toBe(0x80);
        expect(decodeStagehandNumber(packet, 33, hostDevice.macAddr)).toBe(0x3a);
      }
    });

    // Built the same way by an independent implementation (the formula, in
    // Python), from the MAC above.
    it('is the play key pressed and released, then connect and disconnect', () => {
      expect(
        Buffer.from(makeStagehandTransportPacket(hostDevice, 0x14, false)).toString('hex')
      ).toBe(
        '5173707431576d4a4f4c07537461676568616e6400000000000000000000030100eb00300000003a0001001400000000'
      );
      expect(Buffer.from(makeStagehandConnectPacket(hostDevice)).toString('hex')).toBe(
        '5173707431576d4a4f4c07537461676568616e64000000000000000000000301008d002a0001003a0000'
      );
      expect(
        Buffer.from(makeStagehandConnectPacket(hostDevice, false)).toString('hex')
      ).toBe(
        '5173707431576d4a4f4c07537461676568616e640000000000000000000003010082002a0002003a0000'
      );
    });

    it('builds the body from command, device number and key list', () => {
      const connect = makeStagehandConnectPacket(hostDevice);
      expect(connect.length).toBe(42);
      expect(Buffer.from(connect).readUInt16BE(34)).toBe(42);
      expect(Buffer.from(connect).readUInt16BE(36)).toBe(1); // connect
      expect(Buffer.from(connect).readUInt16BE(38)).toBe(0x3a);
      expect(Buffer.from(connect).readUInt16BE(40)).toBe(0); // no keys

      const key = Buffer.from(makeStagehandTransportPacket(hostDevice, 0x1b, true));
      expect(key.readUInt16BE(34)).toBe(48);
      expect(key.readUInt16BE(36)).toBe(0); // key events
      expect(key.readUInt16BE(40)).toBe(1);
      expect(key.readUInt16BE(42)).toBe(StagehandKey.SeekBackward);
      expect(key[44]).toBe(0);
      expect(key[45]).toBe(1);
    });

    it('should build a 48-byte 0x07 transport packet', () => {
      const packet = makeStagehandTransportPacket(hostDevice, 0x0f, true);

      expect(packet).toBeInstanceOf(Uint8Array);
      expect(packet.length).toBe(48);
      expect(Buffer.from(packet.slice(0, 10))).toEqual(Buffer.from(PROLINK_HEADER));
      expect(packet[10]).toBe(0x07);

      // 19-byte name field, then the unicast header
      expect(packet[11]).toBe(83); // 'S'
      expect(packet[19]).toBe(100); // 'd'
      expect(packet[20]).toBe(0);
      expect(packet[30]).toBe(0x03);
      expect(packet[31]).toBe(0x01);
      expect(packet[32]).toBe(0x00);

      expect(decodeStagehandNumber(packet, 33, hostDevice.macAddr)).toBe(0x3a);
      expect(packet[34]).toBe(0x00);
      expect(packet[35]).toBe(0x30);
      expect(packet[39]).toBe(0x3a);
      expect(packet[41]).toBe(0x01);
      expect(packet[43]).toBe(0x0f);
      expect(packet[45]).toBe(0x01);
    });

    it('should support press=false as release flag', () => {
      const packet = makeStagehandTransportPacket(hostDevice, 0x1a, false);
      expect(packet[45]).toBe(0x00);
    });
  });

  describe('makeStagehandPrefWritePacket', () => {
    // The iPad app switching on-air display ON, same capture.
    const CAPTURED_ON_AIR_ON =
      '5173707431576d4a4f4c6b537461676568616e64000000000000000000000301003a00500100000000000000810000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000';

    it("is the iPad app's packet byte for byte", () => {
      expect(
        Buffer.from(makeStagehandPrefWritePacket(hostDevice, {onAir: 'on'})).toString(
          'hex'
        )
      ).toBe(CAPTURED_ON_AIR_ON);
    });

    it('should build a 116-byte 0x6b preference write packet', () => {
      const packet = makeStagehandPrefWritePacket(hostDevice, {
        onAir: 'on',
        quantize: 2,
      });

      expect(packet).toBeInstanceOf(Uint8Array);
      expect(packet.length).toBe(116);
      expect(Buffer.from(packet.slice(0, 10))).toEqual(Buffer.from(PROLINK_HEADER));
      expect(packet[10]).toBe(0x6b);
      expect(packet[11]).toBe(83); // 'S'
      expect(packet[30]).toBe(0x03);
      expect(packet[31]).toBe(0x01);
      expect(packet[32]).toBe(0x00);
      expect(packet[33]).toBe(0x3a);
      expect(packet[34]).toBe(0x00);
      expect(packet[35]).toBe(0x50);
      expect(packet[36]).toBe(0x01);
      expect(packet[44]).toBe(0x81); // onAir ON
      expect(packet[60]).toBe(0x82); // quantize index 2 (0x80 | 2)
    });

    it('should set onAir=off to 0x80', () => {
      const packet = makeStagehandPrefWritePacket(hostDevice, {onAir: 'off'});
      expect(packet[44]).toBe(0x80);
    });
  });

  describe('Control Class Integration', () => {
    let mockSocket: Socket;
    let statusEmitter: EventEmitter;
    let control: Control;

    const sent = () =>
      (mockSocket.send as jest.Mock).mock.calls.map(call => ({
        packet: Buffer.from(call[0] as Uint8Array),
        port: call[1] as number,
        address: call[2] as string,
      }));
    /** The command word and key of each type 0x07 packet sent so far. */
    const keys = () =>
      sent()
        .filter(s => s.packet[10] === 0x07)
        .map(s => ({
          command: s.packet.readUInt16BE(36),
          key: s.packet.length > 42 ? s.packet.readUInt16BE(42) : null,
          press: s.packet.length > 42 ? s.packet[45] === 1 : null,
        }));
    const report = (playState: CDJStatus.PlayState, deviceId = cdjDevice.id) =>
      statusEmitter.emit('status', {deviceId, playState});

    beforeEach(() => {
      mockSocket = {
        send: jest.fn((...args: any[]) => {
          const cb = args[args.length - 1];
          if (typeof cb === 'function') {
            cb(null, 100);
          }
        }),
      } as any as Socket;
      statusEmitter = new EventEmitter();
      control = new Control(
        mockSocket,
        hostDevice,
        null,
        statusEmitter as unknown as StatusEmitter
      );
    });

    it('connects before the first key to a player, and only then', async () => {
      await control.seekForward(cdjDevice, true);
      await control.seekForward(cdjDevice, false);

      expect(keys()).toEqual([
        {command: 1, key: null, press: null},
        {command: 0, key: 0x1a, press: true},
        {command: 0, key: 0x1a, press: false},
      ]);
      for (const s of sent()) {
        expect(s.port).toBe(BEAT_PORT);
        expect(s.address).toBe('192.168.1.35');
      }
    });

    it('connects to each player it sends keys to', async () => {
      const other = {...cdjDevice, id: 2, ip: {address: '192.168.1.36'} as any};
      await control.transport(cdjDevice, StagehandKey.Sync, true);
      await control.transport(other, StagehandKey.Sync, true);

      expect(sent().map(s => [s.address, s.packet.readUInt16BE(36)])).toEqual([
        ['192.168.1.35', 1],
        ['192.168.1.35', 0],
        ['192.168.1.36', 1],
        ['192.168.1.36', 0],
      ]);
    });

    it('togglePlayPause presses and releases the PLAY/PAUSE key', async () => {
      await control.togglePlayPause(cdjDevice);

      expect(keys()).toEqual([
        {command: 1, key: null, press: null},
        {command: 0, key: 0x14, press: true},
        {command: 0, key: 0x14, press: false},
      ]);
    });

    it('play starts a player that is paused, cued or empty', async () => {
      for (const state of [
        CDJStatus.PlayState.Paused,
        CDJStatus.PlayState.Cued,
        CDJStatus.PlayState.Ended,
      ]) {
        (mockSocket.send as jest.Mock).mockClear();
        report(state);
        await control.play(cdjDevice);
        expect(keys().filter(k => k.key === 0x14 && k.press)).toHaveLength(1);
      }
    });

    it('play leaves a player that is playing or looping alone', async () => {
      report(CDJStatus.PlayState.Playing);
      await control.play(cdjDevice);
      report(CDJStatus.PlayState.Looping);
      await control.play(cdjDevice);

      expect(mockSocket.send).not.toHaveBeenCalled();
    });

    it('pause stops a player that is playing and leaves one that is not', async () => {
      report(CDJStatus.PlayState.Paused);
      await control.pause(cdjDevice);
      expect(mockSocket.send).not.toHaveBeenCalled();

      report(CDJStatus.PlayState.Playing);
      await control.pause(cdjDevice);
      expect(keys().filter(k => k.key === 0x14 && k.press)).toHaveLength(1);
    });

    it('goes by the latest status, and by the right player', async () => {
      report(CDJStatus.PlayState.Playing, 2);
      report(CDJStatus.PlayState.Paused);
      await control.play(cdjDevice);
      expect(keys().filter(k => k.key === 0x14 && k.press)).toHaveLength(1);

      report(CDJStatus.PlayState.Playing);
      await expect(control.play({...cdjDevice, id: 3})).rejects.toThrow(
        /no status heard/
      );
    });

    it('play and pause refuse when the player has reported no status', async () => {
      await expect(control.play(cdjDevice)).rejects.toThrow(/no status heard/);
      await expect(control.pause(cdjDevice)).rejects.toThrow(/no status heard/);
      expect(mockSocket.send).not.toHaveBeenCalled();
    });

    it('setPlayState should delegate to Stagehand play and pause when host is Stagehand', async () => {
      report(CDJStatus.PlayState.Paused);
      await control.setPlayState(cdjDevice, CDJStatus.PlayState.Playing);
      expect(keys().filter(k => k.key === 0x14 && k.press)).toHaveLength(1);

      report(CDJStatus.PlayState.Playing);
      await control.setPlayState(cdjDevice, CDJStatus.PlayState.Cued);
      expect(keys().filter(k => k.key === 0x14 && k.press)).toHaveLength(2);
    });

    it('setPlayState should send standard active packet when host is CDJ', async () => {
      const regularHostDevice: Device = {
        id: 7,
        name: 'ProLink-Connect',
        type: DeviceType.CDJ,
        ip: {address: '192.168.1.50'} as any,
        macAddr: new Uint8Array([0x00, 0x11, 0x22, 0x33, 0x44, 0x55]),
      };

      const control = new Control(mockSocket, regularHostDevice);

      await control.setPlayState(cdjDevice, CDJStatus.PlayState.Playing);

      // Should have sent exactly 1 packet
      expect(mockSocket.send).toHaveBeenCalledTimes(1);

      const call = (mockSocket.send as jest.Mock).mock.calls[0];
      expect(call[1]).toBe(BEAT_PORT);
      expect(call[2]).toBe('192.168.1.35');
    });

    it('should expose seek, skip and setPreference on Control', async () => {
      await control.seekForward(cdjDevice, true);
      await control.seekBackward(cdjDevice, false);
      await control.skip(cdjDevice, true);
      await control.setPreference(cdjDevice, {onAir: 'on'});

      // connect, then 3 keys and the preference write
      expect(mockSocket.send).toHaveBeenCalledTimes(5);

      // Last call is setPreference on STATUS_PORT
      const lastCall = (mockSocket.send as jest.Mock).mock.calls[4];
      expect(lastCall[1]).toBe(STATUS_PORT);
      expect(lastCall[2]).toBe('192.168.1.35');
    });

    it('disconnect lets go of the players it connected to and stops listening', async () => {
      await control.transport(cdjDevice, StagehandKey.Sync, true);
      (mockSocket.send as jest.Mock).mockClear();

      await control.disconnect();
      expect(keys()).toEqual([{command: 2, key: null, press: null}]);
      expect(statusEmitter.listenerCount('status')).toBe(0);

      // nothing left to let go of
      await control.disconnect();
      expect(keys()).toHaveLength(1);
    });

    it('connect again after a disconnect', async () => {
      await control.transport(cdjDevice, StagehandKey.Sync, true);
      await control.disconnect();
      await control.transport(cdjDevice, StagehandKey.Sync, true);

      expect(keys().map(k => k.command)).toEqual([1, 0, 2, 1, 0]);
    });
  });
});
