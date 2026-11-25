# Pioneer Stagehand Connection Mode

This document describes how to use the Stagehand connection mode in `alphatheta-connect` to actively join the Pro DJ Link network as a virtual iPad running Pioneer DJ's Stagehand app. This mode unlocks advanced features including rich telemetry monitoring (mixer faders, EQ values, high-frequency VU levels) and direct remote control over CDJ playback and mixer preferences.

---

## 1. Overview

Pioneer DJ's Stagehand is a mobile application used by front-of-house crew to monitor DJ gear (CDJs and mixers) on the network.

By posing as a Stagehand iOS device on the network, `alphatheta-connect` can:

1. Receive **high-frequency per-channel mixer state** pushes (faders, EQ knobs, trim, crossfader).
2. Receive **ultra-low-latency real-time VU level samples** directly from the mixer.
3. Perform **CDJ remote control** (play, pause, seek forward/backward, track skip).
4. Perform **CDJ/Mixer preference writes** (on-air display toggles, quantize value changes).

---

## 2. Connecting in Stagehand Mode

To connect to the network in Stagehand mode, configure the `connectMethod` option to `'stagehand'` when initializing or configuring your Prolink network.

```typescript
import {bringOnline} from 'alphatheta-connect';

async function main() {
  // Bring the network online with Stagehand configuration
  const network = await bringOnline({
    connectMethod: 'stagehand',
    vcdjName: 'Stagehand-Control', // Custom virtual iPad name
  });

  // Autoconfigure interface from peers (the Stagehand device number is 0x3a)
  await network.autoconfigFromPeers();

  // Connect to start the Stagehand abbreviated handshake
  network.connect();

  console.log('Connected to network posing as Stagehand client!');
}
```

The device number is `0x3a` (58), the one the iPad app uses. Set `vcdjId` to use another from `0x36` to `0x3f` (54 to 63); players take no other number from a Stagehand, and `connect()` refuses one outside that range. See [6.3](#63-how-a-player-accepts-a-stagehand) for why the number matters.

---

## 3. Telemetry Events (Monitoring)

Once connected, Stagehand telemetry is received on ports `50001` (VU levels) and `50002` (mixer fader positions).

### 3.1 Mixer State (Fader & EQ Positions)

The mixer (such as DJM-A9 or DJM-V10) pushes physical knob and fader positions approximately 4 times per second to port `50002`. This is surfaced via the `'mixerState'` event on `StatusEmitter`.

```typescript
network.statusEmitter.on('mixerState', mixerState => {
  console.log(`Mixer State from ${mixerState.deviceName} (ID: ${mixerState.deviceId}):`);
  console.log(`  Crossfader: ${mixerState.crossfader}`);

  for (const [ch, state] of Object.entries(mixerState.channels)) {
    console.log(`  Channel ${ch}:`);
    console.log(`    Trim: ${state.trim}`);
    console.log(`    EQ Hi: ${state.eqHi} | Mid: ${state.eqMid} | Low: ${state.eqLow}`);
    console.log(`    Color FX: ${state.colorFx}`);
    console.log(`    Fader: ${state.fader}`);
    console.log(`    Crossfader Assign: ${state.crossfaderAssign}`);
  }
});
```

### 3.2 Real-Time Audio VU Levels

The mixer pushes real-time VU level sample streams on port `50001` approximately 30 times per second for visual meter rendering. This is surfaced via the `'vu'` event on `PositionEmitter`.

```typescript
network.positionEmitter.on('vu', vu => {
  console.log(`VU Levels for Mixer (ID: ${vu.deviceId}):`);

  for (const [ch, frames] of Object.entries(vu.channels)) {
    // Each channel contains a sliding-window array of 15 stereo frames (16-bit uint values)
    const latestFrame = frames[frames.length - 1];
    console.log(
      `  Channel ${ch} - Latest VU -> Left: ${latestFrame.left}, Right: ${latestFrame.right}`
    );
  }
});
```

---

## 4. Remote Control (Writing States)

When connected in Stagehand mode, the `network.control` service automatically utilizes the Stagehand protocol (`0x07` transport commands and `0x6b` preference writes) to control devices.

### 4.1 Transport Commands

The transport control commands target port `50001` of the destination CDJ device. A player obeys them only after a connect frame from the sender's device number, which `Control` sends before the first key to each player and takes back (a disconnect frame) when the network disconnects. `control.connect(device)` sends it again, for a player that was restarted.

#### 4.1.1 Play & Pause

A Stagehand has one PLAY/PAUSE key, and it toggles: pressed on a stopped player it starts it, pressed on a playing one it stops it. There is no separate pause. The library goes by the status the player last reported and presses the key only when that changes something:

```typescript
// Presses PLAY/PAUSE unless the player is playing (or looping) already
await network.control.play(cdjDevice);

// Presses it only if the player is playing
await network.control.pause(cdjDevice);

// Playing means play(); anything else means pause()
await network.control.setPlayState(cdjDevice, CDJStatus.PlayState.Playing);
await network.control.setPlayState(cdjDevice, CDJStatus.PlayState.Cued);

// Presses and releases the key, whatever the state
await network.control.togglePlayPause(cdjDevice);
```

`play()` and `pause()` throw until the player has reported a status, because a blind press could do the opposite of what was asked. The state is the last status received, so two calls in quick succession may both see the old one.

#### 4.1.2 Seek & Search (Jog-wheel seek)

Simulate continuous search forward and search backward holding:

```typescript
// Start seek forward
await network.control.seekForward(cdjDevice, true);

// Stop seek forward (release)
await network.control.seekForward(cdjDevice, false);

// Start seek backward
await network.control.seekBackward(cdjDevice, true);

// Stop seek backward (release)
await network.control.seekBackward(cdjDevice, false);
```

#### 4.1.3 Track Skip

Simulate skip forward button presses:

```typescript
// Initiate skip press
await network.control.skip(cdjDevice, true);

// Release skip
await network.control.skip(cdjDevice, false);
```

#### 4.1.4 Other keys

`control.transport(device, key, press)` sends any key; `StagehandKey` names the ones known. Only `PlayPause` is confirmed on hardware, and `SkipBackward` (it moved a player's playhead). The rest are the buttons the player's firmware (3.22) maps those numbers to, read from the firmware and not tried on hardware. `SeekForward`, `SeekBackward` and the skips are also what the iPad app was captured sending.

| Key | Number | Button |
| --- | --- | --- |
| `Quantize` | `0x0a` | QUANTIZE |
| `Slip` | `0x0b` | SLIP |
| `Master` | `0x0c` | MASTER |
| `Sync` | `0x0d` | SYNC |
| `MasterTempo` | `0x0e` | MASTER TEMPO |
| `TempoReset` | `0x0f` | tempo reset (the app sends it just before `PlayPause`) |
| `PlayPause` | `0x14` | PLAY/PAUSE (**tested**) |
| `Cue` | `0x15` | CUE (pressed on a playing player it showed no change in the status; why is not known) |
| `Reverse` | `0x16` | REVERSE |
| `SlipReverse` | `0x17` | SLIP REVERSE |
| `SkipForward` / `SkipBackward` | `0x18` / `0x19` | track search (`SkipBackward` **tested**; the directions are the app's naming) |
| `SeekForward` / `SeekBackward` | `0x1a` / `0x1b` | search, held while pressed |
| `LoopIn` / `LoopOut` | `0x1e` / `0x1f` | loop in / out |
| `Reloop` | `0x20` | reloop / exit |

---

### 4.2 Preference Writes

Configure equipment settings directly from the virtual Stagehand client by transmitting `0x6b` (124-byte) preference write packets to port `50002` on the destination CDJ.

```typescript
// Toggle On-Air display mode to ON
await network.control.setPreference(cdjDevice, {onAir: 'on'});

// Toggle On-Air display mode to OFF
await network.control.setPreference(cdjDevice, {onAir: 'off'});

// Toggle quantize value change (value is set as 0x80 | enum_index)
await network.control.setPreference(cdjDevice, {quantize: 1}); // Quantize index 1
```

---

## 5. Example: Stagehand Monitor CLI

`examples/stagehand-monitor.ts` joins the network as a Stagehand device and prints every event the library surfaces (device announcements, player status, media slots, on-air flags, mixer state, VU, position), with a periodic summary of packet rates. It also drives a player over the Stagehand control protocol, from single keys on a TTY or one command per line on a pipe, so the write side can be exercised against real or emulated hardware.

```bash
yarn build-examples
node lib/examples/stagehand-monitor.js --iface en0            # interactive
printf 'play\n' | node lib/examples/stagehand-monitor.js --player 1   # scripted
node lib/examples/stagehand-monitor.js --json --quiet > events.jsonl
```

See the header comment in the file for the full option and command list.

## 6. API Compatibility

To preserve backwards-compatibility and maintain documentation integrity:

- Existing active (`vcdjId` < 7) and passive modes remain fully supported and completely untouched.
- `network.control.setPlayState(device, state)` works out-of-the-box regardless of your connection mode, automatically translating state mappings into correct network packets.

---

## 6. Real Hardware Testing Notes (contributed)

> Captured from a CDJ-3000 (player 4, firmware 3.18) with the official Stagehand
> iPad app as baseline, using layer-2 MAC takeover for unicast capture. Section
> 6.3 and the corrections marked below come from a later check on two CDJ-3000s
> and a DJM-A9 on firmware 3.22.

### 6.1 Observed vs. real Stagehand traffic

Running the Stagehand connection mode against real hardware, the CDJ silently
ignored the 0x07 transport commands. The official app sends several packet types
that the library did not at the time. None of them is what the player was
waiting for (see 6.3); they are listed because they are what the app sends:

- **0x68 registration report** (36B, every 2s, unicast to CDJ:50002 + broadcast).
  Layout (0-based): `header | 0x68 | name19B | [30]=target player num | 01 00 | [33]=sender's number (0x3a) | 00 00`.
  The library sends it, always with 03 at 30, to every player; both of the two
  players tried answered it.
- **0x3c state-sync request** (36B -> 50002; identical to 0x68 except [31]=0x01).
  Sent when the app enters the WAVEFORM screen. A player answered one with a
  2,564-byte `0x3d`. After the iPad screen sleeps and wakes, control is ignored
  by the CDJ until this packet is sent and the waveform reloads — then control
  works again. (On 3.22 a connect frame and keys worked without one; that was
  not tried after a long idle.)
- **0x55 state-report sequence** (44B -> 50002): sub-byte [40] progresses
  0x01/0x06 (startup) -> 0x05 -> 0x08 (repeated) -> 0x09 (after LIVE switch off).
- **0x6b preference write is 116B**, not 124B.
- The 0x07 transport packet on hardware is **48B with a 19B name region**, not
  56B/20B: `[30]=player num [31]=01 [32]=00 [33]=sender's number, hidden (see 6.3)
  [34-35]=packet length [36-37]=command [38-39]=sender's number (0x3a)
  [40-41]=count [42-43]=key [44]=kind (0) [45]=state (1 press, 0 release)
  [46-47]=value (0)`. Command 0 is key events, 1 connect, 2 disconnect; a
  connect or disconnect frame has a count of 0 and is 42 bytes. Earlier notes
  called byte 33 a correlation value and `[43]` an opcode.

### 6.2 CDJ -> controller observations

- **0x69** (54B -> 50002): the player's answer to the 0x68. Bytes 40-43 vary
  because they are tempo/pitch fields (earlier notes took them for a session
  token); byte 49 = 0x7f constant. Sent a few times per session (periodically
  and around button presses), not once.
- **0x0b** (60B -> 50001): beat/state stream (~32/s) sent only to the accepted
  controller. Byte 33 cycles through 8 values (92/98/b4/ad/f6/d6/99/cd): it is
  the player's own number, hidden the way a Stagehand hides its own (6.3).
- **0x0a**: 60B static heartbeat, plus a 1116B full announcement broadcast while
  a controller is online (17 varying bytes, firmware string near byte 118).
- All traffic is UDP.

### 6.3 How a player accepts a Stagehand

A player files a Stagehand under a device number, and answers it and obeys it
only under the right one. The answer to the open question that was here
(why a player ignored every replica of the app's packets) is the number and
what hides it, plus one frame the app was never captured sending:

1. **Byte 33 is the sender's device number behind a checksum, not a
   per-session value.** On ports 50001 and 50002, when byte 33 has its top bit
   set the player replaces it with `(S ^ byte33) & 0x7f`, where `S` is the sum
   of the first 64 bytes of the packet (all of it when shorter), with byte 33
   counted as 0, plus the last three bytes of the MAC the sender put in its
   port-50000 keep-alive. A plain value under `0x80` is taken as it is. The
   three captured frames pinned in `tests/control/stagehand.spec.ts` (byte 33 =
   `f7`, `e8`, `ed`) all decode to `0x3a` with a MAC whose last three bytes
   sum to `0x36` (mod 128), and so does the mixer heartbeat's `fe`. What
   looked like a per-command value is the key and the press flag in the sum.
2. **A Stagehand's number is `0x3a`**, hidden the same way in its type `0x06`
   keep-alive, at byte `0x24`: `0x80 | ((0x3a ^ S) & 0x7f)`, `S` being the sum
   of the other 53 bytes of the 54-byte packet plus the MAC's last three. A
   player accepts `0x36` to `0x3f` for this device class. The 141 to 211 that
   the app's keep-alive shows is the same number seen through the checksum, so
   a library that sends one of them as a number files itself under another
   number and gets no answer (by the firmware read, a plain `0x36`..`0x3f`
   with device type 5 is rejected too; not tried). With the encoded `0x3a`
   both players answered the `0x68`
   with `0x69`, sent status and the `0x0b` position stream, and the DJM-A9
   sent its mixer state (`0x39`), `0x6d` and `0x6a` to the client. The frames
   the players send such a client carry their own number hidden in byte 33 the
   same way, with the sender's MAC; that is the cycling byte in 6.2.
   `encodeStagehandNumber` and `decodeStagehandNumber` do this, and Stagehand
   mode decodes it in status and position packets.
3. **A player obeys keys only after a connect frame.** The `0x07` body is
   `u16 command, u16 device number, u16 count`, then `count` entries of `u16
   key, u8 kind, u8 state, u16 value`, big-endian; bytes 34 and 35 are the
   packet's length. Command 0 is key events (what the captures hold), 1 is
   connect and 2 is disconnect. Keys sent with no connect did nothing; after
   one connect frame they worked, with a plain `0x3a` in byte 33 and no
   keep-alive at all. Whether the iPad app sends the connect frame is not
   known: no capture of one exists.
4. **Key `0x14` is PLAY/PAUSE**, one toggle that acts on the press. There is no
   separate pause. (`0x0f`, which the app sends before it, is tempo reset by
   the firmware; not tested.)

What was tested: from a Mac, on firmware 3.22, on two CDJ-3000s with a DJM-A9
on the link: the join, the streams above, and play and pause on both players
(on one of them also with stock firmware); `Control.play` and `pause` through
`examples/stagehand-monitor.ts` on one of them. What is only read from the
firmware: the other keys and the range `0x36` to `0x3f`. Not known: whether
the connect state expires or survives a player restart (only a few minutes
were tried), other player models and firmware versions, and what the `0x3c`
and `0x55` packets are for.
