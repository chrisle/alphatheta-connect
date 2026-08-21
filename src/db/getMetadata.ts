import {Track} from 'src/entities';
import LocalDatabase from 'src/localdb';
import {loadAnlz} from 'src/localdb/rekordbox';
import RemoteDatabase, {MenuTarget, Query} from 'src/remotedb';
import {Device, DeviceID, MediaSlot, TrackType} from 'src/types';
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
export type LocalResult = {track: Track; miss: null} | {track: null; miss: LocalMiss};

export async function viaRemote(remote: RemoteDatabase, opts: Required<Options>) {
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
  const track = await conn.query({
    queryDescriptor,
    query: isUnanalyzed ? Query.GetGenericMetadata : Query.GetMetadata,
    args: {trackId},
    span,
  });

  // Try to get file path — for streaming tracks this returns the Beatport track ID
  // (e.g. "/26883657.m4a") which we use for Beatport API lookups
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
  const {deviceId, trackSlot, trackId} = opts;

  if (trackSlot !== MediaSlot.USB && trackSlot !== MediaSlot.SD) {
    throw new Error('Expected USB or SD slot for local database query');
  }

  const adapter = await local.get(deviceId, trackSlot);
  if (adapter === null) {
    return {track: null, miss: 'no-database'};
  }

  const dbTrack = adapter.findTrack(trackId);

  if (dbTrack === null) {
    return {track: null, miss: 'track-absent'};
  }

  const anlz = await loadAnlz(dbTrack, 'DAT', anlzLoader({device, slot: trackSlot}));

  const track: Track = {
    ...dbTrack,
    beatGrid: anlz.beatGrid,
    waveformHd: null,
  };

  return {track, miss: null};
}
