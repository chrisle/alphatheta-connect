import {makeLoadTrackPacket} from 'src/control/load';
import {Device, DeviceType, MediaSlot, TrackType} from 'src/types';

describe('makeLoadTrackPacket', () => {
  // rekordbox 7.2.11 loading two tracks of its library (device 17, the
  // rekordbox slot) onto players 1 and 2, captured 2026-09-13 on real
  // CDJ-3000s.
  const CAPTURED_PLAYER_1 =
    '5173707431576d4a4f4c1972656b6f7264626f7800000000000000000000000101110034110000001104010001300ad700000032000000000000000000000000000000000000000000000032000000000000000000000000';
  const CAPTURED_PLAYER_2 =
    '5173707431576d4a4f4c1972656b6f7264626f78000000000000000000000001011100341100000011040100046273df00000032000000000000000000000000010000000000000000000032000000000000000000000000';

  const rekordbox: Device = {
    id: 17,
    name: 'rekordbox',
    type: DeviceType.Rekordbox,
    ip: {address: '192.168.1.14'} as any,
    macAddr: new Uint8Array(6),
  };
  const player = (id: number): Device => ({
    id,
    name: 'CDJ-3000',
    type: DeviceType.CDJ,
    ip: {address: `192.168.1.${id}`} as any,
    macAddr: new Uint8Array(6),
  });
  const library = {deviceId: 17, slot: MediaSlot.RB, trackType: TrackType.RB};

  it("is rekordbox's command byte for byte", () => {
    expect(
      Buffer.from(
        makeLoadTrackPacket(rekordbox, player(1), 19_925_719, library)
      ).toString('hex')
    ).toBe(CAPTURED_PLAYER_1);
    expect(
      Buffer.from(
        makeLoadTrackPacket(rekordbox, player(2), 73_561_055, library)
      ).toString('hex')
    ).toBe(CAPTURED_PLAYER_2);
  });

  it('names another source and defaults the track type to rekordbox', () => {
    const stagehand: Device = {
      ...rekordbox,
      id: 150,
      name: 'Stagehand',
      type: DeviceType.Stagehand,
    };
    const packet = makeLoadTrackPacket(stagehand, player(1), 0x12345678, {
      deviceId: 2,
      slot: MediaSlot.USB,
    });
    expect(packet.length).toBe(88);
    expect(packet[33]).toBe(150);
    expect(packet[36]).toBe(150);
    expect(packet[40]).toBe(2);
    expect(packet[41]).toBe(MediaSlot.USB);
    expect(packet[42]).toBe(TrackType.RB);
    expect(Array.from(packet.subarray(44, 48))).toEqual([0x12, 0x34, 0x56, 0x78]);
    expect(packet[0x40]).toBe(0);
  });
});
