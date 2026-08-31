import {DeviceType} from 'src/types';
import {
  DEFAULT_MIXER_PLAYER_CEILING,
  MAX_DEVICE_ID,
  pickAvailableDeviceId,
  pickRemoteDbQueryId,
  playerNumberCeiling,
  REMOTEDB_MAX_DEVICE_ID,
} from 'src/virtualcdj/device-id';

const mixer = (name: string) => ({name, type: DeviceType.Mixer});
const player = (name: string) => ({name, type: DeviceType.CDJ});

describe('playerNumberCeiling', () => {
  it('reads the channel count off a known mixer', () => {
    expect(playerNumberCeiling([mixer('DJM-A9')])).toBe(4);
    expect(playerNumberCeiling([mixer('DJM-V5')])).toBe(3);
    expect(playerNumberCeiling([mixer('DJM-450')])).toBe(2);
  });

  it('knows the six-channel flagships are not four-channel', () => {
    // The app's own capability table caps these at 4 for its mixer signal
    // model; using that number here would put us on player 5 of a rig that
    // can hand player 5 out.
    expect(playerNumberCeiling([mixer('DJM-V10')])).toBe(6);
    expect(playerNumberCeiling([mixer('DJM-V10-LF')])).toBe(6);
  });

  it('assumes four channels for a mixer it does not recognise', () => {
    expect(playerNumberCeiling([mixer('DJM-9000XZ')])).toBe(DEFAULT_MIXER_PLAYER_CEILING);
  });

  it('counts an all-in-one by the players built into it', () => {
    expect(playerNumberCeiling([player('XDJ-AZ')])).toBe(4);
    expect(playerNumberCeiling([player('XDJ-RX3')])).toBe(2);
  });

  it('has nothing to say about plain players', () => {
    expect(playerNumberCeiling([player('CDJ-3000'), player('CDJ-3000')])).toBeUndefined();
  });

  it('takes the largest rig when several mixers share a network', () => {
    expect(playerNumberCeiling([mixer('DJM-A9'), mixer('DJM-V10')])).toBe(6);
  });

  it('matches model names regardless of case and padding', () => {
    expect(playerNumberCeiling([mixer('  djm-v10  ')])).toBe(6);
  });
});

describe('pickAvailableDeviceId', () => {
  describe('with a mixer to reason from', () => {
    const pick = (usedIds: number[], playerCeiling: number) =>
      pickAvailableDeviceId(usedIds, {preferPlayerRange: true, playerCeiling});

    it('sits just above the numbers the mixer can hand out', () => {
      expect(pick([1, 2, 3, 4, 33], 4)).toBe(5); // DJM-A9
      expect(pick([1, 2, 3, 33], 3)).toBe(4); // DJM-V5
      expect(pick([1, 2, 33], 2)).toBe(3); // DJM-450
    });

    it('leaves the remotedb range entirely on a six-channel rig', () => {
      // A DJM-V10 can assign every number 1-6, so none of them is ours to
      // take — even the ones sitting free right now.
      expect(pick([1, 2, 33], 6)).toBe(7);
    });

    it('does not care how many players are actually plugged in', () => {
      // Two CDJs on a DJM-A9 today, but channels 3 and 4 are still the
      // mixer's to hand out.
      expect(pick([1, 2, 33], 4)).toBe(5);
    });

    it('climbs within the range when the slot above the players is taken', () => {
      expect(pick([1, 2, 5, 33], 4)).toBe(6);
    });

    it('goes outside the remotedb range before contending with a player', () => {
      // 5 and 6 gone, so metadata is lost either way — take an ID no player
      // can be assigned rather than one channel 3 could claim.
      expect(pick([1, 2, 5, 6, 33], 4)).toBe(7);
    });

    it('contends for a free player slot only as a last resort', () => {
      const allHigh = Array.from({length: MAX_DEVICE_ID - 4}, (_, i) => i + 5);
      expect(pick([...allHigh, 1, 2], 4)).toBe(4);
    });

    it('returns null when every ID is occupied', () => {
      const allIds = Array.from({length: MAX_DEVICE_ID}, (_, i) => i + 1);
      expect(pick(allIds, 4)).toBeNull();
    });
  });

  describe('with no mixer on the network', () => {
    const pick = (usedIds: number[]) =>
      pickAvailableDeviceId(usedIds, {preferPlayerRange: true});

    it('works down from the top of the range', () => {
      // Nothing says how high player numbers will go, and players number
      // themselves upwards from 1.
      expect(pick([])).toBe(REMOTEDB_MAX_DEVICE_ID);
      expect(pick([1, 2, 3, 4])).toBe(6);
      expect(pick([1, 2, 5, 6])).toBe(4);
    });

    it('falls back above 6 when every player number is taken', () => {
      expect(pick([1, 2, 3, 4, 5, 6])).toBe(7);
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
    expect(pickAvailableDeviceId(new Map([[7, 'a']]).keys())).toBe(8);
  });
});

describe('pickRemoteDbQueryId', () => {
  const cdj = (id: number) => ({id, type: DeviceType.CDJ});
  const mixerAt = (id: number) => ({id, type: DeviceType.Mixer});
  const rekordbox = (id: number) => ({id, type: DeviceType.Rekordbox});

  it('poses as a live player that is not the target', () => {
    // Satisfies the strictest documented (nexus-era) rules: 1-4, present on
    // the network, not the player being queried.
    expect(pickRemoteDbQueryId(2, [cdj(1), cdj(2)])).toBe(1);
    expect(pickRemoteDbQueryId(1, [cdj(1), cdj(2)])).toBe(2);
    expect(pickRemoteDbQueryId(5, [cdj(3), cdj(5)])).toBe(3);
  });

  it('takes the lowest free 1-6 ID when the target is the only player', () => {
    // Verified on CDJ-3000: IDs of absent players are answered too.
    expect(pickRemoteDbQueryId(2, [cdj(2)])).toBe(1);
    expect(pickRemoteDbQueryId(1, [cdj(1)])).toBe(2);
  });

  it('ignores mixers and rekordbox when looking for players to pose as', () => {
    expect(pickRemoteDbQueryId(2, [cdj(2), mixerAt(33), rekordbox(17)])).toBe(1);
  });

  it('never returns an ID above the remotedb range', () => {
    const rigs: Array<Array<{id: number; type: number}>> = [
      [cdj(1)],
      [cdj(1), cdj(2), cdj(3), cdj(4), cdj(5), cdj(6), mixerAt(33)],
      [mixerAt(33)],
    ];
    for (const rig of rigs) {
      for (const target of [1, 2, 3, 4, 5, 6]) {
        expect(pickRemoteDbQueryId(target, rig)).toBeLessThanOrEqual(
          REMOTEDB_MAX_DEVICE_ID
        );
      }
    }
  });

  it('answers the full-rig case with the lowest other player', () => {
    const rig = [cdj(1), cdj(2), cdj(3), cdj(4), cdj(5), cdj(6)];
    expect(pickRemoteDbQueryId(3, rig)).toBe(1);
    expect(pickRemoteDbQueryId(1, rig)).toBe(2);
  });
});
