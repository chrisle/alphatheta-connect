jest.mock('src/localdb/rekordbox', () => ({loadAnlz: jest.fn()}));
jest.mock('src/localdb', () => jest.fn());
jest.mock('onelibrary-connect', () => ({
  OneLibraryAdapter: jest.fn(),
  CueColor: {},
  HotcueButton: {},
}));

import Database from 'src/db';
import {viaLocal} from 'src/db/getMetadata';
import {loadAnlz} from 'src/localdb/rekordbox';
import {Logger} from 'src/logger';
import {DeviceType, MediaSlot, TrackType} from 'src/types';

const mockLoadAnlz = loadAnlz as jest.MockedFunction<typeof loadAnlz>;

const cdj = {
  id: 3,
  name: 'CDJ-3000',
  type: DeviceType.CDJ,
  macAddr: new Uint8Array(6),
  ip: {address: '192.168.1.3'},
} as any;

function makeLogger() {
  return {
    trace: jest.fn(),
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  } satisfies Logger;
}

/**
 * A LocalDatabase serving one slot from `adapter` (null = no database loaded),
 * answering lookups straight from it with no format switch.
 */
function makeLocal(adapter: any, switchedTo: string | null = null) {
  return {
    get: jest.fn().mockResolvedValue(adapter),
    findTrack: jest.fn(async (_deviceId: number, _slot: number, trackId: number) => {
      if (adapter === null) {
        return {adapter: null, track: null, switchedTo: null};
      }
      const track = adapter.findTrack(trackId);
      return track === null
        ? {adapter, track: null, switchedTo: null}
        : {adapter, track, switchedTo};
    }),
  } as any;
}

/** A RemoteDatabase announcing as `hostId`, answering with `track`. */
function makeRemote(hostId: number, track: unknown, conn?: unknown) {
  const queryConn = conn ?? {
    query: jest.fn().mockResolvedValue(track),
  };
  return {
    hostDevice: {id: hostId},
    get: jest.fn().mockResolvedValue(track === null ? null : queryConn),
  } as any;
}

function makeDeviceManager(device: unknown = cdj) {
  return {getDeviceEnsured: jest.fn().mockResolvedValue(device)} as any;
}

function makeOpts(overrides: Record<string, unknown> = {}) {
  return {
    deviceId: 3,
    trackSlot: MediaSlot.USB,
    trackType: TrackType.RB,
    trackId: 40492,
    ...overrides,
  } as any;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockLoadAnlz.mockResolvedValue({beatGrid: null} as any);
});

/**
 * NP3-361 (part 2) — a local miss must say which kind of miss it was.
 */
describe('getMetadata.viaLocal outcome', () => {
  it('reports no-database when the slot has no rekordbox database loaded', async () => {
    const result = await viaLocal(makeLocal(null), cdj, makeOpts());

    expect(result).toEqual({track: null, miss: 'no-database', switchedTo: null});
  });

  it('reports track-absent when the database is loaded but lacks the track', async () => {
    const adapter = {findTrack: jest.fn().mockReturnValue(null)};

    const result = await viaLocal(makeLocal(adapter), cdj, makeOpts());

    expect(result).toEqual({track: null, miss: 'track-absent', switchedTo: null});
    expect(adapter.findTrack).toHaveBeenCalledWith(40492);
  });

  it('reports no miss when the track is found', async () => {
    const adapter = {
      findTrack: jest.fn().mockReturnValue({id: 40492, title: 'Laberynth'}),
    };

    const result = await viaLocal(makeLocal(adapter), cdj, makeOpts());

    expect(result.miss).toBeNull();
    expect(result.track).toEqual(
      expect.objectContaining({id: 40492, title: 'Laberynth'})
    );
  });
});

/**
 * NP3-361 (part 1) — a local miss must not end the lookup.
 *
 * Before the fix `Database.getMetadata` ran exactly one strategy, so a CDJ
 * whose loaded database did not hold the track returned null and the DJ's
 * overlay stayed frozen on the previous track for the rest of the set.
 */
describe('Database.getMetadata local-miss fallback', () => {
  const remoteTrack = {id: 40492, title: 'From RemoteDB'};

  it('falls back to the remote database when the loaded database lacks the track', async () => {
    const adapter = {findTrack: jest.fn().mockReturnValue(null)};
    const remote = makeRemote(5, remoteTrack);
    const db = new Database(
      makeLocal(adapter),
      remote,
      makeDeviceManager(),
      makeLogger()
    );

    const track = await db.getMetadata(makeOpts());

    expect(remote.get).toHaveBeenCalledWith(3);
    expect(track).toEqual(expect.objectContaining({title: 'From RemoteDB'}));
  });

  it('falls back to the remote database when no database is loaded for the slot', async () => {
    const remote = makeRemote(5, remoteTrack);
    const db = new Database(makeLocal(null), remote, makeDeviceManager(), makeLogger());

    const track = await db.getMetadata(makeOpts());

    expect(track).toEqual(expect.objectContaining({title: 'From RemoteDB'}));
  });

  it('does not touch the remote database when the local lookup succeeds', async () => {
    const adapter = {
      findTrack: jest.fn().mockReturnValue({id: 40492, title: 'From USB'}),
    };
    const remote = makeRemote(5, remoteTrack);
    const db = new Database(
      makeLocal(adapter),
      remote,
      makeDeviceManager(),
      makeLogger()
    );

    const track = await db.getMetadata(makeOpts());

    expect(track).toEqual(expect.objectContaining({title: 'From USB'}));
    expect(remote.get).not.toHaveBeenCalled();
  });

  it('logs which kind of miss happened before falling back', async () => {
    const logger = makeLogger();
    const adapter = {findTrack: jest.fn().mockReturnValue(null)};
    const db = new Database(
      makeLocal(adapter),
      makeRemote(5, remoteTrack),
      makeDeviceManager(),
      logger
    );

    await db.getMetadata(makeOpts());

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('the loaded database holds no track with that id')
    );
  });

  describe('when the virtual CDJ is announced outside the 1-6 range', () => {
    // The announced ID never constrains remotedb metadata: the 1-6 limit
    // applies to the device-ID byte inside the remotedb messages, which
    // RemoteDatabase picks per-connection. Hardware-verified on a CDJ-3000
    // (2026-08-30, announced as VCDJ 7 throughout).
    it('still attempts the remote fallback', async () => {
      const remote = makeRemote(7, remoteTrack);
      const db = new Database(makeLocal(null), remote, makeDeviceManager(), makeLogger());

      const track = await db.getMetadata(makeOpts());

      expect(remote.get).toHaveBeenCalled();
      expect(track).toEqual(expect.objectContaining({title: 'From RemoteDB'}));
    });
  });

  it('returns null rather than throwing when the remote fallback fails', async () => {
    const logger = makeLogger();
    const remote = {
      hostDevice: {id: 5},
      get: jest.fn().mockRejectedValue(new Error('RemoteDB connection timed out')),
    } as any;
    const db = new Database(makeLocal(null), remote, makeDeviceManager(), logger);

    await expect(db.getMetadata(makeOpts())).resolves.toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('RemoteDB connection timed out')
    );
  });

  it('returns null when the remote database has no connection to the device', async () => {
    const db = new Database(
      makeLocal(null),
      makeRemote(5, null),
      makeDeviceManager(),
      makeLogger()
    );

    await expect(db.getMetadata(makeOpts())).resolves.toBeNull();
  });
});

/**
 * NP3-399 — the player's reported BPM travels with the lookup, and a database
 * switch made to answer it is logged so a field report says which file the
 * slot is being read from.
 */
describe('getMetadata database-format check (NP3-399)', () => {
  it('hands the player-reported BPM to the local lookup', async () => {
    const adapter = {
      findTrack: jest.fn().mockReturnValue({id: 32657, title: 'Focused', tempo: 126}),
    };
    const local = makeLocal(adapter);

    await viaLocal(local, cdj, makeOpts({trackId: 32657, trackBPM: 126}));

    expect(local.findTrack).toHaveBeenCalledWith(3, MediaSlot.USB, 32657, {
      trackBPM: 126,
    });
  });

  it('logs when the slot switched database format to answer', async () => {
    const logger = makeLogger();
    const adapter = {
      findTrack: jest.fn().mockReturnValue({id: 32657, title: 'Focused', tempo: 126}),
    };
    const db = new Database(
      makeLocal(adapter, 'pdb'),
      makeRemote(7, null),
      makeDeviceManager(),
      logger
    );

    const track = await db.getMetadata(makeOpts({trackId: 32657, trackBPM: 126}));

    expect(track).toEqual(expect.objectContaining({title: 'Focused'}));
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('now read from the legacy PDB database')
    );
  });

  it('passes a null BPM when the caller has none', async () => {
    const adapter = {findTrack: jest.fn().mockReturnValue({id: 1, title: 'x', tempo: 0})};
    const local = makeLocal(adapter);
    const db = new Database(
      local,
      makeRemote(7, null),
      makeDeviceManager(),
      makeLogger()
    );

    await db.getMetadata(makeOpts({trackId: 1}));

    expect(local.findTrack).toHaveBeenCalledWith(3, MediaSlot.USB, 1, {trackBPM: null});
  });
});
