import * as ip from 'ip-address';

import {PROLINK_HEADER} from 'src/constants';
import {Device} from 'src/types';

/**
 * Converts a announce packet to a device object.
 *
 * Returns null for anything that is not a complete keep-alive (0x06) packet.
 * The announce port is an ordinary UDP port that other software on the network
 * can send to, so a datagram that is not ours is ignored rather than thrown.
 */
export function deviceFromPacket(packet: Buffer) {
  if (packet.indexOf(PROLINK_HEADER) !== 0) {
    return null;
  }

  if (packet[0x0a] !== 0x06) {
    return null;
  }

  // The IP address at 0x2c is the last field read with a bounds check; a
  // packet that ends before it is truncated.
  if (packet.length < 0x30) {
    return null;
  }

  const name = packet
    .slice(0x0c, 0x0c + 20)
    .toString()
    .replace(/\0/g, '');

  const device: Device = {
    name,
    id: packet[0x24],
    type: packet[0x34],
    macAddr: new Uint8Array(packet.slice(0x26, 0x26 + 6)),
    ip: ip.Address4.fromInteger(packet.readUInt32BE(0x2c)),
  };

  return device;
}
