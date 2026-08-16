/**
 * Draw Waveform Example
 *
 * Turns the raw waveform bytes in a rekordbox analysis file into something you
 * can actually look at. Covers all three waveform flavors:
 *
 * - PWV4 (.EXT) — color preview, 1200 columns × 6 bytes (3 bands × height+whiteness)
 * - PWV6 (.2EX) — 3-band preview, N entries × 3 bytes (low, mid, high)
 * - PWV5 (.EXT) — HD detail waveform, 150 segments/sec, each height 0–31 + RGB
 *
 * The rendering functions are plain data → string/draw-calls, so they work in
 * Node (SVG) and in the browser (canvas) without any dependencies.
 *
 * Usage:
 *
 *   npm run build
 *   npx tsc examples/draw-waveform.ts --module commonjs --target ES2020 \
 *     --esModuleInterop --skipLibCheck
 *   node examples/draw-waveform.js <analyze-path> [out-dir]
 *
 * Where <analyze-path> is the ANLZ path WITHOUT the extension, e.g.
 * `/Volumes/USB/PIONEER/USBANLZ/P016/0000875E/ANLZ0000` (the loader appends
 * `.EXT` / `.2EX`). This matches `track.analyzePath`, which the pdb hydrator
 * already stores with the extension stripped.
 *
 * It runs against the built bundle rather than `src/` because the ANLZ parser
 * pulls in the Kaitai `.ksy` grammars through a webpack loader, which bare
 * ts-node cannot resolve. The decode and draw functions below have no such
 * dependency — they are pure and can be lifted into any project as-is.
 */

import {promises as fs} from 'fs';
import * as path from 'path';

import type {AnlzResolver} from '../lib';
import {loadAnlz} from '../lib';
import type {WaveformHD} from '../lib/types';

// ============================================================================
// 1. Decode — raw bytes to normalized 0–1 amplitudes per frequency band
// ============================================================================

export interface Bands {
  low: number[];
  mid: number[];
  high: number[];
}

/**
 * PWV4 color preview: 1200 columns × 6 bytes.
 * Each band occupies 2 bytes — byte 0 is height, byte 1 is "whiteness" which we
 * drop here (it only affects shading, not amplitude).
 */
export function bandsFromColorPreview(data: Uint8Array): Bands {
  const BYTES_PER_COLUMN = 6;
  const columns = Math.floor(data.length / BYTES_PER_COLUMN);

  const bands: Bands = {low: [], mid: [], high: []};

  for (let i = 0; i < columns; i++) {
    const offset = i * BYTES_PER_COLUMN;
    bands.low.push(data[offset] / 255);
    bands.mid.push(data[offset + 2] / 255);
    bands.high.push(data[offset + 4] / 255);
  }

  return bands;
}

/**
 * PWV6 / PWV7 3-band waveform: N entries × 3 bytes, interleaved low/mid/high.
 */
export function bandsFrom3Band(data: Uint8Array, numEntries: number): Bands {
  const bands: Bands = {low: [], mid: [], high: []};

  for (let i = 0; i < numEntries; i++) {
    const offset = i * 3;
    bands.low.push(data[offset] / 255);
    bands.mid.push(data[offset + 1] / 255);
    bands.high.push(data[offset + 2] / 255);
  }

  return bands;
}

/**
 * Collapse the three bands into a single amplitude per column, for when you
 * want a plain monochrome waveform (this is what wavesurfer.js wants as
 * `peaks`).
 */
export function combineBands(bands: Bands): number[] {
  return bands.low.map((low, i) => Math.min(1, low + bands.mid[i] + bands.high[i]));
}

/**
 * Logarithmic amplitude scaling. Linear values make quiet passages look flat —
 * a breakdown at 10% and a drop at 50% are hard to tell apart. This maps 0→0
 * and 1→1 while lifting everything in between.
 *
 * Higher `scale` = more compression. 50–500 is a sensible range.
 */
export function applyLogScaling(peaks: number[], scale = 200): number[] {
  const denominator = Math.log(1 + scale);
  return peaks.map(peak => Math.log(1 + peak * scale) / denominator);
}

/**
 * Reduce a long array of amplitudes down to `width` columns by taking the peak
 * of each bucket. Needed for detail waveforms — 150 segments/sec is ~45,000
 * segments for a five minute track, far more than you have pixels.
 */
export function downsample(values: number[], width: number): number[] {
  if (values.length <= width) {
    return values;
  }

  const bucketSize = values.length / width;
  const result: number[] = [];

  for (let i = 0; i < width; i++) {
    const start = Math.floor(i * bucketSize);
    const end = Math.floor((i + 1) * bucketSize);

    let peak = 0;
    for (let j = start; j < end; j++) {
      peak = Math.max(peak, values[j]);
    }
    result.push(peak);
  }

  return result;
}

// ============================================================================
// 2. Draw — amplitudes to pixels
// ============================================================================

export interface DrawOptions {
  width: number;
  height: number;
  /**
   * Colors for each frequency band. The defaults approximate the rekordbox
   * look — blue bass, amber mids, near-white highs. rekordbox's exact palette
   * and blending are not documented, so treat these as a starting point.
   */
  colors?: {low: string; mid: string; high: string};
  background?: string;
}

const DEFAULT_COLORS = {low: '#2f6fe0', mid: '#e08a2f', high: '#f2f2f2'};

/**
 * The core of every waveform renderer: for each column, a bar of `amplitude *
 * height` pixels, centered vertically so it mirrors around the middle.
 *
 * Within a column the three bands are painted tallest first, so the quieter
 * bands nest visibly inside the loudest one. That layering is a rendering
 * choice, not something decoded from the file — stack the bands end to end
 * instead if you want each one's contribution to be separately readable.
 */
function bandRects(bands: Bands, opts: DrawOptions) {
  const {width, height} = opts;
  const colors = opts.colors ?? DEFAULT_COLORS;

  const columns = Math.max(bands.low.length, bands.mid.length, bands.high.length);
  const barWidth = width / columns;
  const center = height / 2;

  const rects: Array<{x: number; y: number; w: number; h: number; fill: string}> = [];

  for (let i = 0; i < columns; i++) {
    const column = [
      {value: bands.low[i] ?? 0, fill: colors.low},
      {value: bands.mid[i] ?? 0, fill: colors.mid},
      {value: bands.high[i] ?? 0, fill: colors.high},
    ].sort((a, b) => b.value - a.value);

    for (const {value, fill} of column) {
      const barHeight = value * height;
      if (barHeight <= 0) {
        continue;
      }

      rects.push({
        x: i * barWidth,
        y: center - barHeight / 2,
        w: Math.max(barWidth, 1),
        h: barHeight,
        fill,
      });
    }
  }

  return rects;
}

/**
 * Render the 3-band waveform as a standalone SVG document.
 */
export function renderBandsSvg(bands: Bands, opts: DrawOptions): string {
  const {width, height, background = '#000000'} = opts;

  const rects = bandRects(bands, opts)
    .map(
      r =>
        `<rect x="${r.x.toFixed(2)}" y="${r.y.toFixed(2)}" ` +
        `width="${r.w.toFixed(2)}" height="${r.h.toFixed(2)}" fill="${r.fill}"/>`
    )
    .join('');

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
    `viewBox="0 0 ${width} ${height}">` +
    `<rect width="${width}" height="${height}" fill="${background}"/>${rects}</svg>`
  );
}

/**
 * Render the HD (PWV5) waveform, which carries a real RGB color per segment
 * instead of three fixed bands. Buckets are reduced by peak height, and the
 * loudest segment in each bucket donates its color.
 */
export function renderHdSvg(
  waveform: WaveformHD,
  opts: Pick<DrawOptions, 'width' | 'height' | 'background'>
): string {
  const {width, height, background = '#000000'} = opts;

  const bucketSize = Math.max(waveform.length / width, 1);
  const center = height / 2;
  const rects: string[] = [];

  for (let i = 0; i < width; i++) {
    const start = Math.floor(i * bucketSize);
    const end = Math.min(Math.floor((i + 1) * bucketSize), waveform.length);
    if (start >= waveform.length) {
      break;
    }

    let loudest = waveform[start];
    for (let j = start + 1; j < end; j++) {
      if (waveform[j].height > loudest.height) {
        loudest = waveform[j];
      }
    }

    // Heights are 0–31 in the file format.
    const barHeight = (loudest.height / 31) * height;
    const [r, g, b] = loudest.color.map(channel => Math.round(channel * 255));

    rects.push(
      `<rect x="${i}" y="${(center - barHeight / 2).toFixed(2)}" width="1" ` +
        `height="${barHeight.toFixed(2)}" fill="rgb(${r},${g},${b})"/>`
    );
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
    `viewBox="0 0 ${width} ${height}">` +
    `<rect width="${width}" height="${height}" fill="${background}"/>${rects.join(
      ''
    )}</svg>`
  );
}

/**
 * Browser variant — same geometry, painted onto a 2D canvas context.
 *
 * The parameter is structurally typed so this file compiles without the DOM
 * lib; pass a real `CanvasRenderingContext2D` and it just works:
 *
 *   const ctx = canvas.getContext('2d')!;
 *   drawBandsToCanvas(ctx, bands, {width: canvas.width, height: canvas.height});
 */
export interface Canvas2DLike {
  fillStyle: string;
  fillRect(x: number, y: number, w: number, h: number): void;
}

export function drawBandsToCanvas(ctx: Canvas2DLike, bands: Bands, opts: DrawOptions) {
  ctx.fillStyle = opts.background ?? '#000000';
  ctx.fillRect(0, 0, opts.width, opts.height);

  for (const rect of bandRects(bands, opts)) {
    ctx.fillStyle = rect.fill;
    ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
  }
}

// ============================================================================
// 3. Load an analysis file and write out the images
// ============================================================================

async function main() {
  const [analyzePath, outDir = process.cwd()] = process.argv.slice(2);

  if (!analyzePath) {
    console.error('Usage: ts-node examples/draw-waveform.ts <analyze-path> [out-dir]');
    console.error('  <analyze-path> is the ANLZ path WITHOUT the .DAT/.EXT/.2EX suffix');
    process.exit(1);
  }

  // In a real app this resolver reads off the player over NFS — see
  // `anlzLoader()` in src/db/utils.ts. Here we just read the local filesystem.
  const resolver: AnlzResolver = filePath => fs.readFile(filePath);

  const track = {analyzePath};

  // --- PWV5 HD waveform + PWV4 color preview, both from the .EXT file -------

  const ext = await loadAnlz(track, 'EXT', resolver);

  if (ext.waveformColorPreview) {
    const bands = bandsFromColorPreview(ext.waveformColorPreview);
    const svg = renderBandsSvg(bands, {width: 1200, height: 160});
    const file = path.join(outDir, 'waveform-preview.svg');

    await fs.writeFile(file, svg);
    console.log(`PWV4 color preview  ${bands.low.length} columns → ${file}`);
  } else {
    console.log('PWV4 color preview  not present in this .EXT file');
  }

  if (ext.waveformHd) {
    const svg = renderHdSvg(ext.waveformHd, {width: 1600, height: 200});
    const file = path.join(outDir, 'waveform-hd.svg');

    await fs.writeFile(file, svg);
    console.log(`PWV5 HD waveform    ${ext.waveformHd.length} segments → ${file}`);
  } else {
    console.log('PWV5 HD waveform    not present in this .EXT file');
  }

  // --- PWV6 3-band preview from the .2EX file (CDJ-3000 era) ---------------

  try {
    const anlz2ex = await loadAnlz(track, '2EX', resolver);

    if (anlz2ex.waveform3BandPreview) {
      const {data, numEntries} = anlz2ex.waveform3BandPreview;
      const bands = bandsFrom3Band(data, numEntries);
      const svg = renderBandsSvg(bands, {width: 1200, height: 160});
      const file = path.join(outDir, 'waveform-3band.svg');

      await fs.writeFile(file, svg);
      console.log(`PWV6 3-band preview ${numEntries} entries → ${file}`);

      // Monochrome variant — the same data flattened to a single amplitude,
      // log-scaled, which is the array wavesurfer.js takes as `peaks`.
      const peaks = applyLogScaling(combineBands(bands));
      const mono = renderBandsSvg(
        {low: peaks, mid: [], high: []},
        {width: 1200, height: 160, colors: {low: '#4ade80', mid: '', high: ''}}
      );
      const monoFile = path.join(outDir, 'waveform-mono.svg');

      await fs.writeFile(monoFile, mono);
      console.log(`Combined peaks      ${peaks.length} values → ${monoFile}`);
    }
  } catch {
    console.log('PWV6 3-band preview no .2EX file for this track');
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error(error);
    process.exit(1);
  });
}
