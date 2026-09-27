import {readMock} from 'tests/utils';

import {PROLINK_HEADER} from 'src/constants';
import {deviceFromPacket} from 'src/devices/utils';
import {DeviceType} from 'src/types';

describe('deviceFromPacket', () => {
  it('ignores packets without the prolink header', () => {
    expect(deviceFromPacket(Buffer.from([]))).toBeNull();
    expect(deviceFromPacket(Buffer.from('not a prolink packet'))).toBeNull();
    expect(deviceFromPacket(Buffer.from([0x00, ...PROLINK_HEADER, 0x06]))).toBeNull();
  });

  it('only handles announce (0x06) packets', () => {
    const packet = Buffer.from([...PROLINK_HEADER, 0x05]);

    expect(deviceFromPacket(packet)).toBeNull();
  });

  it('ignores truncated announce packets', async () => {
    const packet = await readMock('announce-cdj-2.dat');

    for (let length = 0; length < packet.length; length++) {
      const truncated = packet.subarray(0, length);

      expect(() => deviceFromPacket(truncated)).not.toThrow();

      if (length < 0x30) {
        expect(deviceFromPacket(truncated)).toBeNull();
      }
    }
  });

  it('handles a real announce packet', async () => {
    const packet = await readMock('announce-cdj-2.dat');

    const expected = {
      id: 2,
      type: DeviceType.CDJ,
      name: 'CDJ-2000nexus',
      ip: expect.objectContaining({address: '10.0.0.207'}),
      macAddr: Uint8Array.of(116, 94, 28, 87, 130, 216),
    };

    expect(deviceFromPacket(packet)).toEqual(expected);
  });
});
