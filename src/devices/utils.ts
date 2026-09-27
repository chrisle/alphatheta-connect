import * as ip from 'ip-address';

import {PROLINK_HEADER} from 'src/constants';
import {Device} from 'src/types';

/**
 * Converts a announce packet to a device object.
 *
 * Returns null for any packet that is not a stage-3 Pro DJ Link announce. The
 * announce socket receives every UDP broadcast on its port, so foreign traffic
 * (other apps, other protocols) is normal and must be ignored, not treated as
 * an error.
 */
export function deviceFromPacket(packet: Buffer) {
  if (packet.indexOf(PROLINK_HEADER) !== 0) {
    return null;
  }

  if (packet[0x0a] !== 0x06) {
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
