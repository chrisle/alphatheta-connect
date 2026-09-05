/**
 * LocalDatabase.findTrack — database-format check (NP3-399)
 *
 * A Device Library Plus USB carries both `exportLibrary.db` (OneLibrary) and
 * the legacy `export.pdb`, whose track IDs are different number spaces. A
 * CDJ-3000 reading one while we loaded the other made every lookup resolve to
 * a different track, or to nothing. These tests drive LocalDatabase with the
 * NFS layer and both adapters mocked and check that a lookup the active
 * database cannot confirm is answered from the other file, and that the slot
 * then follows that file.
 */

jest.mock('src/nfs', () => ({fetchFile: jest.fn()}));
jest.mock('src/localdb/rekordbox', () => ({
  hydrateDatabase: jest.fn().mockResolvedValue(undefined),
  loadAnlz: jest.fn(),
}));
jest.mock('src/localdb/orm', () => ({MetadataORM: jest.fn()}));
jest.mock('onelibrary-connect', () => ({
  OneLibraryAdapter: jest.fn(),
  CueColor: {},
  HotcueButton: {},
}));
jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  writeFileSync: jest.fn(),
  unlinkSync: jest.fn(),
}));
jest.mock('src/utils/telemetry', () => {
  const span = (): any => ({
    setTag: jest.fn(),
    setData: jest.fn(),
    setStatus: jest.fn(),
    finish: jest.fn(),
    startChild: () => span(),
  });
  return {startTransaction: jest.fn(() => span()), SpanStatus: {}};
});

import {OneLibraryAdapter} from 'onelibrary-connect';

import LocalDatabase from 'src/localdb';
import {MetadataORM} from 'src/localdb/orm';
import {fetchFile} from 'src/nfs';
import {DeviceType, MediaSlot, TrackType} from 'src/types';

const mockFetchFile = fetchFile as jest.MockedFunction<typeof fetchFile>;
const MockOneLibraryAdapter = OneLibraryAdapter as unknown as jest.Mock;
const MockMetadataORM = MetadataORM as unknown as jest.Mock;

const cdj = {
  id: 3,
  name: 'CDJ-3000',
  type: DeviceType.CDJ,
  macAddr: new Uint8Array(6),
  ip: {address: '192.168.1.3'},
} as any;

const media = {
  deviceId: 3,
  slot: MediaSlot.USB,
  name: 'SSD Stream',
  color: 0,
  createdDate: new Date(0),
  freeBytes: BigInt(0),
  totalBytes: BigInt(0),
  tracksType: TrackType.RB,
  trackCount: 55378,
  playlistCount: 0,
  hasSettings: false,
} as any;

interface Row {
  id: number;
  title: string;
  tempo: number;
}

/** A database adapter holding exactly `rows`. */
function makeAdapter(type: 'oneLibrary' | 'pdb', rows: Row[]) {
  return {
    type,
    findTrack: jest.fn((id: number) => rows.find(r => r.id === id) ?? null),
    close: jest.fn(),
  };
}

/**
 * Put files on the (mocked) USB. Fetching a path not listed rejects, the way
 * NFS does for a file that is not there.
 */
function usbHolds(files: string[]) {
  mockFetchFile.mockImplementation(async ({path}: any) => {
    const present = files.some(f => path.endsWith(f));
    if (!present) {
      throw new Error(`NFS: no such file ${path}`);
    }
    return Buffer.from(path);
  });
}

function makeLocalDatabase(preference: 'auto' | 'oneLibrary' | 'pdb' = 'auto') {
  const deviceManager = {devices: new Map([[3, cdj]]), on: jest.fn()} as any;
  const statusEmitter = {queryMediaSlot: jest.fn().mockResolvedValue(media)} as any;
  return new LocalDatabase({id: 7} as any, deviceManager, statusEmitter, preference);
}

/** Number of times a database file was downloaded off the USB. */
const downloadsOf = (file: string) =>
  mockFetchFile.mock.calls.filter(([opts]: any) => opts.path.endsWith(file)).length;

beforeEach(() => {
  jest.clearAllMocks();
});

describe('LocalDatabase.findTrack (NP3-399)', () => {
  // MOH's rig, 2026-09-01: OneLibrary on the stick, but the CDJ reports IDs
  // from export.pdb — 32657 is not in exportLibrary.db at all, and 3078 is a
  // different track there.
  const oneLibraryRows: Row[] = [
    {id: 3078, title: 'Purpura - Focused (Original Mix)', tempo: 126},
    {id: 500, title: 'Only in OneLibrary', tempo: 140},
  ];
  const pdbRows: Row[] = [
    {id: 32657, title: 'The track deck 3 is playing', tempo: 128},
    {id: 3078, title: 'The track deck 5 is playing', tempo: 130},
  ];

  function stickWithBothFormats() {
    usbHolds(['exportLibrary.db', 'export.pdb']);
    MockOneLibraryAdapter.mockImplementation(() =>
      makeAdapter('oneLibrary', oneLibraryRows)
    );
    MockMetadataORM.mockImplementation(() => makeAdapter('pdb', pdbRows));
  }

  it('answers from the active database and leaves the other file alone when the row agrees', async () => {
    stickWithBothFormats();
    const local = makeLocalDatabase();

    const result = await local.findTrack(3, MediaSlot.USB, 3078, {trackBPM: 126});

    expect(result.track).toEqual(
      expect.objectContaining({title: 'Purpura - Focused (Original Mix)'})
    );
    expect(result.switchedTo).toBeNull();
    expect(downloadsOf('export.pdb')).toBe(0);
    expect(local.getDatabaseType(3, MediaSlot.USB)).toBe('oneLibrary');
  });

  it('does not question the active row when the player reports no BPM', async () => {
    stickWithBothFormats();
    const local = makeLocalDatabase();

    const result = await local.findTrack(3, MediaSlot.USB, 3078, {trackBPM: null});

    expect(result.track).toEqual(
      expect.objectContaining({title: 'Purpura - Focused (Original Mix)'})
    );
    expect(downloadsOf('export.pdb')).toBe(0);
  });

  it('loads the legacy PDB when OneLibrary has no such row, and switches the slot to it', async () => {
    stickWithBothFormats();
    const local = makeLocalDatabase();

    const result = await local.findTrack(3, MediaSlot.USB, 32657, {trackBPM: 128});

    expect(result.track).toEqual(
      expect.objectContaining({title: 'The track deck 3 is playing'})
    );
    expect(result.switchedTo).toBe('pdb');
    expect(downloadsOf('export.pdb')).toBe(1);
    expect(local.getDatabaseType(3, MediaSlot.USB)).toBe('pdb');
  });

  it('switches when the OneLibrary row exists but its BPM is not what the player shows', async () => {
    stickWithBothFormats();
    const local = makeLocalDatabase();

    // Deck 5 shows 130 BPM; OneLibrary's row 3078 is a 126 BPM track.
    const result = await local.findTrack(3, MediaSlot.USB, 3078, {trackBPM: 130});

    expect(result.track).toEqual(
      expect.objectContaining({title: 'The track deck 5 is playing'})
    );
    expect(result.switchedTo).toBe('pdb');
  });

  it('serves every later lookup from the switched database without another download', async () => {
    stickWithBothFormats();
    const local = makeLocalDatabase();

    await local.findTrack(3, MediaSlot.USB, 32657, {trackBPM: 128});
    const next = await local.findTrack(3, MediaSlot.USB, 3078, {trackBPM: 130});
    const adapter = await local.get(3, MediaSlot.USB);

    expect(next.track).toEqual(
      expect.objectContaining({title: 'The track deck 5 is playing'})
    );
    expect(next.switchedTo).toBeNull();
    expect(adapter?.type).toBe('pdb');
    expect(downloadsOf('export.pdb')).toBe(1);
    expect(downloadsOf('exportLibrary.db')).toBe(1);
  });

  it('switches back if a later track is only confirmed by the other format', async () => {
    stickWithBothFormats();
    const local = makeLocalDatabase();

    await local.findTrack(3, MediaSlot.USB, 32657, {trackBPM: 128});
    const result = await local.findTrack(3, MediaSlot.USB, 500, {trackBPM: 140});

    expect(result.track).toEqual(expect.objectContaining({title: 'Only in OneLibrary'}));
    expect(result.switchedTo).toBe('oneLibrary');
    expect(local.getDatabaseType(3, MediaSlot.USB)).toBe('oneLibrary');
  });

  it('keeps the active row when the stick has no other format to check against', async () => {
    usbHolds(['exportLibrary.db']);
    MockOneLibraryAdapter.mockImplementation(() =>
      makeAdapter('oneLibrary', oneLibraryRows)
    );
    const local = makeLocalDatabase();

    const result = await local.findTrack(3, MediaSlot.USB, 3078, {trackBPM: 130});

    expect(result.track).toEqual(
      expect.objectContaining({title: 'Purpura - Focused (Original Mix)'})
    );
    expect(result.switchedTo).toBeNull();
    expect(local.getDatabaseType(3, MediaSlot.USB)).toBe('oneLibrary');
  });

  it('reports a plain miss when neither format holds the track', async () => {
    stickWithBothFormats();
    const local = makeLocalDatabase();

    const result = await local.findTrack(3, MediaSlot.USB, 99999, {trackBPM: 120});

    expect(result.track).toBeNull();
    expect(result.adapter).not.toBeNull();
  });

  it('tries the missing file only once per stick', async () => {
    usbHolds(['exportLibrary.db']);
    MockOneLibraryAdapter.mockImplementation(() =>
      makeAdapter('oneLibrary', oneLibraryRows)
    );
    const local = makeLocalDatabase();

    await local.findTrack(3, MediaSlot.USB, 32657, {trackBPM: 128});
    await local.findTrack(3, MediaSlot.USB, 46216, {trackBPM: 124});

    // Two path spellings are tried per fetch attempt; one attempt total.
    expect(downloadsOf('export.pdb')).toBe(2);
  });

  it('does not reach for the other format when a single format is forced', async () => {
    stickWithBothFormats();
    const local = makeLocalDatabase('oneLibrary');

    const result = await local.findTrack(3, MediaSlot.USB, 32657, {trackBPM: 128});

    expect(result.track).toBeNull();
    expect(downloadsOf('export.pdb')).toBe(0);
  });

  it('reports no database for a slot with no media', async () => {
    stickWithBothFormats();
    const local = makeLocalDatabase();
    const deviceManager = {devices: new Map(), on: jest.fn()} as any;
    const empty = new LocalDatabase({id: 7} as any, deviceManager, {} as any, 'auto');

    const result = await empty.findTrack(3, MediaSlot.USB, 1, {});

    expect(result).toEqual({adapter: null, track: null, switchedTo: null});
    expect(local).toBeDefined();
  });

  it('closes both databases when the device leaves', async () => {
    stickWithBothFormats();
    const deviceManager = {devices: new Map([[3, cdj]]), on: jest.fn()} as any;
    const statusEmitter = {queryMediaSlot: jest.fn().mockResolvedValue(media)} as any;
    const local = new LocalDatabase({id: 7} as any, deviceManager, statusEmitter, 'auto');

    await local.findTrack(3, MediaSlot.USB, 32657, {trackBPM: 128});
    const active = await local.get(3, MediaSlot.USB);
    local.disconnectForDevice(cdj);

    expect(active?.close).toHaveBeenCalled();
    expect(MockOneLibraryAdapter.mock.results[0].value.close).toHaveBeenCalled();
    expect(local.getDatabaseType(3, MediaSlot.USB)).toBeNull();
  });
});
