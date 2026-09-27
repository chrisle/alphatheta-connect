let mockQueryPort = 0;

jest.mock('src/remotedb/constants', () => ({
  ...jest.requireActual('src/remotedb/constants'),
  get REMOTEDB_SERVER_QUERY_PORT() {
    return mockQueryPort;
  },
}));

import * as ip from 'ip-address';

import {AddressInfo, createServer, Server, Socket} from 'net';

import RemoteDatabase from 'src/remotedb';
import {UInt32} from 'src/remotedb/fields';
import {Message} from 'src/remotedb/message';
import {MessageType, Response} from 'src/remotedb/message/types';

import {mockDevice} from '../utils';

/**
 * These tests run a real RemoteDatabase against a player's remote database
 * served on localhost, so a connection the player closes behaves exactly like
 * one a real player closes.
 *
 * In NP3-445 a player closed its end of the connection. Every query after that
 * failed with "write after end" until the whole network was restarted, and
 * disconnecting from the player failed the same way.
 */

interface PlayerConnection {
  socket: Socket;
  /**
   * Everything the client sent after the handshake
   */
  received: Buffer[];
  /**
   * Settles once both ends of the connection are closed
   */
  closed: Promise<void>;
}

function listen(server: Server) {
  return new Promise<number>(resolve =>
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port))
  );
}

function close(server: Server) {
  return new Promise<void>(resolve => server.close(() => resolve()));
}

/**
 * The remote database of a single player. It tells the client which port the
 * database listens on, answers the handshake, and keeps whatever the client
 * sends after that.
 */
class FakePlayer {
  readonly connections: PlayerConnection[] = [];

  #sockets = new Set<Socket>();
  #dbPort = 0;

  #queryServer = createServer(socket => {
    this.#track(socket);

    socket.once('data', () => {
      const port = Buffer.alloc(2);
      port.writeUInt16BE(this.#dbPort);
      socket.end(port);
    });
  });

  #dbServer = createServer(socket => {
    this.#track(socket);

    const connection: PlayerConnection = {
      socket,
      received: [],
      closed: new Promise(resolve => socket.once('close', () => resolve())),
    };
    this.connections.push(connection);

    let step = 0;

    socket.on('data', data => {
      switch (step++) {
        case 0:
          // The preamble, which the player answers in kind
          socket.write(new UInt32(0x01).buffer);
          break;

        case 1:
          // The client introducing itself
          socket.write(
            new Message({
              transactionId: 0xfffffffe,
              type: Response.Success,
              args: [new UInt32(0), new UInt32(0)],
            }).buffer
          );
          break;

        default:
          connection.received.push(data);
      }
    });
  });

  #track(socket: Socket) {
    this.#sockets.add(socket);
    socket.on('error', () => null);
    socket.once('close', () => this.#sockets.delete(socket));
  }

  async start() {
    this.#dbPort = await listen(this.#dbServer);
    mockQueryPort = await listen(this.#queryServer);
  }

  /**
   * Closes the player's end of every open connection, as a player does when
   * it restarts, and waits for the client to close its end too.
   */
  async hangUp() {
    const open = this.connections.filter(conn => !conn.socket.destroyed);
    open.forEach(conn => conn.socket.end());

    await Promise.all(open.map(conn => conn.closed));
  }

  async stop() {
    this.#sockets.forEach(socket => socket.destroy());
    await Promise.all([close(this.#queryServer), close(this.#dbServer)]);
  }
}

/**
 * The goodbye a client sends. It carries the connection's next transaction ID,
 * which is 1 when nothing else was sent on the connection.
 */
const goodbye = (transactionId: number) =>
  new Message({transactionId, type: MessageType.Disconnect, args: []}).buffer;

describe('RemoteDatabase connections', () => {
  const device = mockDevice({ip: new ip.Address4('127.0.0.1')});

  let player: FakePlayer;
  let remotedb: RemoteDatabase;

  beforeEach(async () => {
    player = new FakePlayer();
    await player.start();

    const deviceManager = {devices: new Map([[device.id, device]])};
    remotedb = new RemoteDatabase(deviceManager as any, mockDevice({id: 5}));
  });

  afterEach(() => player.stop());

  it('reuses the connection to a player while it stays open', async () => {
    await remotedb.get(device.id);
    await remotedb.get(device.id);

    expect(player.connections).toHaveLength(1);
  });

  it('opens a new connection once the player has closed the old one', async () => {
    await remotedb.get(device.id);
    await player.hangUp();

    await remotedb.get(device.id);
    expect(player.connections).toHaveLength(2);

    // The new connection reaches the player
    await remotedb.disconnectFromDevice(device);
    await player.connections[1].closed;

    expect(Buffer.concat(player.connections[1].received)).toEqual(goodbye(1));
  });

  it('disconnects from a player that has already closed the connection', async () => {
    await remotedb.get(device.id);
    await player.hangUp();

    await expect(remotedb.disconnectFromDevice(device)).resolves.toBeUndefined();

    // Nothing of the old connection is left behind
    await remotedb.get(device.id);
    expect(player.connections).toHaveLength(2);
  });

  it('says goodbye to a player before closing the connection', async () => {
    await remotedb.get(device.id);
    await remotedb.disconnectFromDevice(device);
    await player.connections[0].closed;

    expect(Buffer.concat(player.connections[0].received)).toEqual(goodbye(1));
  });
});
