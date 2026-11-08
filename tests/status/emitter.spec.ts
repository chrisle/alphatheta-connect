import {Socket} from 'dgram';
import {EventEmitter} from 'events';

import {PROLINK_HEADER} from 'src/constants';
import StatusEmitter from 'src/status';

function makeEmitter() {
  const socket = new EventEmitter();
  const emitter = new StatusEmitter(socket as unknown as Socket);
  return {socket, emitter};
}

describe('StatusEmitter', () => {
  it('ignores a datagram on the status port that is not a Pro DJ Link packet', () => {
    const {socket, emitter} = makeEmitter();
    const statuses = jest.fn();
    emitter.on('status', statuses);

    // Any app on the network can send one; it must not crash the process.
    expect(() => socket.emit('message', Buffer.from('hello'))).not.toThrow();
    expect(statuses).not.toHaveBeenCalled();
  });

  it('ignores a status-sized packet too short to hold the packet counter', () => {
    const {socket, emitter} = makeEmitter();
    const statuses = jest.fn();
    emitter.on('status', statuses);

    const packet = Buffer.alloc(0xca);
    Buffer.from(PROLINK_HEADER).copy(packet);

    expect(() => socket.emit('message', packet)).not.toThrow();
    expect(statuses).not.toHaveBeenCalled();
  });
});
