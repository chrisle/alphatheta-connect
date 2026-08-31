import {Mutex} from 'async-mutex';
import * as ip from 'ip-address';
import PromiseSocket from 'promise-socket';

import {Socket} from 'net';

import DeviceManager from 'src/devices';
import {Device, DeviceID, DeviceType, MediaSlot, TrackType} from 'src/types';
import {TelemetrySpan as Span} from 'src/utils/telemetry';
import * as Telemetry from 'src/utils/telemetry';
import {pickRemoteDbQueryId, REMOTEDB_MAX_DEVICE_ID} from 'src/virtualcdj/device-id';

import {getMessageName, MessageType, Request, Response} from './message/types';
import {REMOTEDB_SERVER_QUERY_PORT} from './constants';
import {readField, UInt32} from './fields';
import {Message} from './message';
import {HandlerArgs, HandlerReturn, queryHandlers} from './queries';

type Await<T> = T extends PromiseLike<infer U> ? U : T;

/**
 * Menu target specifies where a menu should be "rendered" This differs based
 * on the request being made.
 */
export enum MenuTarget {
  Main = 0x01,
}

/**
 * Used to specify where to lookup data when making queries
 */
export interface QueryDescriptor {
  menuTarget: MenuTarget;
  trackSlot: MediaSlot;
  trackType: TrackType;
}

/**
 * Used internally when making queries.
 */
export type LookupDescriptor = QueryDescriptor & {
  targetDevice: Device;
  hostDevice: Device;
};

/**
 * Used to specify the query type that is being made
 */
export type Query = keyof typeof queryHandlers;
export const Query = Request;

const QueryInverse = Object.fromEntries(Object.entries(Query).map(e => [e[1], e[0]]));

/**
 * Returns a string representation of a remote query
 */
export function getQueryName(query: Query) {
  return QueryInverse[query];
}

/**
 * Options used to make a remotedb query
 */
interface QueryOpts<T extends Query> {
  queryDescriptor: QueryDescriptor;
  /**
   * The query type to make
   */
  query: T;
  /**
   * Arguments to pass to the query. These are query specific
   */
  args: HandlerArgs<T>;
  /**
   * The sentry span to associate the query with
   */
  span?: Span;
}

/**
 * Queries the remote device for the port that the remote database server is
 * listening on for requests.
 */
async function getRemoteDBServerPort(deviceIp: ip.Address4) {
  const conn = new PromiseSocket(new Socket());
  await conn.connect(REMOTEDB_SERVER_QUERY_PORT, deviceIp.address);

  // Magic request packet asking the device to report it's remoteDB port
  const data = Buffer.from([
    ...[0x00, 0x00, 0x00, 0x0f],
    ...Buffer.from('RemoteDBServer', 'ascii'),
    0x00,
  ]);

  await conn.write(data);
  const resp = await conn.read();

  if (typeof resp !== 'object') {
    throw new Error('Invalid response from remotedb');
  }

  if (resp.length !== 2) {
    throw new Error(`Expected 2 bytes, got ${resp.length}`);
  }

  return resp.readUInt16BE();
}

/**
 * Manages a connection to a single device
 */
export class Connection {
  #socket: PromiseSocket<Socket>;
  #txId = 0;
  #lock = new Mutex();

  device: Device;

  constructor(device: Device, socket: PromiseSocket<Socket>) {
    this.#socket = socket;
    this.device = device;
  }

  async writeMessage(message: Message, span: Span) {
    const tx = span.startChild({
      op: 'writeMessage',
      description: getMessageName(message.type),
    });

    message.transactionId = ++this.#txId;
    await this.#socket.write(message.buffer);
    tx.finish();
  }

  readMessage<T extends Response>(expect: T, span: Span) {
    return this.#lock.runExclusive(() => Message.fromStream(this.#socket, expect, span));
  }

  close() {
    this.#socket.destroy();
  }
}

export class QueryInterface {
  #conn: Connection;
  #hostDevice: Device;
  #lock: Mutex;

  constructor(conn: Connection, lock: Mutex, hostDevice: Device) {
    this.#conn = conn;
    this.#lock = lock;
    this.#hostDevice = hostDevice;
  }

  /**
   * Make a query to the remote database connection.
   */
  async query<T extends Query>(opts: QueryOpts<T>): Promise<Await<HandlerReturn<T>>> {
    const {query, queryDescriptor, args, span} = opts;
    const conn = this.#conn;

    const queryName = getQueryName(opts.query);

    const tx = span
      ? span.startChild({op: 'remoteQuery', description: queryName})
      : Telemetry.startTransaction({name: 'remoteQuery', description: queryName});

    const lookupDescriptor: LookupDescriptor = {
      ...queryDescriptor,
      hostDevice: this.#hostDevice,
      targetDevice: this.#conn.device,
    };

    // TODO: Figure out why typescirpt can't understand our query type discriminate
    // for args here. The interface for this actual query function discrimites just
    // fine.
    const anyArgs = args as any;

    const handler = queryHandlers[query];

    const releaseLock = await this.#lock.acquire();
    try {
      const response = await handler({conn, lookupDescriptor, span: tx, args: anyArgs});
      tx.finish();
      return response as Await<HandlerReturn<T>>;
    } finally {
      releaseLock();
    }
  }
}

/**
 * Service that maintains remote database connections with devices on the network.
 */
export default class RemoteDatabase {
  #hostDevice: Device;
  #deviceManager: DeviceManager;

  /**
   * Active device connection map
   */
  #connections = new Map<DeviceID, Connection>();
  /**
   * Locks for each device when locating the connection
   */
  #deviceLocks = new Map<DeviceID, Mutex>();
  /**
   * The device ID each connection introduced itself with. Queries on that
   * connection must carry the same ID.
   */
  #queryIds = new Map<DeviceID, DeviceID>();
  /**
   * Whether to substitute an in-range query ID when the host device sits
   * outside 1-6. Disabled only by protocol probes that need to observe how a
   * device treats the raw announced ID (see examples/remotedb-id-probe.ts).
   */
  #pickQueryId: boolean;

  constructor(
    deviceManager: DeviceManager,
    hostDevice: Device,
    {pickQueryId = true}: {pickQueryId?: boolean} = {}
  ) {
    this.#deviceManager = deviceManager;
    this.#hostDevice = hostDevice;
    this.#pickQueryId = pickQueryId;
  }

  /**
   * The device this service belongs to — the virtual CDJ announced on the
   * network. Note that this is NOT necessarily the ID carried inside remotedb
   * messages: CDJs only answer queries whose in-protocol device-ID byte is
   * 1-6, so when this device sits outside that range (announced above the
   * player range to avoid collisions), each connection picks an in-range
   * query ID via {@link pickRemoteDbQueryId} instead.
   */
  get hostDevice(): Device {
    return this.#hostDevice;
  }

  /**
   * The device ID to introduce ourselves with, and to carry in every query,
   * on a connection to the given device.
   */
  #queryIdFor(device: Device): DeviceID {
    const hostId = this.#hostDevice.id;

    // An announced ID already inside the answered range keeps working exactly
    // as it always has. Rekordbox (which numbers itself far above 6) answers
    // queries regardless, so only CDJ targets need an in-range stand-in.
    if (
      !this.#pickQueryId ||
      hostId <= REMOTEDB_MAX_DEVICE_ID ||
      device.type !== DeviceType.CDJ
    ) {
      return hostId;
    }

    return pickRemoteDbQueryId(device.id, this.#deviceManager.devices.values());
  }

  /**
   * Open a connection to the specified device for querying
   */
  connectToDevice = async (device: Device) => {
    const tx = Telemetry.startTransaction({name: 'connectRemotedb', data: {device}});

    const {ip} = device;

    const dbPort = await getRemoteDBServerPort(ip);

    const socket = new PromiseSocket(new Socket());

    // Set a connection timeout to prevent hanging forever
    (socket.stream as Socket).setTimeout(10_000);
    (socket.stream as Socket).once('timeout', () => {
      (socket.stream as Socket).destroy(
        new Error(`RemoteDB connection to ${ip.address}:${dbPort} timed out`)
      );
    });

    await socket.connect(dbPort, ip.address);

    // Send required preamble to open communications with the device
    const preamble = new UInt32(0x01);
    await socket.write(preamble.buffer);

    // Read the response. It should be a UInt32 field with the value 0x01.
    // There is some kind of problem if not.
    const data = await readField(socket, UInt32.type);

    if (data.value !== 0x01) {
      throw new Error(`Expected 0x01 during preamble handshake. Got ${data.value}`);
    }

    // Send introduction message to set context for querying
    const queryId = this.#queryIdFor(device);
    const intro = new Message({
      transactionId: 0xfffffffe,
      type: MessageType.Introduce,
      args: [new UInt32(queryId)],
    });

    await socket.write(intro.buffer);
    const resp = await Message.fromStream(socket, MessageType.Success, tx);

    if (resp.type !== MessageType.Success) {
      throw new Error(`Failed to introduce self to device ID: ${device.id}`);
    }

    // Clear socket timeout after successful connection — the per-device mutex
    // and application-level Promise.race timeouts handle query timeouts
    (socket.stream as Socket).setTimeout(0);

    this.#connections.set(device.id, new Connection(device, socket));
    this.#queryIds.set(device.id, queryId);
    tx.finish();
  };

  /**
   * Disconnect from the specified device
   */
  disconnectFromDevice = async (device: Device) => {
    const tx = Telemetry.startTransaction({name: 'disconnectFromDevice', data: {device}});

    const conn = this.#connections.get(device.id);

    if (conn === undefined) {
      return;
    }

    const goodbye = new Message({
      transactionId: 0xfffffffe,
      type: MessageType.Disconnect,
      args: [],
    });

    await conn.writeMessage(goodbye, tx);

    conn.close();
    this.#connections.delete(device.id);
    this.#queryIds.delete(device.id);
    tx.finish();
  };

  /**
   * Gets the remote database query interface for the given device.
   *
   * If we have not already established a connection with the specified device,
   * we will attempt to first connect.
   *
   * @returns null if the device does not export a remote database service
   */
  async get(deviceId: DeviceID) {
    const device = this.#deviceManager.devices.get(deviceId);
    if (device === undefined) {
      return null;
    }

    const lock =
      this.#deviceLocks.get(device.id) ??
      this.#deviceLocks.set(device.id, new Mutex()).get(device.id)!;

    const releaseLock = await lock.acquire();

    try {
      let conn = this.#connections.get(deviceId);
      if (conn === undefined) {
        await this.connectToDevice(device);
      }

      conn = this.#connections.get(deviceId)!;

      // NOTE: We pass the same lock we use for this device to the query
      // interface to ensure all query interfaces use the same lock.

      // Queries must carry the same device ID the connection introduced
      // itself with, which is not always the announced host ID.
      const queryId = this.#queryIds.get(device.id) ?? this.#hostDevice.id;

      return new QueryInterface(conn, lock, {...this.#hostDevice, id: queryId});
    } finally {
      releaseLock();
    }
  }
}
