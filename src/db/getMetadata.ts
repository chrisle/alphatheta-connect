import {Track} from 'src/entities';
import LocalDatabase from 'src/localdb';
import {DatabaseType} from 'src/localdb/database-adapter';
import {loadAnlz} from 'src/localdb/rekordbox';
import {type Logger, noopLogger} from 'src/logger';
import RemoteDatabase, {MenuTarget, Query} from 'src/remotedb';
import {MetadataResponse} from 'src/remotedb/queries';
import {Device, DeviceID, MediaSlot, TrackType} from 'src/types';
import {getSlotName, getTrackTypeName} from 'src/utils';
import {TelemetrySpan as Span} from 'src/utils/telemetry';

import {anlzLoader} from './utils';

export interface Options {
  /**
   * The device to query the track metadata from
   */
  deviceId: DeviceID;
  /**
   * The media slot the track is present in
   */
  trackSlot: MediaSlot;
  /**
   * The type of track we are querying for
   */
  trackType: TrackType;
  /**
   * The track id to retrieve metadata for
   */
  trackId: number;
  /**
   * The track's BPM as the player reports it in its status packet, when known.
   * Used to check that the local database row for `trackId` is really the
   * track the player is showing (see {@link LocalDatabase.findTrack}).
   */
  trackBPM?: number | null;
  /**
   * The Sentry transaction span
   */
  span?: Span;
}

/**
 * Why a local database lookup produced no track.
 *
 * `viaLocal` used to answer both cases with a bare `null`, so a metadata
 * failure in the field was indistinguishable from a slot that never hydrated
 * — the reason NP3-361 could not be diagnosed from the logs a user sent in.
 */
export type LocalMiss =
  /** No rekordbox database is loaded for that device slot */
  | 'no-database'
  /** The database is loaded, but holds no track with that id */
  | 'track-absent';

/**
 * The outcome of a local database metadata lookup.
 */
export type LocalResult =
  | {
      track: Track;
      miss: null;
      /**
       * Set when the slot had to switch to its other database format to
       * answer: the format it is now served from.
       */
      switchedTo: DatabaseType | null;
    }
  | {track: null; miss: LocalMiss; switchedTo: null};

/**
 * The longest a single item is allowed to run in a blank-metadata report, so
 * one oversized field cannot swamp the log line.
 */
const MAX_ITEM_REPORT_LENGTH = 200;

/**
 * Explain a remote lookup that came back with neither a title nor an artist:
 * what the player was asked, how many items it sent, and each item's type and
 * fields as they arrived. A player that files a track under an unfamiliar slot
 * can answer this way (NP3-416), and without the raw items there is no telling
 * an empty answer from one we do not know how to read.
 */
export function describeBlankMetadata(
  opts: Pick<Options, 'deviceId' | 'trackSlot' | 'trackType' | 'trackId'>,
  response: MetadataResponse | null,
  trackInfo: string
) {
  const {deviceId, trackSlot, trackType, trackId} = opts;

  const slotName = getSlotName(trackSlot) ?? 'unknown';
  const typeName = getTrackTypeName(trackType) ?? 'unknown';

  const itemReports = (response?.items ?? []).map(({type, ...fields}) => {
    const hex = `0x${type.toString(16).padStart(4, '0')}`;
    const report = `${hex} ${JSON.stringify(fields)}`;
    return report.length > MAX_ITEM_REPORT_LENGTH
      ? `${report.slice(0, MAX_ITEM_REPORT_LENGTH)}…`
      : report;
  });

  const items =
    response === null
      ? 'no response recorded'
      : [
          `${response.items.length} of ${response.itemsAvailable} item(s) received`,
          ...itemReports,
        ].join('; ');

  return (
    `Device ${deviceId} answered the metadata query for track ${trackId} ` +
    `(slot ${trackSlot} ${slotName}, type ${trackType} ${typeName}) with no ` +
    `title or artist: ${items}; track info: ${trackInfo}`
  );
}

export async function viaRemote(
  remote: RemoteDatabase,
  opts: Required<Options>,
  logger: Logger = noopLogger
) {
  const {deviceId, trackSlot, trackType, trackId, span} = opts;

  const conn = await remote.get(deviceId);
  if (conn === null) {
    return null;
  }

  const queryDescriptor = {
    trackSlot,
    trackType,
    menuTarget: MenuTarget.Main,
  };

  const isUnanalyzed =
    trackType === TrackType.Unanalyzed || trackType === TrackType.AudioCD;
  const isStreaming = trackType === TrackType.Streaming;
  const skipLocalFileLookups = isUnanalyzed || isStreaming;

  // Unanalyzed tracks use GetGenericMetadata (reads ID3 tags from the audio file).
  // Streaming tracks (Beatport) use the regular GetMetadata query.
  let response: MetadataResponse | null = null;
  const track = isUnanalyzed
    ? await conn.query({
        queryDescriptor,
        query: Query.GetGenericMetadata,
        args: {trackId},
        span,
      })
    : await conn.query({
        queryDescriptor,
        query: Query.GetMetadata,
        args: {trackId, onResponse: r => (response = r)},
        span,
      });

  // Try to get file path — for streaming tracks this returns the Beatport track ID
  // (e.g. "/26883657.m4a") which we use for Beatport API lookups
  let trackInfoError: string | null = null;
  try {
    track.filePath = await conn.query({
      queryDescriptor,
      query: Query.GetTrackInfo,
      args: {trackId},
      span,
    });
  } catch (err) {
    if (!skipLocalFileLookups) {
      throw err;
    }
    trackInfoError = err instanceof Error ? err.message : String(err);
  }

  if (!track.title?.trim() && !track.artist?.name?.trim()) {
    const trackInfo =
      trackInfoError === null
        ? JSON.stringify(track.filePath)
        : `failed (${trackInfoError})`;
    logger.warn(describeBlankMetadata(opts, response, trackInfo));
  }

  // Beat grid is only available for analyzed local tracks
  if (!skipLocalFileLookups) {
    track.beatGrid = await conn.query({
      queryDescriptor,
      query: Query.GetBeatGrid,
      args: {trackId},
      span,
    });
  }

  return track;
}

export async function viaLocal(
  local: LocalDatabase,
  device: Device,
  opts: Required<Options>
): Promise<LocalResult> {
  const {deviceId, trackSlot, trackId, trackBPM} = opts;

  if (trackSlot !== MediaSlot.USB && trackSlot !== MediaSlot.SD) {
    throw new Error('Expected USB or SD slot for local database query');
  }

  const lookup = await local.findTrack(deviceId, trackSlot, trackId, {trackBPM});
  if (lookup.adapter === null) {
    return {track: null, miss: 'no-database', switchedTo: null};
  }

  if (lookup.track === null) {
    return {track: null, miss: 'track-absent', switchedTo: null};
  }

  const anlz = await loadAnlz(lookup.track, 'DAT', anlzLoader({device, slot: trackSlot}));

  const track: Track = {
    ...lookup.track,
    beatGrid: anlz.beatGrid,
    waveformHd: null,
  };

  return {track, miss: null, switchedTo: lookup.switchedTo};
}
