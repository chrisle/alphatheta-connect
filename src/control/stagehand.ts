import {PROLINK_HEADER} from 'src/constants';
import {Device} from 'src/types';
import {buildName} from 'src/utils';

/**
 * The name field of a Stagehand unicast frame: 19 bytes, one shorter than the
 * broadcast frames' 20, so the bytes that follow it sit at offset 30.
 */
function buildUnicastName(device: Device): Uint8Array {
  return buildName(device).subarray(0, 19);
}

/**
 * Generates a Stagehand transport control packet (0x07, 48 bytes).
 *
 * Byte for byte what the iPad app sends a CDJ-3000 (captured 2026-05-23,
 * `stagehand-allproto-20260523T142615.pcap`, pinned in the tests): the
 * unicast header `03 01 00`, a byte that varies per command, the length
 * `0030`, then `3a`, `01`, the opcode and the press flag each in their own
 * 16-bit slot.
 *
 * @param hostDevice - The Stagehand device posing as sender
 * @param op - The command opcode (e.g. 0x0f, 0x14, 0x18, 0x19, 0x1a, 0x1b)
 * @param press - Whether the action is press (true) or release (false)
 * @param correlationByte - The per-session correlation byte
 */
export function makeStagehandTransportPacket(
  hostDevice: Device,
  op: number,
  press: boolean,
  correlationByte: number
): Uint8Array {
  const packet = new Uint8Array(48);

  // 0-9: magic header
  packet.set(PROLINK_HEADER, 0);

  // 10: opcode 0x07
  packet[10] = 0x07;

  // 11-29: device name
  packet.set(buildUnicastName(hostDevice), 11);

  // 30-32: unicast header 03 01 00
  packet[30] = 0x03;
  packet[31] = 0x01;
  packet[32] = 0x00;

  // 33: per-session correlation byte
  packet[33] = correlationByte;

  // 34-35: packet length 0x0030 (48 bytes)
  packet[34] = 0x00;
  packet[35] = 0x30;

  // 39: Stagehand sub-id 0x3a
  packet[39] = 0x3a;

  // 41: 0x01
  packet[41] = 0x01;

  // 43: command opcode
  packet[43] = op;

  // 45: press/release flag
  packet[45] = press ? 0x01 : 0x00;

  return packet;
}

/**
 * Generates a Stagehand preference write packet (0x6b, 116 bytes).
 *
 * As captured from the iPad app (same capture as the transport packet): the
 * unicast header `03 01 00 3a`, the length `0050`, the write flag, then the
 * preference slots.
 *
 * @param hostDevice - The Stagehand device posing as sender
 * @param options - The preferences to write (onAir, quantize)
 */
export function makeStagehandPrefWritePacket(
  hostDevice: Device,
  options: {onAir?: 'on' | 'off'; quantize?: number}
): Uint8Array {
  const packet = new Uint8Array(116);

  // 0-9: magic header
  packet.set(PROLINK_HEADER, 0);

  // 10: opcode 0x6b
  packet[10] = 0x6b;

  // 11-29: device name
  packet.set(buildUnicastName(hostDevice), 11);

  // 30-32: unicast header 03 01 00
  packet[30] = 0x03;
  packet[31] = 0x01;
  packet[32] = 0x00;

  // 33: Stagehand sub-id constant 0x3a
  packet[33] = 0x3a;

  // 34-35: body length 0x0050 (80 bytes)
  packet[34] = 0x00;
  packet[35] = 0x50;

  // 36: transaction flag (0x01 = write)
  packet[36] = 0x01;

  // 44: on_air slot (0x80 = OFF, 0x81 = ON, 0x00 = untouched)
  if (options.onAir === 'on') {
    packet[44] = 0x81;
  } else if (options.onAir === 'off') {
    packet[44] = 0x80;
  }

  // 60: quantize slot (0x80 | enum_index, e.g. 0x81, 0x82 etc.)
  if (options.quantize !== undefined) {
    packet[60] = 0x80 | options.quantize;
  }

  return packet;
}
