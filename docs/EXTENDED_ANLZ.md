# Extended ANLZ Features

This document describes the extended rekordbox analysis (ANLZ) features exposed by alphatheta-connect. See [USB export formats](./USB_EXPORT.md) for complete disk layouts, palettes, path derivation, database schemas and interoperability limits.

## Overview

Rekordbox creates analysis files with three different extensions:

- **`.DAT`** - Basic analysis for older Pioneer equipment
- **`.EXT`** - Extended analysis for Nexus 2 and CDJ-3000 (colored waveforms, extended cues, song structure)
- **`.2EX`** - Additional 3-band waveform data for CDJ-3000 (PWV6/PWV7 preview and detail parsers implemented)

## Implemented Features

### 1. Extended Cues (PCO2 Tag)

Extended cues include all the information from basic cues (PCOB) plus:

- **RGB Color Values**: Actual RGB values used to illuminate player LEDs
- **Color Codes**: Palette color codes (0x00-0x40); code 0 uses slot-default RGB in captured exports
- **Comments**: User-assigned text for each cue/loop
- **Quantized Loop Info**: Numerator/denominator for beat-quantized loops

**Usage:**

```typescript
import {loadAnlz} from 'alphatheta-connect/localdb/rekordbox';

const extAnlz = await loadAnlz(track, 'EXT', anlzLoader);

if (extAnlz.extendedCues) {
  for (const cue of extAnlz.extendedCues) {
    console.log(`Hot Cue ${String.fromCharCode(64 + cue.hotCue)}`);
    console.log(`  Time: ${cue.time}ms`);
    console.log(`  Comment: ${cue.comment || 'None'}`);

    if (cue.colorRgb) {
      const {r, g, b} = cue.colorRgb;
      console.log(`  Color: RGB(${r}, ${g}, ${b})`);
    }

    if (cue.loopNumerator && cue.loopDenominator) {
      console.log(`  Quantized: ${cue.loopNumerator}/${cue.loopDenominator} beats`);
    }
  }
}
```

**Type Definition:**

```typescript
export interface ExtendedCue {
  hotCue: number; // 0 = memory point, 1-16 = hot cues A-P
  type: 1 | 2; // 1 = cue, 2 = loop
  time: number; // Position in milliseconds
  loopTime?: number; // Loop end time (if type === 2)
  colorId?: number; // Color table reference (memory points)
  colorCode?: number; // Palette color code (hot cues)
  colorRgb?: {r: number; g: number; b: number}; // RGB values for LED illumination
  comment?: string; // User comment
  loopNumerator?: number; // Quantized loop size numerator
  loopDenominator?: number; // Quantized loop size denominator
}
```

### 2. Song Structure (PSSI Tag)

Song structure provides phrase analysis for CDJ-3000 and lighting control:

- **Mood Classification**: High, Mid, or Low energy structure
- **Lighting Bank**: Style preset for lighting control
- **Phrase Identification**: Intro, Verse, Chorus, Bridge, Outro, etc.
- **Fill-in Markers**: Improvisational change sections

**Usage:**

```typescript
const extAnlz = await loadAnlz(track, 'EXT', anlzLoader);

if (extAnlz.songStructure) {
  const {mood, bank, phrases} = extAnlz.songStructure;

  console.log(`Track Mood: ${mood}`); // 'high', 'mid', or 'low'
  console.log(`Lighting Bank: ${bank}`); // 'cool', 'hot', 'vivid', etc.

  for (const phrase of phrases) {
    console.log(`Beat ${phrase.beat}: ${phrase.phraseType}`);

    if (phrase.fill) {
      console.log(`  Fill-in at beat ${phrase.fillBeat}`);
    }
  }
}
```

**Phrase Types by Mood:**

| Mood     | Phrase Types                            |
| -------- | --------------------------------------- |
| **High** | Intro, Up, Down, Chorus, Outro          |
| **Mid**  | Intro, Verse 1-6, Bridge, Chorus, Outro |
| **Low**  | Intro, Verse 1-2, Bridge, Chorus, Outro |

**Type Definitions:**

```typescript
export interface SongStructure {
  mood: 'high' | 'mid' | 'low';
  bank:
    | 'default'
    | 'cool'
    | 'natural'
    | 'hot'
    | 'subtle'
    | 'warm'
    | 'vivid'
    | 'club_1'
    | 'club_2';
  endBeat: number;
  phrases: Phrase[];
}

export interface Phrase {
  index: number; // Sequential phrase number
  beat: number; // Beat number where phrase begins
  kind: number; // Raw phrase kind value
  phraseType: string; // Human-readable type
  fill?: number; // Fill-in flag
  fillBeat?: number; // Beat where fill-in begins
}
```

### 3. Waveform Previews (PWAV, PWV2 Tags)

Monochrome waveform previews for quick navigation:

- **PWAV**: 400 bytes, shown above touch strip on Nexus players
- **PWV2**: 100 bytes, shown on CDJ-900 displays

**Usage:**

```typescript
const datAnlz = await loadAnlz(track, 'DAT', anlzLoader);

if (datAnlz.waveformPreview) {
  const data = datAnlz.waveformPreview.data; // Uint8Array of 400 bytes
  // Each byte encodes height (bits 0-4) and whiteness (bits 5-7)
}

if (datAnlz.waveformTiny) {
  const data = datAnlz.waveformTiny.data; // Uint8Array of 100 bytes
  // Same 5-bit height / 3-bit whiteness packing; captured height ceiling is 15
}
```

### 4. Detailed Waveforms (PWV3, PWV4, PWV5 Tags)

High-resolution waveforms that scroll during playback:

- **PWV3**: Monochrome detail, 1 byte per segment
- **PWV4**: Color preview, 7200 bytes (1200 columns × 6 bytes)
- **PWV5**: HD color detail, 2 bytes per segment (already implemented)

PWV3 and PWV5 detail waveforms have 150 segments per second. PWV4 is a fixed 1200-column overview, independent of track duration. PWAV, PWV2 and detailed monochrome waveforms use different height ceilings: 25, 15 and 31 respectively.

**Usage:**

```typescript
const extAnlz = await loadAnlz(track, 'EXT', anlzLoader);

// Monochrome detail (PWV3)
if (extAnlz.waveformDetail) {
  const data = extAnlz.waveformDetail; // Uint8Array
  // 150 segments per second of audio
}

// Color preview (PWV4)
if (extAnlz.waveformColorPreview) {
  const data = extAnlz.waveformColorPreview; // Uint8Array
  // 1200 columns × 6 bytes each
}

// HD color detail (PWV5) - already existed
if (extAnlz.waveformHd) {
  const segments = extAnlz.waveformHd; // WaveformHD[]
  // Each segment has height and RGB color
}
```

### 5. Three-band Waveforms (PWV6, PWV7 Tags)

`loadAnlz(track, '2EX', anlzLoader)` exposes `waveform3BandPreview` and
`waveform3BandDetail`. PWV6 has a 20-byte section header and 1200 three-byte
columns. PWV7 has three-byte detail columns at approximately 150 per second.
Both store low, mid and high bands; see the standalone format reference for
scaling and companion-file placement.

## Practical Applications

### Lighting Control

Use song structure to trigger lighting changes at phrase boundaries:

```typescript
const {songStructure, beatGrid} = await Promise.all([
  loadAnlz(track, 'EXT', anlzLoader),
  loadAnlz(track, 'DAT', anlzLoader),
]);

if (songStructure && beatGrid) {
  for (const phrase of songStructure.phrases) {
    // Convert beat number to milliseconds
    const beat = beatGrid.find(b => b.offset >= phrase.beat * (60000 / bpm));

    if (beat) {
      scheduleLightingCue(beat.offset, phrase.phraseType, songStructure.bank);
    }
  }
}
```

### Enhanced Track Annotations

Export cues with comments and colors:

```typescript
const extAnlz = await loadAnlz(track, 'EXT', anlzLoader);

const annotations = extAnlz.extendedCues?.map(cue => ({
  hotCue: String.fromCharCode(64 + cue.hotCue), // 'A', 'B', 'C', etc.
  time: formatTime(cue.time),
  comment: cue.comment || '',
  color: cue.colorRgb ? rgbToHex(cue.colorRgb) : undefined,
}));

await fs.writeFile('track-annotations.json', JSON.stringify(annotations, null, 2));
```

### Visual Waveform Rendering

Render colored waveforms for custom UIs:

```typescript
const extAnlz = await loadAnlz(track, 'EXT', anlzLoader);

// Use PWV4 for preview (1200 columns)
if (extAnlz.waveformColorPreview) {
  renderColorPreview(extAnlz.waveformColorPreview, canvas);
}

// Use PWV5 for scrolling detail
if (extAnlz.waveformHd) {
  extAnlz.waveformHd.forEach((segment, i) => {
    const [r, g, b] = segment.color;
    drawWaveformSegment(i, segment.height, `rgb(${r}, ${g}, ${b})`);
  });
}
```

### CDJ-3000 Phrase Navigation

Build a phrase navigation UI matching CDJ-3000:

```typescript
if (extAnlz.songStructure) {
  const phraseButtons = extAnlz.songStructure.phrases.map(phrase => ({
    label: phrase.phraseType,
    beat: phrase.beat,
    onClick: () => seekToBeat(phrase.beat),
    hasFillIn: phrase.fill > 0,
  }));

  renderPhraseNavigation(phraseButtons);
}
```

## Implementation Details

### XOR Masking

Export-form PSSI uses the repeating 19-byte XOR mask documented in [USB export formats](./USB_EXPORT.md#phrase-data-and-export-mask). The current Kaitai parser applies that mask unconditionally. Desktop share files may instead contain plaintext PSSI; callers must not assume that all source files use the export representation. The reference describes the mood-based distinction and full mask bytes.

### Color Palettes

Extended cues include two color representations:

1. **colorCode** (0x00-0x40): The captured 65-entry device palette index; code 0 chooses slot-default RGB
2. **colorRgb**: Actual RGB values sent to the player's LEDs

The RGB values are distinct from the colors painted in the rekordbox UI. The full palette and default-slot mapping are embedded in [USB export formats](./USB_EXPORT.md#cue-writer-tables). The current high-level adapter omits RGB for code 0 even when the disk record carries nonzero default RGB; this is an API limitation, not an absent disk color.

### Quantized Loops

Quantized loops store their size as a fraction:

- 4-beat loop: numerator=4, denominator=1
- 1/2-beat loop: numerator=1, denominator=2
- Always powers of 2

## Missing Features

The following tags are defined in the Kaitai Struct but not yet extracted:

- **VBR** (PVBR): Variable bit-rate index for seeking
- **PATH** (PPTH): Original audio file path

These can be added by extending the switch statement in `loadAnlz()` and adding appropriate parser functions.

## See Also

- [USB export formats](./USB_EXPORT.md) - Standalone DeviceSQL, OneLibrary, ANLZ, settings and export validation reference

- [ABSOLUTE_POSITION.md](./ABSOLUTE_POSITION.md) - CDJ-3000 position tracking
- [Deep Symmetry ANLZ Analysis](https://djl-analysis.deepsymmetry.org/rekordbox-export-analysis/anlz.html)
- [examples/extended-anlz-features.ts](../examples/extended-anlz-features.ts) - Complete usage example
