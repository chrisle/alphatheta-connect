import {
  MAX_DEVICE_ID,
  pickAvailableDeviceId,
  REMOTEDB_MAX_DEVICE_ID,
} from 'src/virtualcdj/device-id';

describe('pickAvailableDeviceId', () => {
  describe('preferring the remotedb range', () => {
    const pick = (usedIds: number[]) =>
      pickAvailableDeviceId(usedIds, {preferRemoteDb: true});

    it('takes the top of the 1-6 range on an empty network', () => {
      expect(pick([])).toBe(REMOTEDB_MAX_DEVICE_ID);
    });

    it('never takes an ID a discovered device holds', () => {
      // A 4-deck setup: players 1-4 are live, plus a mixer on 33
      expect(pick([1, 2, 3, 4, 33])).toBe(6);
      expect(pick([1, 2, 3, 4, 6, 33])).toBe(5);
    });

    it('skips a player parked at the top of the range', () => {
      // The exact shape of NP3-356: a CDJ-3000 numbered 5, another on 6
      expect(pick([1, 2, 5, 6])).toBe(4);
    });

    it('falls back above 6 when every player number is taken', () => {
      expect(pick([1, 2, 3, 4, 5, 6])).toBe(7);
    });

    it('returns null when every ID is occupied', () => {
      const allIds = Array.from({length: MAX_DEVICE_ID}, (_, i) => i + 1);
      expect(pick(allIds)).toBeNull();
    });
  });

  describe('preferring the high range', () => {
    const pick = (usedIds: number[]) => pickAvailableDeviceId(usedIds);

    it('starts just above the remotedb range', () => {
      expect(pick([])).toBe(7);
    });

    it('climbs past occupied high IDs', () => {
      expect(pick([7, 8, 9])).toBe(10);
    });

    it('drops into the 1-6 range only once 7-32 is full', () => {
      const highIds = Array.from({length: MAX_DEVICE_ID - 6}, (_, i) => i + 7);
      expect(pick(highIds)).toBe(6);
      expect(pick([...highIds, 6])).toBe(5);
    });
  });

  it('accepts any iterable of used IDs', () => {
    expect(pickAvailableDeviceId(new Set([7, 8]))).toBe(9);
    expect(
      pickAvailableDeviceId(new Map([[7, 'a']]).keys(), {preferRemoteDb: false})
    ).toBe(8);
  });
});
