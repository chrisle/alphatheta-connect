jest.mock('src/localdb/rekordbox', () => ({loadAnlz: jest.fn()}));
jest.mock('onelibrary-connect', () => ({
  OneLibraryAdapter: jest.fn(),
  CueColor: {},
  HotcueButton: {},
}));

import {Mutex} from 'async-mutex';
import PromiseReadable from 'promise-readable';
import {ReadableStreamBuffer} from 'stream-buffers';

import {viaRemote} from 'src/db/getMetadata';
import {Logger} from 'src/logger';
import {Connection, QueryInterface} from 'src/remotedb';
import * as Field from 'src/remotedb/fields';
import {Message} from 'src/remotedb/message';
import {Request, Response} from 'src/remotedb/message/types';
import {MediaSlot, TrackType} from 'src/types';

import {mockDevice} from '../utils';

/**
 * These tests replay a player's remotedb answers as raw wire bytes through a
 * real Connection, so every item goes through the same parsing a live player's
 * response does.
 *
 * Slot 15 is what an XDJ-AZ reported for Beatport Streaming in NP3-416: the
 * player answered, but nothing it sent became a title or an artist.
 */

const XDJ_AZ_STREAMING_SLOT = 0x0f as MediaSlot;

const ItemTypeCode = {
  Path: 0x0000,
  TrackTitle: 0x0004,
  Artist: 0x0007,
  Duration: 0x000b,
  Unregistered: 0x0099,
};

function makeLogger() {
  return {
    trace: jest.fn(),
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  } satisfies Logger;
}

function success(request: Request, itemsAvailable: number) {
  return new Message({
    type: Response.Success,
    args: [new Field.UInt32(request), new Field.UInt32(itemsAvailable)],
  });
}

function menuItem(type: number, {label1 = '', label2 = '', mainId = 0} = {}) {
  return new Message({
    type: Response.MenuItem,
    args: [
      new Field.UInt32(0),
      new Field.UInt32(mainId),
      new Field.UInt32((label1.length + 1) * 2),
      new Field.String(label1),
      new Field.UInt32((label2.length + 1) * 2),
      new Field.String(label2),
      new Field.UInt32(type),
      new Field.UInt32(0),
      new Field.UInt32(0),
      new Field.UInt32(0),
      new Field.UInt32(0),
      new Field.UInt32(0),
    ],
  });
}

/** A full menu answer: the success header, then the items in one page. */
function menu(request: Request, items: Message[]) {
  if (items.length === 0) {
    return [success(request, 0)];
  }

  return [
    success(request, items.length),
    new Message({type: Response.MenuHeader, args: []}),
    ...items,
    new Message({type: Response.MenuFooter, args: []}),
  ];
}

/**
 * A RemoteDatabase whose connection to the player replays `responses` in
 * order, byte for byte.
 */
function replayingRemote(responses: Message[]) {
  const wire = new ReadableStreamBuffer();
  for (const message of responses) {
    wire.put(message.buffer);
  }
  wire.stop();

  const reader = new PromiseReadable(wire);
  const socket = {
    read: (bytes: number) => reader.read(bytes),
    write: jest.fn().mockResolvedValue(undefined),
  };

  const player = mockDevice({id: 1, name: 'XDJ-AZ'});
  const conn = new Connection(player, socket as any);
  const query = new QueryInterface(conn, new Mutex(), mockDevice({id: 2}));

  return {get: jest.fn().mockResolvedValue(query)} as any;
}

const streamingTrack = {
  deviceId: 1,
  trackSlot: XDJ_AZ_STREAMING_SLOT,
  trackType: TrackType.Streaming,
  trackId: 119,
  trackBPM: null,
  span: undefined as any,
};

describe('viaRemote on a lookup that comes back without a title or artist', () => {
  it('reports that the player sent no items at all', async () => {
    const remote = replayingRemote([
      ...menu(Request.GetMetadata, []),
      ...menu(Request.GetTrackInfo, []),
    ]);
    const logger = makeLogger();

    const track = await viaRemote(remote, streamingTrack, logger);

    expect(track?.title).toBe('');
    expect(track?.artist).toBeNull();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toBe(
      'Device 1 answered the metadata query for track 119 (slot 15 unknown, ' +
        'type 6 streaming) with no title or artist: 0 of 0 item(s) received; ' +
        'track info: failed (Player sent no file path (0 item(s) available))'
    );
  });

  it('reports the raw fields of item types the Track has no place for', async () => {
    const remote = replayingRemote([
      ...menu(Request.GetMetadata, [
        menuItem(ItemTypeCode.Unregistered, {label1: 'Dancing', label2: 'Bittermind'}),
        menuItem(ItemTypeCode.Duration, {mainId: 300}),
      ]),
      ...menu(Request.GetTrackInfo, []),
    ]);
    const logger = makeLogger();

    await viaRemote(remote, streamingTrack, logger);

    const report = logger.warn.mock.calls[0][0] as string;
    expect(report).toContain('2 of 2 item(s) received');
    expect(report).toContain(
      '0x0099 {"parentId":0,"mainId":0,"label1":"Dancing","label2":"Bittermind","artworkId":0}'
    );
    expect(report).toContain('0x000b {"duration":300}');
  });

  it('shortens an oversized item so the report stays readable', async () => {
    const remote = replayingRemote([
      ...menu(Request.GetMetadata, [
        menuItem(ItemTypeCode.Unregistered, {label1: 'x'.repeat(500)}),
      ]),
      ...menu(Request.GetTrackInfo, []),
    ]);
    const logger = makeLogger();

    await viaRemote(remote, streamingTrack, logger);

    const report = logger.warn.mock.calls[0][0] as string;
    const item = report.split('; ')[1];
    expect(item).toHaveLength(201);
    expect(item.endsWith('…')).toBe(true);
  });
});

describe('viaRemote on a streaming track the player describes in full', () => {
  it('reads the title, artist and Beatport path without reporting anything', async () => {
    const remote = replayingRemote([
      ...menu(Request.GetMetadata, [
        menuItem(ItemTypeCode.TrackTitle, {label1: 'Automatic Love', mainId: 2}),
        menuItem(ItemTypeCode.Artist, {label1: 'Fury Weekend', mainId: 7}),
      ]),
      ...menu(Request.GetTrackInfo, [
        menuItem(ItemTypeCode.Path, {label1: '/26883657.m4a'}),
      ]),
    ]);
    const logger = makeLogger();

    const track = await viaRemote(
      remote,
      {...streamingTrack, trackSlot: MediaSlot.Beatport, trackId: 2},
      logger
    );

    expect(track?.title).toBe('Automatic Love');
    expect(track?.artist?.name).toBe('Fury Weekend');
    expect(track?.filePath).toBe('/26883657.m4a');
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
