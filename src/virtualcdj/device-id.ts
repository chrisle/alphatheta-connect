/**
 * Mirrors {@link import('src/types').DeviceID}. Declared locally rather than
 * imported so this module carries no dependencies at all: consumers re-export
 * it into their own test setups, where the package's `src/*` path aliases do
 * not resolve.
 */
type DeviceID = number;

/**
 * The highest device ID a CDJ will answer remotedb queries from.
 *
 * This limit applies to the device-ID byte inside the remotedb protocol (the
 * Introduce message and every query header), NOT to the ID we announce on the
 * network. Hardware-verified on a CDJ-3000 (2026-08-30, two players + DJM-V5,
 * announced as VCDJ 7 throughout): queries carrying 1-6 are all answered —
 * including IDs of absent players and the target's own ID — while 7 and above
 * are silently ignored (the TCP connection and Introduce succeed, the query
 * never gets a response). See {@link pickRemoteDbQueryId}.
 */
export const REMOTEDB_MAX_DEVICE_ID = 6;

/**
 * The highest device ID the prolink protocol allows.
 */
export const MAX_DEVICE_ID = 32;

/**
 * `DeviceType.Mixer` and `DeviceType.CDJ`, inlined so this module stays free
 * of runtime imports — it is re-exported into consumers' test environments,
 * where pulling in the whole type module (and its ip-address dependency) is
 * dead weight.
 */
const MIXER_DEVICE_TYPE = 0x03;
const CDJ_DEVICE_TYPE = 0x01;

/**
 * How many player numbers each mixer can hand out.
 *
 * Players take their number from the mixer channel they are plugged into, so
 * an N-channel mixer only ever produces players 1..N — and N+1 is the lowest
 * number that no player on that rig can claim.
 *
 * These are physical channel counts, deliberately NOT the `channelCount` in
 * the app's own capability table, which caps the DJM-V10 at 4 for its mixer
 * signal model. Capping here would put us on player 5 of a 6-channel rig,
 * which is the collision this table exists to avoid.
 */
export const MIXER_PLAYER_CEILING: Record<string, number> = {
  // 6-channel flagships — no player number in 1-6 is safe on these
  'DJM-V10': 6,
  'DJM-V10-LF': 6,

  // 4-channel
  'DJM-A9': 4,
  'DJM-900NXS2': 4,
  'DJM-900NXS': 4,
  'DJM-900SRT': 4,
  'DJM-850': 4,
  'DJM-800': 4,
  'DJM-750MK2': 4,
  'DJM-750': 4,
  'DJM-TOUR1': 4,
  'DJM-2000NXS': 4,
  'DJM-2000': 4,
  EUPHONIA: 4,

  // 3-channel (2026)
  'DJM-V5': 3,

  // 2-channel
  'DJM-450': 2,
  'DJM-350': 2,
  'DJM-250MK2': 2,

  // All-in-ones: their built-in players occupy numbers too, so the ceiling is
  // however many decks the unit announces rather than its mixer channel count
  'XDJ-XZ': 4,
  'XDJ-AZ': 4,
  'XDJ-RX3': 2,
  'XDJ-RX2': 2,
  'XDJ-RX': 2,
  'XDJ-AN': 2,
  'OPUS-QUAD': 4,
};

/**
 * What to assume about a mixer whose model we do not recognise.
 *
 * Four is both the most common layout and the choice that keeps remotedb
 * metadata working: assuming six would push us to player 7 on every mixer
 * released after this table was written, silently losing metadata for
 * unanalyzed and streaming tracks. A six-channel unit we failed to recognise
 * may later claim the number we took, which the announcer's conflict handling
 * resolves by moving us.
 */
export const DEFAULT_MIXER_PLAYER_CEILING = 4;

/** The fields {@link playerNumberCeiling} reads off a discovered device. */
export interface DeviceLike {
  name: string;
  type: number;
}

/**
 * The highest player number the discovered gear can hand out, or undefined
 * when nothing on the network implies one.
 *
 * Undefined means we have no mixer to reason from — players may have been
 * numbered by hand anywhere in 1-6, and there is no better guess available.
 */
export function playerNumberCeiling(devices: Iterable<DeviceLike>): number | undefined {
  let ceiling: number | undefined;

  for (const device of devices) {
    const known = MIXER_PLAYER_CEILING[device.name.trim().toUpperCase()];
    const value =
      known ??
      (device.type === MIXER_DEVICE_TYPE ? DEFAULT_MIXER_PLAYER_CEILING : undefined);

    if (value !== undefined && (ceiling === undefined || value > ceiling)) {
      ceiling = value;
    }
  }

  return ceiling;
}

export interface PickDeviceIdOptions {
  /**
   * Prefer an ID in the 1-6 range, the range real players number themselves
   * in. Purely conventional: remotedb metadata no longer depends on our
   * announced ID ({@link pickRemoteDbQueryId} chooses the in-protocol query
   * ID independently), but sitting where gear expects players keeps us
   * legible on link displays and avoids surprising other tooling.
   *
   * @default false
   */
  preferPlayerRange?: boolean;
  /**
   * The highest player number the rig can hand out, from
   * {@link playerNumberCeiling}. The search starts just above it, so the
   * number we take is one no player on this rig can be assigned.
   *
   * When omitted, the 1-6 range is searched downwards instead: players number
   * themselves from 1 upwards, so the top of the range is the least likely to
   * be claimed by a CDJ that powers on later.
   */
  playerCeiling?: number;
}

const descending = (from: number, to: number) => {
  const ids: DeviceID[] = [];
  for (let id = from; id >= to; id--) {
    ids.push(id);
  }
  return ids;
};

const ascending = (from: number, to: number) => {
  const ids: DeviceID[] = [];
  for (let id = from; id <= to; id++) {
    ids.push(id);
  }
  return ids;
};

/**
 * Pick a device ID that no device on the network is currently using.
 *
 * Taking an ID a live player already holds knocks that player off the network
 * mid-set, so every caller that chooses its own ID should route through here
 * rather than hardcoding one.
 *
 * Returns null when every ID from 1 to 32 is occupied, in which case there is
 * no safe ID and the caller must not join the network.
 */
export function pickAvailableDeviceId(
  usedIds: Iterable<DeviceID>,
  {preferPlayerRange = false, playerCeiling}: PickDeviceIdOptions = {}
): DeviceID | null {
  const used = new Set(usedIds);

  const aboveThePlayers =
    playerCeiling === undefined
      ? descending(REMOTEDB_MAX_DEVICE_ID, 1)
      : ascending(playerCeiling + 1, REMOTEDB_MAX_DEVICE_ID);

  const outsidePlayerRange = ascending(REMOTEDB_MAX_DEVICE_ID + 1, MAX_DEVICE_ID);

  // Numbers a player on this rig could be assigned. Last resort: better to
  // contend for a slot than not to join at all, and the announcer moves us if
  // the player that owns it shows up.
  const amongThePlayers =
    playerCeiling === undefined
      ? []
      : descending(Math.min(playerCeiling, REMOTEDB_MAX_DEVICE_ID), 1);

  const search = preferPlayerRange
    ? [...aboveThePlayers, ...outsidePlayerRange, ...amongThePlayers]
    : [...outsidePlayerRange, ...aboveThePlayers, ...amongThePlayers];

  return search.find(id => !used.has(id)) ?? null;
}

/** The fields {@link pickRemoteDbQueryId} reads off a discovered device. */
export interface QueryIdDeviceLike {
  id: DeviceID;
  type: number;
}

/**
 * Choose the device ID to carry inside remotedb messages when querying a CDJ.
 *
 * CDJs only answer remotedb queries whose in-protocol device-ID byte is in
 * 1-6, but that byte is independent of the ID we announce on the network — so
 * a virtual CDJ announced safely above the player range (say 7 behind a
 * DJM-V10) can still query metadata by carrying an in-range ID here. Verified
 * on a CDJ-3000 (2026-08-30): absent IDs and even the target's own ID are
 * answered; 7+ is silently dropped.
 *
 * Older players are documented (dysentery, nexus era) as stricter: the byte
 * had to be 1-4, belong to a player actually on the network, and not be the
 * player being queried. The preference order below satisfies those rules
 * whenever the rig makes it possible, then falls back through choices newer
 * players accept.
 */
export function pickRemoteDbQueryId(
  targetId: DeviceID,
  devices: Iterable<QueryIdDeviceLike>
): DeviceID {
  const playerIds = new Set<DeviceID>();
  for (const device of devices) {
    if (device.type === CDJ_DEVICE_TYPE && device.id <= REMOTEDB_MAX_DEVICE_ID) {
      playerIds.add(device.id);
    }
  }

  // A live player that isn't the target, lowest first — 1-4 satisfies every
  // documented era of the restriction.
  const otherPlayers = [...playerIds].filter(id => id !== targetId).sort((a, b) => a - b);
  if (otherPlayers.length > 0) {
    return otherPlayers[0];
  }

  // No other player on the rig: take the lowest 1-6 ID no player holds.
  for (let id = 1; id <= REMOTEDB_MAX_DEVICE_ID; id++) {
    if (id !== targetId && !playerIds.has(id)) {
      return id;
    }
  }

  // Six players and every one of them is the target? Impossible, but the
  // target's own ID is answered too, so it is a safe closing fallback.
  return targetId;
}
