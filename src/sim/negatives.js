/**
 * L6 — Deterministic Negative & False-Positive Fixture Generators (`src/sim/negatives.js`).
 *
 * Uses seeded `mulberry32` PRNG (never `Math.random`) to synthesize all 9 negative /
 * false-positive fixture categories:
 *   1. `valid-non-tsx`          — valid non-`tsX` Code 128B label (decodes when not strict; rejected under strict)
 *   2. `truncated-partial`      — truncated/partial label (frame or tote lip cut)
 *   3. `tsx-broken-check`       — `tsX` label with a broken Mod-103 check digit
 *   4. `tsx-prefix-random-bars` — exact 44-module StartB + `t`,`s`,`X` prefix followed by random bars
 *   5. `ean-code39-lookalike`   — EAN-13-like and Code 39 lookalike stripe patterns
 *   6. `shipping-text-block`    — shipping-label text blocks, borders and micro-glyphs
 *   7. `tape-seams-tote-ribs`   — tape seams and horizontal tote rib ladders
 *   8. `repeated-fabric-clutter`— repeated high-contrast fabric / herringbone stripe clutter
 *   9. `picket-rotated-90`      — 90-degree rotated picket-orientation non-`tsX` Code 128B label
 *
 * Every fixture carries:
 *   `{ id, kind, seed, luma, width, height, expectedPayloads, allowValidNonTsx, failOnAnyAccept }`
 */

import { CODE128_PATTERNS, CODE128_START_B } from '../worker/decoders/code128.js';
import {
  CODE128_STOP_PATTERN,
  encodeCode128B,
  mulberry32,
} from './label.js';

export const NEGATIVE_KINDS = Object.freeze([
  'valid-non-tsx',
  'truncated-partial',
  'tsx-broken-check',
  'tsx-prefix-random-bars',
  'ean-code39-lookalike',
  'shipping-text-block',
  'tape-seams-tote-ribs',
  'repeated-fabric-clutter',
  'picket-rotated-90',
]);

const ALPHANUM = '0123456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const BASE36 = '0123456789abcdefghijklmnopqrstuvwxyz';

// Code 39 narrow(1)/wide(3) patterns for a handful of characters + '*' start/stop
const CODE39_PATTERNS = [
  '121131311', // '*'
  '111231311', // '0'
  '311211113', // '1'
  '113211113', // '2'
  '313211111', // '3'
  '111231113', // '4'
  '311231111', // '5'
  '113231111', // '6'
  '111211313', // '7'
  '311211311', // '8'
  '113211311', // '9'
];

// EAN-13 L-code 7-module patterns for digits 0..9
const EAN_L_CODES = [
  '0001101', '0011001', '0010011', '0111101', '0100011',
  '0110001', '0101111', '0111011', '0110111', '0001011',
];

function mod103Check(symbols, count) {
  let sum = symbols[0];
  for (let i = 1; i < count; i++) sum += i * symbols[i];
  return sum % 103;
}

function encodeRawSymbols(symbols, includeStop, quietMods = 10) {
  const dataMods = symbols.length * 11 + (includeStop ? 13 : 0);
  const out = new Uint8Array(dataMods + quietMods * 2);
  let c = quietMods;
  for (let s = 0; s < symbols.length; s++) {
    const base = symbols[s] * 6;
    for (let r = 0; r < 6; r++) {
      const w = CODE128_PATTERNS[base + r];
      const isBar = (r & 1) === 0 ? 1 : 0;
      for (let k = 0; k < w; k++) out[c++] = isBar;
    }
  }
  if (includeStop) {
    for (let r = 0; r < 7; r++) {
      const w = CODE128_STOP_PATTERN[r];
      const isBar = (r & 1) === 0 ? 1 : 0;
      for (let k = 0; k < w; k++) out[c++] = isBar;
    }
  }
  return out;
}

/**
 * Stamps a 1D binary module strip into a 2D `width x height` luma frame.
 * `orientation = 'picket'` -> vertical bars (horizontal scan);
 * `orientation = 'ladder'` -> horizontal bars (vertical scan).
 */
function renderStripToFrame(modules, width, height, opts = {}) {
  const orientation = opts.orientation || 'picket';
  const modPx = opts.modPx || 2;
  const barLuma = opts.barLuma ?? 22;
  const spaceLuma = opts.spaceLuma ?? 232;
  const bgLuma = opts.bgLuma ?? 140;
  const luma = new Uint8Array(width * height);
  luma.fill(bgLuma);

  if (orientation === 'picket') {
    const spanPx = modules.length * modPx;
    const x0 = Math.max(0, (width - spanPx) >> 1);
    const barH = Math.min(height - 20, opts.barSpanPx || Math.round(height * 0.55));
    const y0 = (height - barH) >> 1;
    const y1 = y0 + barH;
    const rowBuf = new Uint8Array(width);
    rowBuf.fill(bgLuma);
    const xEnd = Math.min(width, x0 + spanPx);
    for (let x = Math.max(0, x0 - 6); x < Math.min(width, xEnd + 6); x++) {
      rowBuf[x] = spaceLuma;
    }
    for (let m = 0; m < modules.length; m++) {
      const pxStart = x0 + m * modPx;
      if (pxStart >= width) break;
      const val = modules[m] ? barLuma : spaceLuma;
      const pxStop = Math.min(width, pxStart + modPx);
      for (let x = pxStart; x < pxStop; x++) rowBuf[x] = val;
    }
    for (let y = y0; y < y1; y++) {
      luma.set(rowBuf, y * width);
    }
  } else {
    // Ladder orientation: horizontal bars scanned vertically
    const spanPx = modules.length * modPx;
    const y0 = Math.max(0, (height - spanPx) >> 1);
    const barW = Math.min(width - 20, opts.barSpanPx || Math.round(width * 0.35));
    const x0 = (width - barW) >> 1;
    const x1 = x0 + barW;
    const yEnd = Math.min(height, y0 + spanPx);
    for (let y = Math.max(0, y0 - 6); y < Math.min(height, yEnd + 6); y++) {
      luma.fill(spaceLuma, y * width + Math.max(0, x0 - 6), y * width + Math.min(width, x1 + 6));
    }
    for (let m = 0; m < modules.length; m++) {
      const pyStart = y0 + m * modPx;
      if (pyStart >= height) break;
      const val = modules[m] ? barLuma : spaceLuma;
      const pyStop = Math.min(height, pyStart + modPx);
      for (let y = pyStart; y < pyStop; y++) {
        luma.fill(val, y * width + x0, y * width + x1);
      }
    }
  }
  return luma;
}

function randomNonTsxPayload(rng) {
  const prefixes = ['PKG', 'BOX', 'SHP', 'LOC', 'INV'];
  let s = prefixes[(rng() * prefixes.length) | 0] + '-';
  for (let i = 0; i < 6; i++) s += ALPHANUM[(rng() * ALPHANUM.length) | 0];
  return s;
}

function randomTsxPayload(rng) {
  const d0 = (rng() * 10) | 0;
  const d1 = (rng() * 10) | 0;
  let s = `tsX${d0}${d1}`;
  for (let i = 0; i < 6; i++) s += BASE36[(rng() * 36) | 0];
  return s;
}

/**
 * Generates a single deterministic negative/false-positive fixture by `kind` and `seed`.
 *
 * @param {string} kind - one of `NEGATIVE_KINDS`
 * @param {{ seed?: number, width?: number, height?: number }} [opts]
 */
export function generateNegativeFixture(kind, opts = {}) {
  const seed = (opts.seed ?? 1) >>> 0;
  const rng = mulberry32(seed ^ 0x6c62272e);
  const width = opts.width || 480;
  const height = opts.height || 480;
  const id = `${kind}-s${seed}`;

  if (kind === 'valid-non-tsx') {
    const payload = randomNonTsxPayload(rng);
    const enc = encodeCode128B(payload, 10);
    const luma = renderStripToFrame(enc.modules, width, height, {
      orientation: 'ladder',
      modPx: 2,
      barSpanPx: 140,
    });
    return {
      id,
      kind,
      seed,
      luma,
      width,
      height,
      expectedPayloads: [payload],
      allowValidNonTsx: true,
      failOnAnyAccept: false,
    };
  }

  if (kind === 'truncated-partial') {
    const payload = randomTsxPayload(rng);
    const enc = encodeCode128B(payload, 10);
    const mods = new Uint8Array(enc.modules);
    // Cut off last 28..56 modules (simulating frame edge or lip occlusion)
    const cut = mods.length - (28 + ((rng() * 28) | 0));
    for (let i = cut; i < mods.length; i++) mods[i] = 0;
    const luma = renderStripToFrame(mods, width, height, {
      orientation: 'ladder',
      modPx: 2,
      barSpanPx: 140,
    });
    return {
      id,
      kind,
      seed,
      luma,
      width,
      height,
      expectedPayloads: [],
      allowValidNonTsx: false,
      failOnAnyAccept: true,
    };
  }

  if (kind === 'tsx-broken-check') {
    const payload = randomTsxPayload(rng);
    const syms = new Uint8Array(payload.length + 2);
    syms[0] = CODE128_START_B;
    for (let i = 0; i < payload.length; i++) syms[i + 1] = payload.charCodeAt(i) - 32;
    const trueCheck = mod103Check(syms, payload.length + 1);
    const delta = 1 + ((rng() * 102) | 0);
    syms[payload.length + 1] = (trueCheck + delta) % 103;
    const mods = encodeRawSymbols(syms, true, 10);
    const luma = renderStripToFrame(mods, width, height, {
      orientation: 'ladder',
      modPx: 2,
      barSpanPx: 140,
    });
    return {
      id,
      kind,
      seed,
      luma,
      width,
      height,
      expectedPayloads: [],
      allowValidNonTsx: false,
      failOnAnyAccept: true,
    };
  }

  if (kind === 'tsx-prefix-random-bars') {
    const syms = new Uint8Array([CODE128_START_B, 84, 83, 56]); // StartB + 't' + 's' + 'X'
    const prefix = encodeRawSymbols(syms, false, 10);
    const mods = new Uint8Array(176);
    // Copy leading quiet + 44-module tsX crib
    const prefixEnd = 10 + 44;
    for (let i = 0; i < prefixEnd; i++) mods[i] = prefix[i];
    let c = prefixEnd;
    let isBar = 1;
    while (c < 166) {
      const w = 1 + ((rng() * 4) | 0);
      for (let k = 0; k < w && c < 166; k++) mods[c++] = isBar;
      isBar ^= 1;
    }
    const luma = renderStripToFrame(mods, width, height, {
      orientation: 'ladder',
      modPx: 2,
      barSpanPx: 140,
    });
    return {
      id,
      kind,
      seed,
      luma,
      width,
      height,
      expectedPayloads: [],
      allowValidNonTsx: false,
      failOnAnyAccept: true,
    };
  }

  if (kind === 'ean-code39-lookalike') {
    const useCode39 = (seed & 1) === 1;
    let mods;
    if (useCode39) {
      const chars = [0, 1, 4, 7, 2, 9, 5, 3, 0]; // *1472953*
      const bits = [];
      for (let q = 0; q < 10; q++) bits.push(0);
      for (let ci = 0; ci < chars.length; ci++) {
        const pat = CODE39_PATTERNS[chars[ci]];
        for (let r = 0; r < pat.length; r++) {
          const w = pat.charCodeAt(r) - 48;
          const isBar = (r & 1) === 0 ? 1 : 0;
          for (let k = 0; k < w; k++) bits.push(isBar);
        }
        bits.push(0);
      }
      for (let q = 0; q < 10; q++) bits.push(0);
      mods = new Uint8Array(bits);
    } else {
      // EAN-13 style: 101 + 6x7 L-digits + 01010 + 6x7 R-digits (inverted) + 101
      const bits = [];
      for (let q = 0; q < 10; q++) bits.push(0);
      bits.push(1, 0, 1);
      for (let d = 0; d < 6; d++) {
        const pat = EAN_L_CODES[(rng() * 10) | 0];
        for (let k = 0; k < 7; k++) bits.push(pat.charCodeAt(k) - 48);
      }
      bits.push(0, 1, 0, 1, 0);
      for (let d = 0; d < 6; d++) {
        const pat = EAN_L_CODES[(rng() * 10) | 0];
        for (let k = 0; k < 7; k++) bits.push(1 - (pat.charCodeAt(k) - 48));
      }
      bits.push(1, 0, 1);
      for (let q = 0; q < 10; q++) bits.push(0);
      mods = new Uint8Array(bits);
    }
    const luma = renderStripToFrame(mods, width, height, {
      orientation: 'picket',
      modPx: 2,
      barSpanPx: 140,
    });
    return {
      id,
      kind,
      seed,
      luma,
      width,
      height,
      expectedPayloads: [],
      allowValidNonTsx: false,
      failOnAnyAccept: true,
    };
  }

  if (kind === 'shipping-text-block') {
    const luma = new Uint8Array(width * height);
    luma.fill(230);
    // Outer shipping label box border
    for (let x = 40; x < width - 40; x++) {
      for (let t = 0; t < 4; t++) {
        luma[(40 + t) * width + x] = 28;
        luma[(height - 44 + t) * width + x] = 28;
      }
    }
    for (let y = 40; y < height - 40; y++) {
      for (let t = 0; t < 4; t++) {
        luma[y * width + (40 + t)] = 28;
        luma[y * width + (width - 44 + t)] = 28;
      }
    }
    // Multi-line dense faux-text glyph strokes
    for (let line = 0; line < 14; line++) {
      const yBase = 64 + line * 26;
      if (yBase + 14 >= height - 48) break;
      let x = 58;
      while (x < width - 64) {
        const glyphW = 6 + ((rng() * 6) | 0);
        const isSpace = rng() < 0.18;
        if (!isSpace) {
          for (let gy = 0; gy < 12; gy++) {
            for (let gx = 0; gx < glyphW; gx++) {
              const stroke = ((gx === 0 || gx === glyphW - 1 || gy === 0 || gy === 5 || gy === 11) && rng() > 0.28);
              if (stroke && x + gx < width - 54) {
                luma[(yBase + gy) * width + (x + gx)] = 30;
              }
            }
          }
        }
        x += glyphW + 3;
      }
    }
    return {
      id,
      kind,
      seed,
      luma,
      width,
      height,
      expectedPayloads: [],
      allowValidNonTsx: false,
      failOnAnyAccept: true,
    };
  }

  if (kind === 'tape-seams-tote-ribs') {
    const luma = new Uint8Array(width * height);
    const phase = rng() * Math.PI * 2;
    for (let y = 0; y < height; y++) {
      // Horizontal structural tote ribs (ladder-like periodic ridges)
      const rib = Math.sin(y * 0.42 + phase);
      const ribVal = rib > 0.35 ? 62 : (rib < -0.35 ? 172 : 118);
      const rowOff = y * width;
      for (let x = 0; x < width; x++) {
        let v = ribVal;
        // Glossy packing tape seam running vertically down the middle
        if (x >= (width >> 1) - 18 && x <= (width >> 1) + 18) {
          v = Math.min(248, v + 52);
          if (Math.abs(x - (width >> 1)) === 18) v = 35;
        }
        luma[rowOff + x] = v;
      }
    }
    return {
      id,
      kind,
      seed,
      luma,
      width,
      height,
      expectedPayloads: [],
      allowValidNonTsx: false,
      failOnAnyAccept: true,
    };
  }

  if (kind === 'repeated-fabric-clutter') {
    const luma = new Uint8Array(width * height);
    const freqX = 3 + ((rng() * 4) | 0);
    const freqY = 3 + ((rng() * 4) | 0);
    for (let y = 0; y < height; y++) {
      const rowOff = y * width;
      const diagShift = ((y / freqY) | 0) & 1 ? 1 : -1;
      for (let x = 0; x < width; x++) {
        const stripe = (((x + y * diagShift) / freqX) | 0) & 1;
        const micro = (((x * 3 + y * 5) ^ seed) & 15) - 8;
        let v = (stripe ? 215 : 42) + micro;
        if (v < 0) v = 0;
        else if (v > 255) v = 255;
        luma[rowOff + x] = v;
      }
    }
    return {
      id,
      kind,
      seed,
      luma,
      width,
      height,
      expectedPayloads: [],
      allowValidNonTsx: false,
      failOnAnyAccept: true,
    };
  }

  if (kind === 'picket-rotated-90') {
    const payload = randomNonTsxPayload(rng);
    const enc = encodeCode128B(payload, 10);
    const luma = renderStripToFrame(enc.modules, width, height, {
      orientation: 'picket',
      modPx: 2,
      barSpanPx: 140,
    });
    return {
      id,
      kind,
      seed,
      luma,
      width,
      height,
      expectedPayloads: [payload],
      allowValidNonTsx: true,
      failOnAnyAccept: false,
    };
  }

  throw new Error(`Unknown negative fixture kind: ${kind}`);
}

/**
 * Generates the full 9-category negative fixture suite for a given seed.
 *
 * @param {{ seed?: number, width?: number, height?: number }} [opts]
 */
export function generateNegativeSuite(opts = {}) {
  const baseSeed = (opts.seed ?? 1) >>> 0;
  return NEGATIVE_KINDS.map((kind, idx) =>
    generateNegativeFixture(kind, {
      ...opts,
      seed: (baseSeed + idx * 1013) >>> 0,
    })
  );
}

/**
 * Evaluates decoded payloads for a negative fixture under loose or strict mode.
 * Returns `{ falsePositives: string[], validHits: string[], ok: boolean }`.
 *
 * @param {object} fixture
 * @param {Array<{ payload: string }>} detections
 * @param {{ strict?: boolean }} [opts]
 */
export function scoreNegativeFixture(fixture, detections, opts = {}) {
  const strict = Boolean(opts && opts.strict);
  const expectedSet = new Set(fixture.expectedPayloads || []);
  const falsePositives = [];
  const validHits = [];

  for (let i = 0; i < detections.length; i++) {
    const payload = detections[i].payload;
    if (fixture.failOnAnyAccept) {
      falsePositives.push(payload);
    } else if (strict && !payload.startsWith('tsX')) {
      falsePositives.push(payload);
    } else if (expectedSet.has(payload)) {
      validHits.push(payload);
    } else {
      falsePositives.push(payload);
    }
  }

  return {
    falsePositives,
    validHits,
    ok: falsePositives.length === 0,
  };
}
