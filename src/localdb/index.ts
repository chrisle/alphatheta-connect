import {Mutex} from 'async-mutex';
import {
  type DatabaseAdapter,
  type DatabasePreference,
  type DatabaseType,
  OneLibraryAdapter,
  type Track,
} from 'onelibrary-connect';
import StrictEventEmitter from 'strict-event-emitter-types';

import {createHash} from 'crypto';
import {EventEmitter} from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {MAX_CDJ_DEVICE_ID, MIN_CDJ_DEVICE_ID} from 'src/constants';
import DeviceManager from 'src/devices';
import {fetchFile, FetchProgress} from 'src/nfs';
import StatusEmitter from 'src/status';
import {
  Device,
  DeviceID,
  DeviceType,
  MediaSlot,
  MediaSlotInfo,
  TrackType,
} from 'src/types';
import {getSlotName} from 'src/utils';
import * as Telemetry from 'src/utils/telemetry';

import {MetadataORM} from './orm';
import {hydrateDatabase, HydrationProgress} from './rekordbox';

/**
 * Rekordbox databases will only exist within these two slots
 */
type DatabaseSlot = MediaSlot.USB | MediaSlot.SD;

interface CommonProgressOpts {
  /**
   * The device progress is being reported for
   */
  device: Device;
  /**
   * The media slot progress is being reported for
   */
  slot: MediaSlot;
}

type DownloadProgressOpts = CommonProgressOpts & {
  /**
   * The current progress of the fetch
   */
  progress: FetchProgress;
};

type HydrationProgressOpts = CommonProgressOpts & {
  /**
   * The current progress of the database hydration
   */
  progress: HydrationProgress;
};

type HydrationDoneOpts = CommonProgressOpts;

/**
 * Events that may be triggered  by the LocalDatabase emitter
 */
interface DatabaseEvents {
  /**
   * Triggered when we are fetching a database from a CDJ
   */
  fetchProgress: (opts: DownloadProgressOpts) => void;
  /**
   * Triggered when we are hydrating a rekordbox database into the in-memory
   * sqlite database.
   */
  hydrationProgress: (opts: HydrationProgressOpts) => void;
  /**
   * Triggered when the database has been fully hydrated.
   *
   * There is a period of time between hydrationProgress reporting 100% copletion,
   * and the database being flushed, so it may be useful to wait for this event
   * before considering the database to be fully hydrated.
   */
  hydrationDone: (opts: HydrationDoneOpts) => void;
}

type Emitter = StrictEventEmitter<EventEmitter, DatabaseEvents>;

/**
 * One loaded database file: the adapter plus the temp file backing it, if any.
 */
interface LoadedAdapter {
  /**
   * The database adapter instance (MetadataORM or OneLibraryAdapter)
   */
  adapter: DatabaseAdapter;
  /**
   * Path to temp file (for OneLibrary), needs cleanup on close
   */
  tempFile?: string;
}

interface DatabaseItem extends LoadedAdapter {
  /**
   * The uniquity identifier of the database
   */
  id: string;
  /**
   * The media device plugged into the device
   */
  media: MediaSlotInfo;
  /**
   * The CDJ the media is plugged into
   */
  device: Device;
  /**
   * The slot the media is plugged into
   */
  slot: DatabaseSlot;
  /**
   * The other database format on the same media, loaded on demand when the
   * active database disagrees with what the player reports (see
   * {@link LocalDatabase.findTrack}).
   *
   * `undefined` means it has not been tried yet; `null` means the media has no
   * such file (or it failed to load) and it will not be tried again.
   */
  alternate?: LoadedAdapter | null;
  /**
   * Serialises loading of the alternate database for this media.
   */
  alternateLock: Mutex;
}

/**
 * What the player knows about the track it is asking us to look up, used to
 * check that the row a database hands back is really that track.
 */
export interface TrackLookupHint {
  /**
   * The track's BPM as reported in the player's status packet (unpitched,
   * two decimals). `null` when the player did not report one.
   */
  trackBPM?: number | null;
}

/**
 * The outcome of {@link LocalDatabase.findTrack}.
 */
export type TrackLookup =
  | {
      /** The database that answered */
      adapter: DatabaseAdapter;
      track: Track;
      /**
       * Set when answering meant switching the slot to its other database
       * format: the type the slot is now served from.
       */
      switchedTo: DatabaseType | null;
    }
  | {
      /** The slot's database, or null when the slot has none loaded */
      adapter: DatabaseAdapter | null;
      track: null;
      switchedTo: null;
    };

/**
 * A row is only trusted when the player's reported BPM agrees with it. Either
 * side missing (unanalysed track, or a player that reports no BPM) is
 * inconclusive and counts as agreement.
 */
const trackAgreesWithPlayer = (track: Track, hint: TrackLookupHint) => {
  const reported = hint.trackBPM;
  if (reported === null || reported === undefined || !track.tempo) {
    return true;
  }

  return Math.abs(track.tempo - reported) < 0.05;
};

/**
 * Compute the identifier for media device in a CDJ. This is used to determine
 * if we have already hydrated the device or not into our local database.
 */
const getMediaId = (info: MediaSlotInfo) => {
  const inputs = [
    info.deviceId,
    info.slot,
    info.name,
    info.freeBytes,
    info.totalBytes,
    info.trackCount,
    info.createdDate,
  ];

  return createHash('sha256').update(inputs.join('.'), 'utf8').digest('hex');
};

/**
 * The local database is responsible for syncing the remote rekordbox databases
 * of media slots on a device into in-memory sqlite databases.
 *
 * This service will attempt to ensure the in-memory databases for each media
 * device that is connected to a CDJ is locally kept in sync. Fetching the
 * database for any media slot of it's not already cached.
 */
class LocalDatabase {
  #hostDevice: Device;
  #deviceManager: DeviceManager;
  #statusEmitter: StatusEmitter;
  /**
   * The EventEmitter that will report database events
   */
  #emitter: Emitter = new EventEmitter();
  /**
   * Locks for each device slot: ${device.id}-${slot}. Used when making track
   * requets.
   */
  #slotLocks = new Map<string, Mutex>();
  /**
   * The current available databases
   */
  #dbs: DatabaseItem[] = [];
  /**
   * Database format preference
   */
  #preference: DatabasePreference = 'auto';

  constructor(
    hostDevice: Device,
    deviceManager: DeviceManager,
    statusEmitter: StatusEmitter,
    preference: DatabasePreference = 'auto'
  ) {
    this.#hostDevice = hostDevice;
    this.#deviceManager = deviceManager;
    this.#statusEmitter = statusEmitter;
    this.#preference = preference;

    deviceManager.on('disconnected', this.#handleDeviceRemoved);
  }

  /**
   * Get the current database preference
   */
  get preference(): DatabasePreference {
    return this.#preference;
  }

  /**
   * Set the database preference. Only affects newly loaded databases.
   */
  set preference(value: DatabasePreference) {
    this.#preference = value;
  }

  // Bind public event emitter interface
  on: Emitter['on'] = this.#emitter.addListener.bind(this.#emitter);
  off: Emitter['off'] = this.#emitter.removeListener.bind(this.#emitter);
  once: Emitter['once'] = this.#emitter.once.bind(this.#emitter);

  /**
   * Disconnects the local database connection for the specified device
   */
  disconnectForDevice(device: Device) {
    this.#handleDeviceRemoved(device);
  }

  /**
   * Closes the database connection and removes the database entry when a
   * device is removed.
   */
  #handleDeviceRemoved = (device: Device) => {
    const db = this.#dbs.find(db => db.media.deviceId === device.id);
    if (db) {
      this.#closeLoaded(db);
      if (db.alternate) {
        this.#closeLoaded(db.alternate);
      }
    }
    this.#dbs = this.#dbs.filter(db => db.media.deviceId !== device.id);
  };

  #closeLoaded = (loaded: LoadedAdapter) => {
    loaded.adapter.close();
    // Clean up temp file if it exists (OneLibrary databases)
    if (loaded.tempFile) {
      try {
        fs.unlinkSync(loaded.tempFile);
      } catch {
        // Ignore cleanup errors
      }
    }
  };

  /**
   * Helper to fetch a file from device, trying both dotted and non-dotted paths
   */
  #fetchFileWithFallback = async (
    device: Device,
    slot: DatabaseSlot,
    basePath: string,
    tx: Telemetry.TelemetrySpan
  ): Promise<Buffer> => {
    const attemptOrder =
      process.platform === 'win32'
        ? [basePath, `.${basePath}`]
        : [`.${basePath}`, basePath];

    try {
      return await fetchFile({
        device,
        slot,
        path: attemptOrder[0],
        span: tx,
        onProgress: progress =>
          this.#emitter.emit('fetchProgress', {device, slot, progress}),
      });
    } catch {
      return fetchFile({
        device,
        slot,
        path: attemptOrder[1],
        span: tx,
        onProgress: progress =>
          this.#emitter.emit('fetchProgress', {device, slot, progress}),
      });
    }
  };

  /**
   * Try to load OneLibrary database (exportLibrary.db).
   * Returns the adapter and temp file path, or null if not available.
   */
  #tryLoadOneLibrary = async (
    device: Device,
    slot: DatabaseSlot,
    tx: Telemetry.TelemetrySpan
  ): Promise<{adapter: OneLibraryAdapter; tempFile: string} | null> => {
    const oneLibraryPath = 'PIONEER/rekordbox/exportLibrary.db';

    try {
      const dbData = await this.#fetchFileWithFallback(device, slot, oneLibraryPath, tx);

      // Write to temp file (OneLibrary requires file path for SQLCipher)
      const tempDir = os.tmpdir();
      const tempFile = path.join(
        tempDir,
        `prolink-onelibrary-${device.id}-${slot}-${Date.now()}.db`
      );
      fs.writeFileSync(tempFile, dbData);

      const adapter = new OneLibraryAdapter(tempFile);
      return {adapter, tempFile};
    } catch {
      // OneLibrary not available
      return null;
    }
  };

  /**
   * Load PDB database (export.pdb) and hydrate into MetadataORM.
   */
  #loadPdbDatabase = async (
    device: Device,
    slot: DatabaseSlot,
    tx: Telemetry.TelemetrySpan
  ): Promise<MetadataORM> => {
    const pdbPath = 'PIONEER/rekordbox/export.pdb';
    const pdbData = await this.#fetchFileWithFallback(device, slot, pdbPath, tx);

    const dbCreateTx = tx.startChild({op: 'setupDatabase'});
    const orm = new MetadataORM();
    dbCreateTx.finish();

    await hydrateDatabase({
      orm,
      pdbData,
      span: tx,
      onProgress: progress =>
        this.#emitter.emit('hydrationProgress', {device, slot, progress}),
    });

    return orm;
  };

  /**
   * Downloads and loads a database from a device.
   * Respects the database preference setting:
   * - 'auto': Try OneLibrary first, fall back to PDB
   * - 'oneLibrary': Only use OneLibrary
   * - 'pdb': Only use PDB
   */
  #hydrateDatabase = async (device: Device, slot: DatabaseSlot, media: MediaSlotInfo) => {
    const tx = Telemetry.startTransaction({name: 'hydrateDatabase'});

    tx.setTag('slot', getSlotName(media.slot));
    tx.setData('numTracks', media.trackCount.toString());
    tx.setTag('preference', this.#preference);

    let adapter: DatabaseAdapter;
    let tempFile: string | undefined;

    if (this.#preference === 'pdb') {
      // PDB only
      adapter = await this.#loadPdbDatabase(device, slot, tx);
      tx.setTag('dbType', 'pdb');
    } else if (this.#preference === 'oneLibrary') {
      // OneLibrary only
      const oneLibraryResult = await this.#tryLoadOneLibrary(device, slot, tx);
      if (!oneLibraryResult) {
        throw new Error(
          'OneLibrary database not found and preference is set to oneLibrary only'
        );
      }
      adapter = oneLibraryResult.adapter;
      tempFile = oneLibraryResult.tempFile;
      tx.setTag('dbType', 'oneLibrary');
    } else {
      // Auto: Try OneLibrary first, fall back to PDB
      const oneLibraryResult = await this.#tryLoadOneLibrary(device, slot, tx);

      if (oneLibraryResult) {
        adapter = oneLibraryResult.adapter;
        tempFile = oneLibraryResult.tempFile;
        tx.setTag('dbType', 'oneLibrary');
      } else {
        adapter = await this.#loadPdbDatabase(device, slot, tx);
        tx.setTag('dbType', 'pdb');
      }
    }

    this.#emitter.emit('hydrationDone', {device, slot});

    const db: DatabaseItem = {
      adapter,
      media,
      device,
      slot,
      id: getMediaId(media),
      tempFile,
      alternateLock: new Mutex(),
    };
    this.#dbs.push(db);

    tx.finish();

    return db;
  };

  /**
   * Loads the database format the slot is *not* currently served from, so a
   * lookup can be checked against it. Only meaningful under the 'auto'
   * preference: a forced format has no alternate. The result (or its absence)
   * is remembered so the media is never downloaded twice.
   */
  #loadAlternate = (db: DatabaseItem): Promise<LoadedAdapter | null> =>
    db.alternateLock.runExclusive(async () => {
      if (db.alternate !== undefined) {
        return db.alternate;
      }

      if (this.#preference !== 'auto') {
        db.alternate = null;
        return null;
      }

      const tx = Telemetry.startTransaction({name: 'hydrateAlternateDatabase'});
      tx.setTag('slot', getSlotName(db.media.slot));
      tx.setTag('activeDbType', db.adapter.type);

      try {
        if (db.adapter.type === 'oneLibrary') {
          const adapter = await this.#loadPdbDatabase(db.device, db.slot, tx);
          db.alternate = {adapter};
          tx.setTag('dbType', 'pdb');
        } else {
          db.alternate = await this.#tryLoadOneLibrary(db.device, db.slot, tx);
          tx.setTag('dbType', db.alternate ? 'oneLibrary' : 'none');
        }
      } catch {
        // The media simply has no such file (or it could not be read).
        db.alternate = null;
      }

      tx.finish();
      return db.alternate;
    });

  /**
   * Looks a track up in the databases of a device slot, checking the answer
   * against what the player reports.
   *
   * A Device Library Plus export carries both `exportLibrary.db` and the
   * legacy `export.pdb`, and their track IDs are different number spaces. A
   * player that reads one while we loaded the other resolves most IDs to a
   * different track and some to nothing at all (NP3-399). So when the active
   * database has no such row, or its row's BPM is not the BPM the player is
   * showing, the other format is loaded and asked. If it agrees with the
   * player, the slot switches to it for every later lookup — artwork,
   * analysis and the next track all follow the database the player is using.
   *
   * When neither database can be confirmed, the active database's row (if any)
   * is returned as before.
   */
  async findTrack(
    deviceId: DeviceID,
    slot: DatabaseSlot,
    trackId: number,
    hint: TrackLookupHint = {}
  ): Promise<TrackLookup> {
    const db = await this.#getItem(deviceId, slot);
    if (db === null) {
      return {adapter: null, track: null, switchedTo: null};
    }

    const active = db.adapter.findTrack(trackId);
    if (active !== null && trackAgreesWithPlayer(active, hint)) {
      return {adapter: db.adapter, track: active, switchedTo: null};
    }

    const alternate = await this.#loadAlternate(db);
    if (alternate !== null) {
      const other = alternate.adapter.findTrack(trackId);
      if (other !== null && trackAgreesWithPlayer(other, hint)) {
        db.alternate = {adapter: db.adapter, tempFile: db.tempFile};
        db.adapter = alternate.adapter;
        db.tempFile = alternate.tempFile;
        return {adapter: db.adapter, track: other, switchedTo: db.adapter.type};
      }
    }

    return active === null
      ? {adapter: db.adapter, track: null, switchedTo: null}
      : {adapter: db.adapter, track: active, switchedTo: null};
  }

  /**
   * Gets the database adapter for the media metadata in the provided device slot.
   *
   * If the database has not already been loaded this will first fetch and load the
   * database, which may take some time depending on the size of the database.
   *
   * @returns null if no rekordbox media present
   */
  async get(deviceId: DeviceID, slot: DatabaseSlot): Promise<DatabaseAdapter | null> {
    const db = await this.#getItem(deviceId, slot);
    return db?.adapter ?? null;
  }

  /**
   * The loaded database entry for a device slot, hydrating it first if needed.
   */
  async #getItem(deviceId: DeviceID, slot: DatabaseSlot): Promise<DatabaseItem | null> {
    const lockKey = `${deviceId}-${slot}`;
    const lock =
      this.#slotLocks.get(lockKey) ??
      this.#slotLocks.set(lockKey, new Mutex()).get(lockKey)!;

    const device = this.#deviceManager.devices.get(deviceId);
    if (device === undefined) {
      return null;
    }

    if (
      device.type !== DeviceType.CDJ ||
      device.id < MIN_CDJ_DEVICE_ID ||
      device.id > MAX_CDJ_DEVICE_ID
    ) {
      return null;
    }

    let media;
    try {
      media = await this.#statusEmitter.queryMediaSlot({
        hostDevice: this.#hostDevice,
        device,
        slot,
      });
    } catch {
      // Timeout or other error - treat as no media
      return null;
    }

    if (media.tracksType !== TrackType.RB) {
      return null;
    }

    const id = getMediaId(media);

    // Acquire a lock for this device slot that will not release until we've
    // guaranteed the existence of the database.
    const db = await lock.runExclusive(() => {
      const cached = this.#dbs.find(db => db.id === id);
      if (cached) {
        return cached;
      }
      return this.#hydrateDatabase(device, slot, media);
    });

    return db;
  }

  /**
   * Get the database type for an already-loaded device slot.
   * Returns null if no database is loaded for that device/slot.
   */
  getDatabaseType(deviceId: DeviceID, slot: DatabaseSlot): DatabaseType | null {
    const db = this.#dbs.find(
      db => db.media.deviceId === deviceId && db.media.slot === slot
    );
    return db?.adapter.type ?? null;
  }

  /**
   * Preload the databases for all connected devices.
   */
  async preload() {
    const allDevices = [...this.#deviceManager.devices.values()];
    const cdjDevices = allDevices.filter(
      device =>
        device.type === DeviceType.CDJ &&
        device.id >= MIN_CDJ_DEVICE_ID &&
        device.id <= MAX_CDJ_DEVICE_ID
    );

    if (cdjDevices.length === 0) {
      return;
    }

    const loaders = cdjDevices.map(device =>
      Promise.all([this.get(device.id, MediaSlot.USB), this.get(device.id, MediaSlot.SD)])
    );

    await Promise.all(loaders);
  }
}

export default LocalDatabase;
