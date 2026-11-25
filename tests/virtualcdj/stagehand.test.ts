import {Socket} from 'dgram';

import DeviceManager from 'src/devices';
import {DeviceType} from 'src/types';
import {
  decodeStagehandNumber,
  encodeStagehandNumber,
  getStagehandMac,
  getVirtualStagehand,
  makeStagehand0aPacket,
  makeStagehand02Packet,
  makeStagehand06Packet,
  STAGEHAND_DEVICE_ID,
  STAGEHAND_MAX_DEVICE_ID,
  STAGEHAND_MIN_DEVICE_ID,
  StagehandAnnouncer,
} from 'src/virtualcdj/stagehand';

describe('Stagehand Connection Method', () => {
  const mockIface = {
    address: '192.168.1.100',
    mac: '00:11:22:33:44:55',
    family: 'IPv4' as const,
    netmask: '255.255.255.0',
    internal: false,
    cidr: '192.168.1.100/24',
    scopeid: undefined,
  };

  describe('Utility generators', () => {
    it('should derive an AlphaTheta-OUI MAC from the interface MAC', () => {
      const mac = getStagehandMac(mockIface);
      expect(mac).toBeInstanceOf(Uint8Array);
      expect(Array.from(mac)).toEqual([0xc8, 0x3d, 0xfc, 0x33, 0x44, 0x55]);
    });

    it('should derive the same MAC every time for the same interface', () => {
      expect(getStagehandMac(mockIface)).toEqual(getStagehandMac({...mockIface}));
      expect(getVirtualStagehand(mockIface, 150).macAddr).toEqual(
        getStagehandMac(mockIface)
      );
    });

    it('should default to the device number 0x3a, inside the range players accept', () => {
      expect(STAGEHAND_DEVICE_ID).toBe(0x3a);
      expect(STAGEHAND_MIN_DEVICE_ID).toBe(0x36);
      expect(STAGEHAND_MAX_DEVICE_ID).toBe(0x3f);
      expect(getVirtualStagehand(mockIface).id).toBe(STAGEHAND_DEVICE_ID);
    });

    it('should create a valid Stagehand device', () => {
      const mac = getStagehandMac(mockIface);
      const device = getVirtualStagehand(mockIface, 0x37, 'Stagehand-Test', mac);
      expect(device.id).toBe(0x37);
      expect(device.name).toBe('Stagehand-Test');
      expect(device.type).toBe(DeviceType.Stagehand);
      expect(device.macAddr).toBe(mac);
      expect(device.ip.address).toBe('192.168.1.100');
    });
  });

  describe('encodeStagehandNumber', () => {
    const mac = Uint8Array.from([0xc8, 0x3d, 0xfc, 0x33, 0x44, 0x55]);
    const packet = () => Uint8Array.from({length: 54}, (_, i) => (i * 7 + 1) & 0xff);

    it('hides the number behind a checksum of the packet and the MAC', () => {
      const p = packet();
      encodeStagehandNumber(p, 0x24, 0x3a, mac);

      // an independent sum: all bytes but the number's, then the MAC's last 3
      let sum = 0;
      packet().forEach((byte, i) => (sum += i === 0x24 ? 0 : byte));
      sum += 0x33 + 0x44 + 0x55;
      expect(p[0x24]).toBe(0x80 | ((0x3a ^ sum) & 0x7f));
      expect(decodeStagehandNumber(p, 0x24, mac)).toBe(0x3a);
    });

    it('round-trips every number a Stagehand may use', () => {
      for (let id = STAGEHAND_MIN_DEVICE_ID; id <= STAGEHAND_MAX_DEVICE_ID; id++) {
        const p = packet();
        encodeStagehandNumber(p, 33, id, mac);
        expect(p[33] & 0x80).toBe(0x80);
        expect(decodeStagehandNumber(p, 33, mac)).toBe(id);
      }
    });

    it('ignores the byte it writes, whatever was there', () => {
      const a = packet();
      const b = packet();
      a[33] = 0x00;
      b[33] = 0xff;
      encodeStagehandNumber(a, 33, 0x3a, mac);
      encodeStagehandNumber(b, 33, 0x3a, mac);
      expect(a[33]).toBe(b[33]);
    });

    it('sums only the first 64 bytes of a longer packet', () => {
      const long = (tail: number) => {
        const p = Uint8Array.from({length: 116}, (_, i) => (i < 64 ? i : tail));
        encodeStagehandNumber(p, 33, 0x3a, mac);
        return p[33];
      };
      expect(long(0x00)).toBe(long(0xff));

      const p = Uint8Array.from({length: 116}, (_, i) => i);
      const before = (encodeStagehandNumber(p, 33, 0x3a, mac), p[33]);
      p[63] += 1; // the last byte that counts
      encodeStagehandNumber(p, 33, 0x3a, mac);
      expect(p[33]).not.toBe(before);
    });

    it('uses the last three bytes of the MAC only', () => {
      const other = Uint8Array.from([0x00, 0x00, 0x00, 0x33, 0x44, 0x55]);
      const a = packet();
      const b = packet();
      encodeStagehandNumber(a, 33, 0x3a, mac);
      encodeStagehandNumber(b, 33, 0x3a, other);
      expect(a[33]).toBe(b[33]);

      const c = packet();
      encodeStagehandNumber(
        c,
        33,
        0x3a,
        Uint8Array.from([0xc8, 0x3d, 0xfc, 0x33, 0x44, 0x56])
      );
      expect(c[33]).not.toBe(a[33]);
    });

    it('reads a value below 0x80 as it is', () => {
      const p = packet();
      p[33] = 0x3a;
      expect(decodeStagehandNumber(p, 33, mac)).toBe(0x3a);
    });

    it('refuses a number that does not fit in 7 bits', () => {
      expect(() => encodeStagehandNumber(packet(), 33, 150, mac)).toThrow(RangeError);
      expect(() => encodeStagehandNumber(packet(), 33, -1, mac)).toThrow(RangeError);
      expect(() => encodeStagehandNumber(packet(), 33, 1.5, mac)).toThrow(RangeError);
    });
  });

  describe('Packet Builders', () => {
    it('should build exactly 37 bytes Stagehand 0x0a packet', () => {
      const device = getVirtualStagehand(mockIface);
      const packet = makeStagehand0aPacket(device);
      expect(packet.length).toBe(37);
      expect(packet[10]).toBe(0x0a); // Type
      expect(packet[32]).toBe(0x01); // Protocol byte 1
      expect(packet[33]).toBe(0x03); // Protocol byte 2 (Stagehand uses 03)
      expect(packet[36]).toBe(DeviceType.Stagehand); // 0x05
    });

    it('should build exactly 50 bytes Stagehand 0x02 packet', () => {
      const mac = getStagehandMac(mockIface);
      const device = getVirtualStagehand(
        mockIface,
        STAGEHAND_DEVICE_ID,
        'Stagehand',
        mac
      );
      const packet = makeStagehand02Packet(device, mac, 1);
      expect(packet.length).toBe(50);
      expect(packet[10]).toBe(0x02); // Type
      expect(packet[32]).toBe(0x01); // Protocol
      expect(packet[33]).toBe(0x03);
      expect(packet[46]).toBe(0x3a); // the device number claimed
      expect(packet[47]).toBe(1); // counter
      expect(packet[48]).toBe(DeviceType.Stagehand); // 0x05
      expect(packet[49]).toBe(0x01); // constant
    });

    it('should build exactly 54 bytes Stagehand 0x06 packet', () => {
      const mac = getStagehandMac(mockIface);
      const device = getVirtualStagehand(
        mockIface,
        STAGEHAND_DEVICE_ID,
        'Stagehand',
        mac
      );
      const packet = makeStagehand06Packet(device, mac);
      expect(packet.length).toBe(54);
      expect(packet[10]).toBe(0x06); // Type
      expect(packet[32]).toBe(0x01); // Protocol
      expect(packet[33]).toBe(0x03);
      expect(packet[36] & 0x80).toBe(0x80); // device ID, encoded
      expect(decodeStagehandNumber(packet, 36, mac)).toBe(0x3a);
      expect(packet[52]).toBe(DeviceType.Stagehand); // 0x05
      expect(packet[53]).toBe(0x20); // trailing byte
    });

    // Built by an independent implementation of the formula (Python): name
    // "Stagehand", the MAC and address of mockIface, number 0x3a.
    it('is the keep-alive a player files under 0x3a, byte for byte', () => {
      const mac = getStagehandMac(mockIface);
      const device = getVirtualStagehand(
        mockIface,
        STAGEHAND_DEVICE_ID,
        'Stagehand',
        mac
      );
      expect(Buffer.from(makeStagehand06Packet(device, mac)).toString('hex')).toBe(
        '5173707431576d4a4f4c0600537461676568616e64000000000000000000000001030036e401c83dfc334455c0a80164010000000520'
      );
    });

    it('encodes another device number in the same byte', () => {
      const mac = getStagehandMac(mockIface);
      const device = getVirtualStagehand(mockIface, 0x37, 'Stagehand', mac);
      const packet = makeStagehand06Packet(device, mac);
      expect(packet[36]).toBe(0xe9);
      expect(decodeStagehandNumber(packet, 36, mac)).toBe(0x37);
    });
  });

  describe('StagehandAnnouncer Lifecycle', () => {
    it('should start and stop announcer and send packets', () => {
      const mac = getStagehandMac(mockIface);
      const device = getVirtualStagehand(
        mockIface,
        STAGEHAND_DEVICE_ID,
        'Stagehand',
        mac
      );
      const mockSocket = {
        send: jest.fn(),
      } as any as Socket;
      const mockDeviceManager = {devices: new Map()} as any as DeviceManager;

      const announcer = new StagehandAnnouncer(
        device,
        mockSocket,
        mockDeviceManager,
        mockIface
      );

      announcer.start();
      expect(mockSocket.send).toHaveBeenCalled();
      announcer.stop();
    });
  });
});
