import {MAX_CDJ_DEVICE_ID, MIN_CDJ_DEVICE_ID} from 'src/constants';
import DeviceManager from 'src/devices';
import {Track} from 'src/entities';
import LocalDatabase from 'src/localdb';
import {DatabaseType} from 'src/localdb/database-adapter';
import {type Logger, noopLogger} from 'src/logger';
import RemoteDatabase from 'src/remotedb';
import {
  Device,
  DeviceType,
  MediaSlot,
  PlaylistContents,
  TrackType,
  Waveforms,
} from 'src/types';
import {getSlotName, getTrackTypeName} from 'src/utils';
import * as Telemetry from 'src/utils/telemetry';
import {SpanStatus} from 'src/utils/telemetry';

import * as GetArtworkFromFile from './getArtworkFromFile';
import * as GetArtworkThumbnail from './getArtworkThumbnail';
import * as GetFile from './getFile';
import * as GetMetadata from './getMetadata';
import * as GetPlaylist from './getPlaylist';
import * as GetTrackAnalysis from './getTrackAnalysis';
import * as GetWaveforms from './getWaveforms';

enum LookupStrategy {
  Remote,
  Local,
  NoneAvailable,
}

/**
 * A Database is the central service used to query devices on the prolink
 * network for information from their databases.
 */
class Database {
  #deviceManager: DeviceManager;
  /**
   * The local database service, used when querying media devices connected
   * directly to CDJs containing a rekordbox formatted database.
   */
  #localDatabase: LocalDatabase;
  /**
   * The remote database service, used when querying the Rekordbox software or a
   * CDJ with an unanalyzed media device connected (when possible).
   */
  #remoteDatabase: RemoteDatabase;
  #logger: Logger;

  constructor(
    local: LocalDatabase,
    remote: RemoteDatabase,
    deviceManager: DeviceManager,
    logger: Logger = noopLogger
  ) {
    this.#localDatabase = local;
    this.#remoteDatabase = remote;
    this.#deviceManager = deviceManager;
    this.#logger = logger;
  }

  #getTrackLookupStrategy = (device: Device, type: TrackType) => {
    const isUnanalyzed = type === TrackType.AudioCD || type === TrackType.Unanalyzed;
    const isStreaming = type === TrackType.Streaming;

    // Unanalyzed and streaming tracks on CDJs must use RemoteDB
    // (streaming services like Beatport have no local database)
    if (device.type === DeviceType.CDJ && (isUnanalyzed || isStreaming)) {
      return LookupStrategy.Remote;
    }

    return device.type === DeviceType.Rekordbox
      ? LookupStrategy.Remote
      : device.type === DeviceType.CDJ && type === TrackType.RB
        ? LookupStrategy.Local
        : LookupStrategy.NoneAvailable;
  };

  #getMediaLookupStrategy = (device: Device, slot: MediaSlot) =>
    device.type === DeviceType.Rekordbox && slot === MediaSlot.RB
      ? LookupStrategy.Remote
      : device.type === DeviceType.Rekordbox
        ? LookupStrategy.NoneAvailable
        : LookupStrategy.Local;
  /**
   * Get the database type (oneLibrary or pdb) for a loaded device slot.
   * Returns null if the slot uses remote database or no database is loaded.
   */
  getDatabaseType(
    deviceId: number,
    slot: MediaSlot.USB | MediaSlot.SD
  ): DatabaseType | null {
    return this.#localDatabase.getDatabaseType(deviceId, slot);
  }

  /**
   * Retrieve metadata for a track on a specific device slot.
   */
  async getMetadata(opts: GetMetadata.Options) {
    const {deviceId, trackType, trackSlot, span} = opts;

    const tx = span
      ? span.startChild({op: 'dbGetMetadata'})
      : Telemetry.startTransaction({name: 'dbGetMetadata'});

    tx.setTag('deviceId', deviceId.toString());
    tx.setTag('trackType', getTrackTypeName(trackType));
    tx.setTag('trackSlot', getSlotName(trackSlot));

    const callOpts = {...opts, span: tx};

    const device = await this.#deviceManager.getDeviceEnsured(deviceId);
    if (device === null) {
      return null;
    }

    const strategy = this.#getTrackLookupStrategy(device, trackType);
    let track: Track | null = null;

    if (strategy === LookupStrategy.Remote) {
      track = await GetMetadata.viaRemote(this.#remoteDatabase, callOpts);
    }

    if (strategy === LookupStrategy.Local) {
      const local = await GetMetadata.viaLocal(this.#localDatabase, device, callOpts);
      track = local.track;

      // A local miss used to end the lookup, so the DJ's track silently never
      // reached the overlay for the rest of the set (NP3-361). Say what was
      // missed, then give the CDJ's own database a chance to answer.
      if (local.miss !== null) {
        this.#logger.warn(
          `Local metadata lookup missed track ${opts.trackId} on device ${deviceId} ` +
            `${getSlotName(trackSlot)}: ${
              local.miss === 'no-database'
                ? 'no rekordbox database is loaded for that slot'
                : 'the loaded database holds no track with that id'
            }`
        );
        track = await this.#metadataViaRemoteFallback(callOpts);
      }
    }

    if (strategy === LookupStrategy.NoneAvailable) {
      tx.setStatus(SpanStatus.Unavailable);
    }

    tx.finish();

    return track;
  }

  /**
   * Second chance for a track the local database could not answer for.
   *
   * CDJs only answer remote database queries from a host announcing a device
   * ID in the 1-6 range, so this is unavailable whenever the virtual CDJ sits
   * outside it (the package default is 7). That is a real configuration, not
   * an error — log why the fallback was skipped rather than throwing, so the
   * next report says which of the two happened.
   */
  async #metadataViaRemoteFallback(opts: Required<GetMetadata.Options>) {
    const hostId = this.#remoteDatabase.hostDevice.id;

    if (hostId < MIN_CDJ_DEVICE_ID || hostId > MAX_CDJ_DEVICE_ID) {
      this.#logger.warn(
        `No remote fallback for track ${opts.trackId}: this player is device ` +
          `${hostId}, and CDJs only answer remote database queries from ` +
          `devices ${MIN_CDJ_DEVICE_ID}-${MAX_CDJ_DEVICE_ID}`
      );
      return null;
    }

    try {
      const track = await GetMetadata.viaRemote(this.#remoteDatabase, opts);
      if (track === null) {
        this.#logger.warn(
          `Remote fallback found no track ${opts.trackId} on device ${opts.deviceId}`
        );
        return null;
      }

      this.#logger.info(
        `Remote fallback recovered track ${opts.trackId} from device ${opts.deviceId}`
      );
      return track;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.#logger.warn(
        `Remote fallback failed for track ${opts.trackId} on device ` +
          `${opts.deviceId}: ${message}`
      );
      return null;
    }
  }

  /**
   * Retrieves the file off a specific device slot.
   */
  async getFile(opts: GetArtworkThumbnail.Options) {
    const {deviceId, trackType, trackSlot, span} = opts;

    const tx = span
      ? span.startChild({op: 'dbGetFile'})
      : Telemetry.startTransaction({name: 'dbGetFile'});

    tx.setTag('deviceId', deviceId.toString());
    tx.setTag('trackType', getTrackTypeName(trackType));
    tx.setTag('trackSlot', getSlotName(trackSlot));

    const callOpts = {...opts, span: tx};

    const device = await this.#deviceManager.getDeviceEnsured(deviceId);
    if (device === null) {
      return null;
    }

    const strategy = this.#getTrackLookupStrategy(device, trackType);
    let artwork: Buffer | null = null;

    if (strategy === LookupStrategy.Remote) {
      artwork = await GetFile.viaRemote(this.#remoteDatabase, device, callOpts);
    }

    if (strategy === LookupStrategy.Local) {
      artwork = await GetFile.viaLocal(this.#localDatabase, device, callOpts);
    }

    if (strategy === LookupStrategy.NoneAvailable) {
      tx.setStatus(SpanStatus.Unavailable);
    }

    tx.finish();

    return artwork;
  }

  /**
   * Retrieves the low-resolution artwork thumbnail from the rekordbox database.
   *
   * This returns the pre-generated thumbnail stored in the rekordbox database,
   * which is typically small (around 80x80 pixels).
   *
   * For full-resolution artwork extracted from the audio file, use getArtwork().
   */
  async getArtworkThumbnail(opts: GetArtworkThumbnail.Options) {
    const {deviceId, trackType, trackSlot, span} = opts;

    const tx = span
      ? span.startChild({op: 'dbGetArtwork'})
      : Telemetry.startTransaction({name: 'dbGetArtwork'});

    tx.setTag('deviceId', deviceId.toString());
    tx.setTag('trackType', getTrackTypeName(trackType));
    tx.setTag('trackSlot', getSlotName(trackSlot));

    const callOpts = {...opts, span: tx};

    const device = await this.#deviceManager.getDeviceEnsured(deviceId);
    if (device === null) {
      return null;
    }

    const strategy = this.#getTrackLookupStrategy(device, trackType);
    let artwork: Buffer | null = null;

    if (strategy === LookupStrategy.Remote) {
      artwork = await GetArtworkThumbnail.viaRemote(this.#remoteDatabase, callOpts);
    }

    if (strategy === LookupStrategy.Local) {
      artwork = await GetArtworkThumbnail.viaLocal(this.#localDatabase, device, callOpts);
    }

    if (strategy === LookupStrategy.NoneAvailable) {
      tx.setStatus(SpanStatus.Unavailable);
    }

    tx.finish();

    return artwork;
  }

  /**
   * Retrieves artwork for a track by extracting it from the audio file via NFS.
   *
   * This is the primary method for getting artwork. It reads embedded artwork
   * from the audio file (ID3 tags for MP3, metadata atoms for M4A, PICTURE
   * blocks for FLAC, etc.) using partial file reads to minimize data transfer.
   *
   * For low-resolution thumbnails from the rekordbox database, use
   * getArtworkThumbnail() instead.
   */
  async getArtwork(opts: GetArtworkFromFile.Options) {
    const {deviceId, trackSlot, span} = opts;

    const tx = span
      ? span.startChild({op: 'dbGetArtwork'})
      : Telemetry.startTransaction({name: 'dbGetArtwork'});

    tx.setTag('deviceId', deviceId.toString());
    tx.setTag('trackSlot', getSlotName(trackSlot));

    const callOpts = {...opts, span: tx};

    const device = await this.#deviceManager.getDeviceEnsured(deviceId);
    if (device === null) {
      tx.setStatus(SpanStatus.NotFound);
      tx.finish();
      return null;
    }

    const artwork = await GetArtworkFromFile.viaFileExtraction(device, callOpts);

    tx.finish();

    return artwork;
  }

  /**
   * Retrieves the waveforms for a track on a specific device slot.
   */
  async getWaveforms(opts: GetArtworkThumbnail.Options) {
    const {deviceId, trackType, trackSlot, span} = opts;

    const tx = span
      ? span.startChild({op: 'dbGetWaveforms'})
      : Telemetry.startTransaction({name: 'dbGetWaveforms'});

    tx.setTag('deviceId', deviceId.toString());
    tx.setTag('trackType', getTrackTypeName(trackType));
    tx.setTag('trackSlot', getSlotName(trackSlot));

    const callOpts = {...opts, span: tx};

    const device = await this.#deviceManager.getDeviceEnsured(deviceId);
    if (device === null) {
      return null;
    }

    const strategy = this.#getTrackLookupStrategy(device, trackType);
    let waveforms: Waveforms | null = null;

    if (strategy === LookupStrategy.Remote) {
      waveforms = await GetWaveforms.viaRemote(this.#remoteDatabase, callOpts);
    }

    if (strategy === LookupStrategy.Local) {
      waveforms = await GetWaveforms.viaLocal(this.#localDatabase, device, callOpts);
    }

    if (strategy === LookupStrategy.NoneAvailable) {
      tx.setStatus(SpanStatus.Unavailable);
    }

    tx.finish();

    return waveforms;
  }

  /**
   * Retrieves all analysis data from the EXT file for a track.
   * Returns extended cues, song structure, waveform color preview, and HD waveform.
   */
  async getTrackAnalysis(opts: GetTrackAnalysis.Options) {
    const {deviceId, trackType, trackSlot, span} = opts;

    const tx = span
      ? span.startChild({op: 'dbGetTrackAnalysis'})
      : Telemetry.startTransaction({name: 'dbGetTrackAnalysis'});

    tx.setTag('deviceId', deviceId.toString());
    tx.setTag('trackType', getTrackTypeName(trackType));
    tx.setTag('trackSlot', getSlotName(trackSlot));

    const callOpts = {...opts, span: tx};

    const device = await this.#deviceManager.getDeviceEnsured(deviceId);
    if (device === null) {
      tx.finish();
      return null;
    }

    const strategy = this.#getTrackLookupStrategy(device, trackType);
    let analysis: GetTrackAnalysis.TrackAnalysis | null = null;

    if (strategy === LookupStrategy.Local) {
      analysis = await GetTrackAnalysis.viaLocal(this.#localDatabase, device, callOpts);
    }

    if (strategy === LookupStrategy.NoneAvailable || strategy === LookupStrategy.Remote) {
      tx.setStatus(SpanStatus.Unavailable);
    }

    tx.finish();

    return analysis;
  }

  /**
   * Retrieve folders, playlists, and tracks within the playlist tree. The id
   * may be left undefined to query the root of the playlist tree.
   *
   * NOTE: You will never receive a track list and playlists or folders at the
   * same time. But the API is simpler to combine the lookup for these.
   */
  async getPlaylist(opts: GetPlaylist.Options) {
    const {deviceId, mediaSlot, span} = opts;

    const tx = span
      ? span.startChild({op: 'dbGetPlaylist'})
      : Telemetry.startTransaction({name: 'dbGetPlaylist'});

    tx.setTag('deviceId', deviceId.toString());
    tx.setTag('mediaSlot', getSlotName(mediaSlot));

    const callOpts = {...opts, span: tx};

    const device = await this.#deviceManager.getDeviceEnsured(deviceId);
    if (device === null) {
      return null;
    }

    const strategy = this.#getMediaLookupStrategy(device, mediaSlot);
    let contents: PlaylistContents | null = null;

    if (strategy === LookupStrategy.Remote) {
      contents = await GetPlaylist.viaRemote(this.#remoteDatabase, callOpts);
    }

    if (strategy === LookupStrategy.Local) {
      contents = await GetPlaylist.viaLocal(this.#localDatabase, callOpts);
    }

    if (strategy === LookupStrategy.NoneAvailable) {
      tx.setStatus(SpanStatus.Unavailable);
    }

    tx.finish();

    return contents;
  }
}

export default Database;
