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
    vcdjName: 'Stagehand-Control' // Custom virtual iPad name
  });

  // Autoconfigure interface from peers (assigns a randomized ID in the 141-211 range)
  await network.autoconfigFromPeers();

  // Connect to start the Stagehand abbreviated handshake
  network.connect();
  
  console.log('Connected to network posing as Stagehand client!');
}
```

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
    console.log(`  Channel ${ch} - Latest VU -> Left: ${latestFrame.left}, Right: ${latestFrame.right}`);
  }
});
```

---

## 4. Remote Control (Writing States)

When connected in Stagehand mode, the `network.control` service automatically utilizes the Stagehand protocol (`0x07` transport commands and `0x6b` preference writes) to control devices.

### 4.1 Transport Commands

The transport control commands target port `50001` of the destination CDJ device.

#### 4.1.1 Play & Pause

The standard API `control.setPlayState` automatically detects Stagehand mode and delegates to the appropriate transport packets:

```typescript
// Seamlessly delegates to Stagehand play/pause packets
await network.control.setPlayState(cdjDevice, CDJStatus.PlayState.Playing);
await network.control.setPlayState(cdjDevice, CDJStatus.PlayState.Cued);
```

You can also call the specialized methods directly:

```typescript
// Sends Stagehand play sequence (paired 0x0f and 0x14 packets)
await network.control.play(cdjDevice);

// Sends Stagehand pause command (paired 0x14 packet with release flag)
await network.control.pause(cdjDevice);
```

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

Simulate skip forward / skip backward button presses:

```typescript
// Initiate skip press
await network.control.skip(cdjDevice, true);

// Release skip
await network.control.skip(cdjDevice, false);
```

---

### 4.2 Preference Writes

Configure equipment settings directly from the virtual Stagehand client by transmitting `0x6b` (124-byte) preference write packets to port `50002` on the destination CDJ.

```typescript
// Toggle On-Air display mode to ON
await network.control.setPreference(cdjDevice, { onAir: 'on' });

// Toggle On-Air display mode to OFF
await network.control.setPreference(cdjDevice, { onAir: 'off' });

// Toggle quantize value change (value is set as 0x80 | enum_index)
await network.control.setPreference(cdjDevice, { quantize: 1 }); // Quantize index 1
```

---

## 5. API Compatibility

To preserve backwards-compatibility and maintain documentation integrity:
- Existing active (`vcdjId` < 7) and passive modes remain fully supported and completely untouched.
- `network.control.setPlayState(device, state)` works out-of-the-box regardless of your connection mode, automatically translating state mappings into correct network packets.

---

## 6. Real Hardware Testing Notes (contributed)

> Captured from a CDJ-3000 (player 4, firmware 3.18) with the official Stagehand
> iPad app as baseline, using layer-2 MAC takeover for unicast capture.

### 6.1 Observed gaps vs. real Stagehand traffic

Running the Stagehand connection mode against real hardware, the CDJ silently
ignores the 0x07 transport commands. The official app sends several packet types
that this library currently does not:

- **0x68 registration report** (36B, every 2s, unicast to CDJ:50002 + broadcast).
  Layout (0-based): `header | 0x68 | name19B | [30]=target player num | 01 00 3a 00 00`.
- **0x3c state-sync request** (36B -> 50002; identical to 0x68 except [31]=0x01).
  Sent when the app enters the WAVEFORM screen. After the iPad screen sleeps and
  wakes, control is ignored by the CDJ until this packet is sent and the waveform
  reloads — then control works again.
- **0x55 state-report sequence** (44B -> 50002): sub-byte [40] progresses
  0x01/0x06 (startup) -> 0x05 -> 0x08 (repeated) -> 0x09 (after LIVE switch off).
- **0x6b preference write is 116B**, not 124B.
- The 0x07 transport packet on hardware is **48B with a 19B name region**, not
  56B/20B: `[30]=player num [31]=0x01 [32]=0x00 [33]=correlation [34]=0x00
  [35]=0x30 [36-38]=0x00 [39]=0x3a [40]=0x00 [41]=0x01 [42]=0x00 [43]=op
  [44]=0x00 [45]=press [46]=0x00 [47]=0x00`.

### 6.2 CDJ -> controller observations

- **0x69** (54B -> 50002): session token, bytes 40-43 change per session
  (e.g. `31 e5 ff da`, `32 c8 ff bf`), byte 49 = 0x7f constant. Repeated a few
  times per session (periodically and around button presses), not once.
- **0x0b** (60B -> 50001): beat/state stream (~32/s) sent only to the accepted
  controller. Byte 33 cycles through 8 values (92/98/b4/ad/f6/d6/99/cd).
- **0x0a**: 60B static heartbeat, plus a 1116B full announcement broadcast while
  a controller is online (17 varying bytes, firmware string near byte 118).
- All traffic is UDP.

### 6.3 Open question

Even after replicating every observed packet byte-for-byte (0x0a/0x02/0x06/
0x68/0x55 sequence/0x3c/0x6b/0x07) with random source ports, random protocol MAC
and dev_id, and fully impersonating the iPad's Ethernet MAC + IP (iPad offline),
the CDJ never issues 0x69 or the 0x0b stream to the client and never executes
commands. The per-command byte 33 ("correlation") changes per session and per
opcode (session A: play=0x9e, pause=0x93; session B: play=0x93, pause=0x94;
skip=e0/e3), suggesting it is derived from the 0x69 token — a chicken-and-egg we
could not close. Any insight into how the CDJ gates acceptance of a Stagehand
client would be greatly appreciated.
