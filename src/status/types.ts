import {DeviceID, MediaSlot, TrackType} from 'src/types';

/**
 * Status flag bitmasks (byte 0x89 of the CDJ status packet).
 *
 * Verified against CDJ-3000 firmware (EP122 FW3.20): the deck assembles this
 * byte in `sub_d7d3c8` (0xd7d3c8) from the BeatSyncMaster state struct, one
 * source boolean per bit. The bits not named here:
 *
 * - bit 0 (0x01): structurally unused — no code path ever sets it (always 0).
 * - bit 2 (0x04): a real, dedicated beat-sync boolean (struct +5), but its
 *   name did not survive in the stripped `usecase::sync` async-task code. It
 *   is normally 0, which is why it has never been observed on the wire.
 * - bit 7 (0x80): a real bit (struct +0xa) that is default-set at init and
 *   whose de-assertion itself triggers a state-change notification — best read
 *   as a "sync-master active / handoff-in-progress" toggle. Also normally 0 in
 *   steady state.
 */
export enum StatusFlag {
  /**
   * Degraded to BPM Sync: the player is still tracking the master's tempo, but
   * beat alignment was dropped after a pitch-bend / jog nudge. Firmware sources
   * this from BeatSyncMaster struct +4.
   */
  BpmSync = 1 << 1,
  OnAir = 1 << 3,
  Sync = 1 << 4,
  Master = 1 << 5,
  Playing = 1 << 6,
}

/**
 * Play state flags
 */
export enum PlayState {
  Empty = 0x00,
  Loading = 0x02,
  Playing = 0x03,
  Looping = 0x04,
  Paused = 0x05,
  Cued = 0x06,
  Cuing = 0x07,
  PlatterHeld = 0x08,
  Searching = 0x09,
  SpunDown = 0x0e,
  Ended = 0x11,
}

/**
 * Represents various details about the current state of the CDJ.
 */
export interface State {
  /**
   * The device reporting this status.
   */
  deviceId: number;
  /**
   * The ID of the track loaded on the device.
   *
   * 0 When no track is loaded.
   */
  trackId: number;
  /**
   * The device ID the track is loaded from.
   *
   * For example if you have two CDJs and you've loaded a track over the 'LINK',
   * this will be the ID of the player with the USB media device connected to it.
   */
  trackDeviceId: DeviceID;
  /**
   * The MediaSlot the track is loaded from. For example a SD card or USB device.
   */
  trackSlot: MediaSlot;
  /**
   * The TrackType of the track, for example a CD or Rekordbox analyzed track.
   */
  trackType: TrackType;
  /**
   * The current play state of the CDJ.
   */
  playState: PlayState;
  /**
   * Whether the CDJ is currently reporting itself as 'on-air'.
   *
   * This is indicated by the red ring around the platter on the CDJ Nexus models.
   * A DJM mixer must be ont he network for the CDJ to report this as true.
   */
  isOnAir: boolean;
  /**
   * Whether the CDJ is synced.
   */
  isSync: boolean;
  /**
   * Whether the CDJ has degraded into BPM Sync — still in Sync mode and
   * tracking the master's tempo, but no longer beat-aligned because the DJ used
   * pitch bend (e.g. nudged the jog wheel). Corresponds to
   * {@link StatusFlag.BpmSync} (bit 1 of byte 0x89), which older pre-nexus
   * players never set.
   */
  isBpmSync: boolean;
  /**
   * Whether the CDJ is the master player.
   */
  isMaster: boolean;
  /**
   * Whether the CDJ is in an emergency state (emergecy loop / emergency mode
   * on newer players)
   */
  isEmergencyMode: boolean;
  /**
   * The BPM of the loaded track. null if no track is loaded or the BPM is unknown.
   */
  trackBPM: number | null;
  /**
   * The pitch actually *in effect* — the value shown on the BPM display,
   * whether it comes from the local pitch fader or a synced tempo master
   * (packet Pitch1 @ 0x8c). This is the value to combine with `trackBPM` to get
   * the playing BPM. It is also what is reported when the jog wheel is nudged,
   * the platter is held, or the deck spins down on the vinyl stop knob.
   */
  effectivePitch: number;
  /**
   * The *local pitch-fader* position (packet Pitch2 @ 0x98) — always tied to
   * the physical fader, following the player's brake/release ramp as playback
   * stops or starts, regardless of any sync master.
   */
  sliderPitch: number;
  /**
   * The current beat within the measure. 1-4. 0 when no track is loaded.
   */
  beatInMeasure: number;
  /**
   * Number of beats remaining until the next cue point is reached. Null if there
   * is no next cue point
   */
  beatsUntilCue: number | null;
  /**
   * The beat 'timestamp' of the track. Can be used to compute absolute track time
   * given the slider pitch.
   */
  beat: number | null;
  /**
   * The player-type / capability byte (packet byte 0xcc, dysentery's "nx").
   *
   * This is a capability *bitfield*, not a model id. Known values: `0x05` for
   * older (pre-nexus) players, `0x0f` for nexus, and `0x1f` for the CDJ-3000
   * and XDJ-XZ (the nexus value plus bit 4). Firmware (CDJ-3000 FW3.20, one
   * 16-bit store in `sub_d858b8`) hardcodes `0x1f`. The byte is version-gated:
   * a player zeroes it toward peers advertising a Pro DJ Link protocol version
   * below 3, so a much older device on the link may report `0`.
   */
  deviceType: number;
  /**
   * A counter that increments for every status packet sent (packet byte 0xc8).
   *
   * Caveat: on the CDJ-3000 this field is hardwired to 0 — the firmware never
   * writes packet offset 0xc8 (verified: no store to the status body's +0xa4).
   * The CDJ-3000's live per-packet counter moved to its high-resolution stream
   * packet on UDP 50004 (a big-endian u32 at that packet's offset 0x28). Do not
   * rely on `packetNum` to detect liveness or drops on CDJ-3000 hardware.
   */
  packetNum: number;
}

/**
 * Absolute position information from CDJ-3000+ devices.
 * Sent every 30ms on port 50001 while a track is loaded.
 * Provides precise playhead position independent of beat grid.
 */
export interface PositionState {
  /**
   * The device ID sending this position update.
   */
  deviceId: number;
  /**
   * Track length in seconds (rounded down to nearest second).
   */
  trackLength: number;
  /**
   * Absolute playhead position in milliseconds.
   */
  playhead: number;
  /**
   * Pitch slider value as shown on screen.
   * For example, 3.26% is represented as 3.26.
   */
  pitch: number;
  /**
   * Effective BPM (track BPM adjusted by pitch) as shown on screen.
   * null if BPM is unknown.
   */
  bpm: number | null;
}

/**
 * On-Air status from DJM mixer.
 * Broadcast by the mixer to indicate which channels are currently audible.
 * Supports both 4-channel (DJM-900/1000) and 6-channel (DJM-V10) mixers.
 */
export interface OnAirStatus {
  /**
   * The mixer device ID (typically 33 / 0x21).
   */
  deviceId: number;
  /**
   * On-air flags for channels 1-4 (always present).
   * 0x00 = channel is off-air (silenced)
   * 0x01 = channel is on-air (audible)
   */
  channels: {
    1: boolean;
    2: boolean;
    3: boolean;
    4: boolean;
    5?: boolean;
    6?: boolean;
  };
  /**
   * Whether this is a 6-channel variant (CDJ-3000 + DJM-V10).
   * Determined by packet subtype (0x00 = 4-channel, 0x03 = 6-channel).
   */
  isSixChannel: boolean;
}

/**
 * State of a single mixer channel fader, EQ, trim and routing.
 */
export interface ChannelState {
  /**
   * Input Trim level (0-255).
   * Unity gain is typically 128 (0x80).
   */
  trim: number;
  /**
   * EQ High level (0-255).
   * Fully cut at 0, unity at 128 (0x80), boosted to max at 255.
   */
  eqHi: number;
  /**
   * EQ Mid level (0-255).
   * Fully cut at 0, unity at 128 (0x80), boosted to max at 255.
   */
  eqMid: number;
  /**
   * EQ Low level (0-255).
   * Fully cut at 0, unity at 128 (0x80), boosted to max at 255.
   */
  eqLow: number;
  /**
   * Color FX knob position (0-255).
   * Centered at 128 (0x80).
   */
  colorFx: number;
  /**
   * Channel fader position (0-255).
   * 0 is completely closed, 255 is maximum level.
   */
  fader: number;
  /**
   * Crossfader assignment.
   */
  crossfaderAssign: 'thru' | 'A' | 'B';
}

/**
 * Full mixer control state parsed from Stagehand unicast status (0x39 packets).
 */
export interface MixerState {
  /**
   * The reporting device ID (typically 33).
   */
  deviceId: number;
  /**
   * Device name reported by the mixer (e.g. "DJM-A9").
   */
  deviceName: string;
  /**
   * State of mixer channels (1-4).
   */
  channels: Record<number, ChannelState>;
  /**
   * Crossfader position (0-255).
   * 0 is full-left (A), 255 is full-right (B).
   */
  crossfader: number;
}

/**
 * A single audio VU level frame.
 */
export interface VUFrame {
  /**
   * Left channel level (0-65535).
   */
  left: number;
  /**
   * Right channel level (0-65535).
   */
  right: number;
}

/**
 * Real-time sliding window audio level VU data parsed from Stagehand unicast packets (0x58).
 */
export interface VUState {
  /**
   * The reporting device ID (typically 33).
   */
  deviceId: number;
  /**
   * Array of 15 sliding window stereo VU level frames per channel (1-4).
   */
  channels: Record<number, VUFrame[]>;
}
