import type {DeviceID} from 'src/types';

/**
 * The highest device ID a CDJ will answer remotedb queries from.
 *
 * CDJs ignore metadata requests from devices numbered above this, which is why
 * the 1-6 range is worth preferring even though real players live there too.
 */
export const REMOTEDB_MAX_DEVICE_ID = 6;

/**
 * The highest device ID the prolink protocol allows.
 */
export const MAX_DEVICE_ID = 32;

export interface PickDeviceIdOptions {
  /**
   * Prefer an ID in the 1-6 range, which is the only range CDJs answer
   * remotedb metadata queries from (unanalyzed media, CD text, streaming
   * tracks).
   *
   * That range is shared with real players, so the search runs downwards from
   * 6: players number themselves from 1 upwards, so the top of the range is
   * the least likely to be claimed by a CDJ that powers on later.
   *
   * @default false
   */
  preferRemoteDb?: boolean;
}

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
  {preferRemoteDb = false}: PickDeviceIdOptions = {}
): DeviceID | null {
  const used = new Set(usedIds);

  const remoteDbRange: DeviceID[] = [];
  for (let id = REMOTEDB_MAX_DEVICE_ID; id >= 1; id--) {
    remoteDbRange.push(id);
  }

  const highRange: DeviceID[] = [];
  for (let id = REMOTEDB_MAX_DEVICE_ID + 1; id <= MAX_DEVICE_ID; id++) {
    highRange.push(id);
  }

  const search = preferRemoteDb
    ? [...remoteDbRange, ...highRange]
    : [...highRange, ...remoteDbRange];

  return search.find(id => !used.has(id)) ?? null;
}
