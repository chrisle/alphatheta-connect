import {PROLINK_HEADER} from 'src/constants';
import {Device, MediaSlot, TrackType} from 'src/types';
import {buildName} from 'src/utils';

/**
 * Where the track a Load Track command names lives: the device holding the
 * media, its slot, and the track type as the player's status reports it.
 */
export interface LoadSource {
  deviceId: number;
  slot: MediaSlot;
  trackType?: TrackType;
}

/**
 * Byte length of a Load Track command.
 */
export const LOAD_TRACK_LENGTH = 0x58;

/**
 * Generates the Load Track command (0x19, 88 bytes), unicast to a player's
 * status port.
 *
 * Byte for byte what rekordbox 7.2 sends a CDJ-3000 (captured 2026-09-13 and
 * verified live on two CDJ-3000s): the status-style header with a 20-byte
 * name, `01 01`, our device number, the length `0034` of what follows, our
 * number again, then the source device, slot and track type, the track ID
 * big-endian, `32` at 0x33, the destination player counted from zero at
 * 0x40, and `32` at 0x4b.
 *
 * A player only honours the command from the address its keep-alives
 * announced and from port 50002.
 */
export function makeLoadTrackPacket(
  hostDevice: Device,
  device: Device,
  trackId: number,
  source: LoadSource
): Uint8Array {
  const packet = new Uint8Array(LOAD_TRACK_LENGTH);

  // 0-9: magic header
  packet.set(PROLINK_HEADER, 0);
  // 10: kind 0x19
  packet[10] = 0x19;
  // 11-30: device name (20 bytes)
  packet.set(buildName(hostDevice), 11);
  // 31-35: 01, subtype 01, our number, then the length 0x0034 of what follows
  packet[31] = 0x01;
  packet[32] = 0x01;
  packet[33] = hostDevice.id;
  packet[34] = 0x00;
  packet[35] = 0x34;
  // 36: our number again
  packet[36] = hostDevice.id;
  // 40-42: the source device, its slot and the track type
  packet[40] = source.deviceId;
  packet[41] = source.slot;
  packet[42] = source.trackType ?? TrackType.RB;
  // 44-47: the track ID, big-endian
  packet[44] = (trackId >>> 24) & 0xff;
  packet[45] = (trackId >>> 16) & 0xff;
  packet[46] = (trackId >>> 8) & 0xff;
  packet[47] = trackId & 0xff;
  packet[0x33] = 0x32;
  // 0x40: the player to load onto, counted from zero; a player accepts the
  // command by address regardless
  packet[0x40] = Math.max(device.id - 1, 0);
  packet[0x4b] = 0x32;

  return packet;
}
