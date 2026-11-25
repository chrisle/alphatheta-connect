import {PROLINK_HEADER} from 'src/constants';
import {Device} from 'src/types';
import {buildName} from 'src/utils';
import {encodeStagehandNumber} from 'src/virtualcdj/stagehand';

/**
 * The name field of a Stagehand unicast frame: 19 bytes, one shorter than the
 * broadcast frames' 20, so the bytes that follow it sit at offset 30.
 */
function buildUnicastName(device: Device): Uint8Array {
  return buildName(device).subarray(0, 19);
}

/**
 * The command word at the start of a Stagehand command packet's body.
 */
export enum StagehandCommand {
  /** Key events: buttons pressed or released on the player. */
  Keys = 0,
  /**
   * The sender takes control. A player obeys key events from a device number
   * only after a connect frame from it.
   */
  Connect = 1,
  /** The sender lets go. */
  Disconnect = 2,
}

/**
 * The key numbers of a Stagehand key event (packet 0x07, {@link
 * StagehandCommand.Keys}).
 *
 * Only `PlayPause` is confirmed on hardware, from a Mac to two CDJ-3000s on
 * firmware 3.22 (one of them also on stock firmware), and `SkipBackward`
 * moved a player's playhead there as well. The others are the buttons the
 * player's firmware maps those numbers to, read from the firmware and not
 * tried on hardware. `SeekForward`, `SeekBackward` and the skips are also what
 * the iPad app was captured sending.
 */
export const StagehandKey = {
  /** From the firmware: the QUANTIZE button. */
  Quantize: 0x0a,
  /** From the firmware: SLIP. */
  Slip: 0x0b,
  /** From the firmware: MASTER. */
  Master: 0x0c,
  /** From the firmware: SYNC. */
  Sync: 0x0d,
  /** From the firmware: MASTER TEMPO. */
  MasterTempo: 0x0e,
  /** From the firmware: tempo reset. The app sends it just before PlayPause. */
  TempoReset: 0x0f,
  /**
   * One toggle: a press starts a stopped player and stops a playing one, there
   * is no separate pause. It acts on the press.
   */
  PlayPause: 0x14,
  /**
   * From the firmware: CUE. Pressed on a playing player it showed no change in
   * the status; why is not known.
   */
  Cue: 0x15,
  /** From the firmware: REVERSE. */
  Reverse: 0x16,
  /** From the firmware: SLIP REVERSE. */
  SlipReverse: 0x17,
  /** Track search (the app's skip forward). The direction is the app's, not confirmed. */
  SkipForward: 0x18,
  /** Track search (the app's skip backward). Moved a player off the end of its track. */
  SkipBackward: 0x19,
  /** Search forward, held while pressed. */
  SeekForward: 0x1a,
  /** Search backward, held while pressed. */
  SeekBackward: 0x1b,
  /** From the firmware: loop in. */
  LoopIn: 0x1e,
  /** From the firmware: loop out. */
  LoopOut: 0x1f,
  /** From the firmware: reloop / exit. */
  Reloop: 0x20,
} as const;

/**
 * Generates a Stagehand command packet (0x07).
 *
 * The iPad app's packet to a CDJ-3000 (captured 2026-05-23,
 * `stagehand-allproto-20260523T142615.pcap`, pinned in the tests): the
 * unicast header `03 01 00`, the sender's device number in byte 33 (encoded,
 * see {@link encodeStagehandNumber}; this is the byte that looked like a
 * per-command value), the total length at 34, then the body: 16-bit command,
 * 16-bit device number, 16-bit count and `count` entries of 16-bit key,
 * 8-bit kind (0), 8-bit state (1 pressed, 0 released) and 16-bit value (0).
 *
 * @param hostDevice - The Stagehand device posing as sender
 * @param command - What the packet is (key events, connect or disconnect)
 * @param key - For key events, the one key and whether it is pressed
 */
function makeStagehandCommandPacket(
  hostDevice: Device,
  command: StagehandCommand,
  key?: {key: number; press: boolean}
): Uint8Array {
  const packet = new Uint8Array(key === undefined ? 42 : 48);
  const view = new DataView(packet.buffer);

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

  // 34-35: packet length
  view.setUint16(34, packet.length);

  // 36-41: command, device number, number of keys
  view.setUint16(36, command);
  view.setUint16(38, hostDevice.id);
  view.setUint16(40, key === undefined ? 0 : 1);

  // 42-47: the key, kind 0, state, value 0
  if (key !== undefined) {
    view.setUint16(42, key.key);
    packet[45] = key.press ? 0x01 : 0x00;
  }

  // 33: our device number, last, since the packet's bytes are in its checksum
  encodeStagehandNumber(packet, 33, hostDevice.id, hostDevice.macAddr);

  return packet;
}

/**
 * Generates a Stagehand key packet: one key pressed or released.
 *
 * @param hostDevice - The Stagehand device posing as sender
 * @param key - The key number, see {@link StagehandKey}
 * @param press - Whether the action is press (true) or release (false)
 */
export function makeStagehandTransportPacket(
  hostDevice: Device,
  key: number,
  press: boolean
): Uint8Array {
  return makeStagehandCommandPacket(hostDevice, StagehandCommand.Keys, {key, press});
}

/**
 * Generates the packet that opens (or closes) a Stagehand's control of a
 * player (0x07, 42 bytes). A player ignores key events from a device number
 * that has not sent one.
 *
 * @param hostDevice - The Stagehand device posing as sender
 * @param connect - true to connect, false to disconnect
 */
export function makeStagehandConnectPacket(
  hostDevice: Device,
  connect = true
): Uint8Array {
  return makeStagehandCommandPacket(
    hostDevice,
    connect ? StagehandCommand.Connect : StagehandCommand.Disconnect
  );
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

  // 33: our device number, sent plain
  packet[33] = hostDevice.id;

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
