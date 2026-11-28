/**
 * H2 — False-Positive Stress Test (`requirePrefix + cribMatch`, 50,000 seeded frames).
 *
 * Runs 50,000 deterministic (`mulberry32`, never `Math.random`) synthetic frames through
 * `processFrameMulti` (plus a dedicated single-line-accept `processFrame` adversarial batch
 * where `neededVotes = 1` activates on `tsX` crib matches) with `FLAG_REQUIRE_PREFIX | FLAG_CRIB_MATCH`:
 *   1. Pure noise (uniform, Gaussian-approx, salt-and-pepper, blocky)
 *   2. Random 1D run-length ladders (high-contrast stripes stamped across rows)
 *   3. Truncated and bar-corrupted `tsX` labels
 *   4. Valid non-`tsX` Code 128B/C labels (correct decode is NOT a false positive; wrong payload IS)
 *   5. `tsX` lookalikes: exact StartB+'t'+'s'+'X' crib (44 modules) followed by garbage/random bars
 *   6. `tsX` lookalikes: exact StartB+'t'+'s'+'X' + valid data + flipped Mod-103 check digit + Stop
 *
 * Usage:
 *   node tests/fp-stress.test.js                # Full 50,000-frame stress run
 *   node tests/fp-stress.test.js --frames=5000  # Faster custom count
 *   FP_STRESS_FRAMES=5000 node tests/fp-stress.test.js
 */
import assert from 'node:assert/strict';
import { mulberry32 } from '../src/sim/prng.js';
import {
  CODE128_PATTERNS,
  CODE128_STOP_PATTERN,
  CODE128_START_B,
  encodeCode128,
} from './harness.js';
import {
  createPipelineState,
  createPipelineResult,
  processFrame,
  processFrameMulti,
  extractPayloadString,
  extractMultiDetections,
} from '../src/worker/scanner.worker.js';
import {
  FLAG_CRIB_MATCH,
  FLAG_REQUIRE_PREFIX,
  FLAG_REQUIRE_PREFIX_STRICT,
  FLAG_SCAN_SMOOTH,
  FLAG_STOP_GUARD,
} from '../src/worker/flagbits.js';

const W = 384;
const H = 80;
const BAR_Y0 = 10;
const BAR_Y1 = 70; // 60 px tall -> covers all 3 horizontal fallback lines (cy=40, 4, 76) and RoI blocks
const FLAGS_H2 = FLAG_REQUIRE_PREFIX | FLAG_CRIB_MATCH;

function parseFrameCount() {
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--frames=')) {
      const n = Number(arg.slice('--frames='.length));
      if (Number.isFinite(n) && n >= 60) return n | 0;
    }
  }
  const envN = Number(process.env.FP_STRESS_FRAMES);
  if (Number.isFinite(envN) && envN >= 60) return envN | 0;
  return 50000;
}

const BASE36 = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

function randomStr(rng, len, prefix = '') {
  let s = prefix;
  while (s.length < len) {
    s += BASE36[(rng() * BASE36.length) | 0];
  }
  return s;
}

/** Writes a 1D binary module stream (1=bar, 0=space) centered into `rowBuf[0..W-1]` at integer `modPx`. */
function renderModulesToRow(modules, modLen, modPx, barLuma, spaceLuma, rowBuf) {
  rowBuf.fill(spaceLuma);
  const totalPx = modLen * modPx;
  const x0 = Math.max(0, ((W - totalPx) >> 1));
  for (let m = 0; m < modLen; m++) {
    const pxStart = x0 + m * modPx;
    if (pxStart >= W) break;
    const val = modules[m] === 1 ? barLuma : spaceLuma;
    const pxEnd = Math.min(W, pxStart + modPx);
    for (let x = pxStart; x < pxEnd; x++) rowBuf[x] = val;
  }
}

/** Stamps `rowBuf` across barcode rows `[BAR_Y0..BAR_Y1)` and fills margins with `bgLuma`. */
function stampRowBand(luma, rowBuf, bgLuma, rng, noiseAmp) {
  for (let y = 0; y < BAR_Y0; y++) luma.fill(bgLuma, y * W, (y + 1) * W);
  for (let y = BAR_Y1; y < H; y++) luma.fill(bgLuma, y * W, (y + 1) * W);
  for (let y = BAR_Y0; y < BAR_Y1; y++) {
    const off = y * W;
    luma.set(rowBuf, off);
    if (noiseAmp > 0) {
      // Sparse per-row jitter on a few samples to avoid slow full-frame RNG loops
      for (let x = 0; x < W; x += 4) {
        const d = (((rng() - 0.5) * 2 * noiseAmp) | 0);
        let v = luma[off + x] + d;
        if (v < 0) v = 0;
        else if (v > 255) v = 255;
        luma[off + x] = v;
      }
    }
  }
}

/** Encodes a raw Code 128 symbol list (with optional Stop) into pre-allocated `modBuf`. Returns module count. */
function encodeSymbolsToModules(symbols, symCount, includeStop, quietMods, modBuf) {
  let c = 0;
  for (let q = 0; q < quietMods; q++) modBuf[c++] = 0;
  for (let s = 0; s < symCount; s++) {
    const base = symbols[s] * 6;
    for (let r = 0; r < 6; r++) {
      const w = CODE128_PATTERNS[base + r];
      const isBar = (r & 1) === 0 ? 1 : 0;
      for (let k = 0; k < w; k++) modBuf[c++] = isBar;
    }
  }
  if (includeStop) {
    for (let r = 0; r < 7; r++) {
      const w = CODE128_STOP_PATTERN[r];
      const isBar = (r & 1) === 0 ? 1 : 0;
      for (let k = 0; k < w; k++) modBuf[c++] = isBar;
    }
  }
  for (let q = 0; q < quietMods; q++) modBuf[c++] = 0;
  return c;
}

function mod103Check(symbols, countWithoutCheck) {
  let sum = symbols[0];
  for (let i = 1; i < countWithoutCheck; i++) sum += i * symbols[i];
  return sum % 103;
}

// Reusable scratch buffers (zero GC churn over 50,000 frames)
const frameBuf = new Uint8Array(W * H);
const rowBuf = new Uint8Array(W);
const modBuf = new Uint8Array(512);
const symBuf = new Uint8Array(32);

function generateFrame(category, seed) {
  const rng = mulberry32(seed);
  const barLuma = 18 + ((rng() * 35) | 0);
  const spaceLuma = 205 + ((rng() * 45) | 0);
  const bgLuma = 135 + ((rng() * 60) | 0);

  if (category === 0) {
    // 1. Pure noise (fast tiled / salt-and-pepper / uniform / blocky)
    const mode = seed & 3;
    if (mode === 0) {
      // Uniform per-pixel noise on middle band (fast 32-bit xorshift step seeded from mulberry32)
      let x = (rng() * 0xffffffff) >>> 0 || 1;
      for (let i = 0; i < frameBuf.length; i++) {
        x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
        frameBuf[i] = x & 255;
      }
    } else if (mode === 1) {
      // High-contrast binary salt-and-pepper
      let x = (rng() * 0xffffffff) >>> 0 || 7;
      for (let i = 0; i < frameBuf.length; i++) {
        x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
        frameBuf[i] = (x & 1) ? spaceLuma : barLuma;
      }
    } else if (mode === 2) {
      // Blocky 2x2 textured noise
      let x = (rng() * 0xffffffff) >>> 0 || 13;
      for (let y = 0; y < H; y += 2) {
        const r0 = y * W;
        const r1 = (y + 1) * W;
        for (let col = 0; col < W; col += 2) {
          x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
          const v = x & 255;
          frameBuf[r0 + col] = v; frameBuf[r0 + col + 1] = v;
          frameBuf[r1 + col] = v; frameBuf[r1 + col + 1] = v;
        }
      }
    } else {
      // Row-correlated Gaussian-ish noise
      let x = (rng() * 0xffffffff) >>> 0 || 29;
      for (let i = 0; i < W; i++) {
        x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
        const g = ((x & 255) + ((x >>> 8) & 255) + ((x >>> 16) & 255)) / 3;
        rowBuf[i] = g | 0;
      }
      stampRowBand(frameBuf, rowBuf, bgLuma, rng, 12);
    }
    return { expectedPayload: null, categoryName: 'noise' };
  }

  if (category === 1) {
    // 2. Random 1D run-length ladders (high contrast vertical bars, 1..9 px runs)
    rowBuf.fill(spaceLuma);
    let x = 14 + ((rng() * 12) | 0);
    let isBar = 1;
    while (x < W - 14) {
      const runW = 1 + ((rng() * 9) | 0);
      const val = isBar ? barLuma : spaceLuma;
      const end = Math.min(W - 14, x + runW);
      for (; x < end; x++) rowBuf[x] = val;
      isBar ^= 1;
    }
    stampRowBand(frameBuf, rowBuf, bgLuma, rng, 0);
    return { expectedPayload: null, categoryName: 'random-ladder' };
  }

  if (category === 2) {
    // 3. Truncated or corrupted tsX labels
    const payload = randomStr(rng, 11, 'tsX');
    const enc = encodeCode128(payload, { subset: 'B', quietZoneModules: 10 });
    modBuf.set(enc.modules);
    const total = enc.totalModules;
    const subMode = seed % 3;
    if (subMode === 0) {
      // Right-truncated before Stop (cut off last 18..65 modules, simulating frame edge or tote lip)
      const cut = total - (18 + ((rng() * 48) | 0));
      for (let m = cut; m < total; m++) modBuf[m] = 0;
    } else if (subMode === 1) {
      // Physical bar damage: dark or white smudge/scuff wiping out 18..42 contiguous modules
      const start = 54 + ((rng() * 45) | 0);
      const span = 18 + ((rng() * 25) | 0);
      const val = (seed & 1) ? 1 : 0;
      for (let m = start; m < Math.min(total - 10, start + span); m++) modBuf[m] = val;
    } else {
      // Left-truncated (lip/edge cuts off Start + leading symbols) or missing quiet zones jammed with dense bars
      if ((seed & 1) === 0) {
        const cut = 18 + ((rng() * 45) | 0);
        for (let m = 0; m < cut; m++) modBuf[m] = 0;
      } else {
        // Double smudge: wipe both a 16-module dark blotch and a 16-module white glare tear
        const sA = 54 + ((rng() * 25) | 0);
        const sB = sA + 28 + ((rng() * 25) | 0);
        for (let m = sA; m < Math.min(total - 10, sA + 16); m++) modBuf[m] = 1;
        for (let m = sB; m < Math.min(total - 10, sB + 16); m++) modBuf[m] = 0;
      }
    }
    renderModulesToRow(modBuf, total, 2, barLuma, spaceLuma, rowBuf);
    stampRowBand(frameBuf, rowBuf, bgLuma, rng, 0);
    return { expectedPayload: null, categoryName: 'truncated-corrupted-tsx' };
  }

  if (category === 3) {
    // 4. Valid non-tsX Code 128B label (decoding exact payload is VALID, NOT a false positive)
    let payload = randomStr(rng, 8 + ((rng() * 4) | 0));
    if (payload.startsWith('tsX')) payload = 'ABZ' + payload.slice(3);
    const enc = encodeCode128(payload, { subset: 'B', quietZoneModules: 10 });
    renderModulesToRow(enc.modules, enc.totalModules, 2, barLuma, spaceLuma, rowBuf);
    stampRowBand(frameBuf, rowBuf, bgLuma, rng, 0);
    return { expectedPayload: payload, categoryName: 'valid-non-tsx' };
  }

  if (category === 4) {
    // 5. tsX lookalike: exact StartB + 't'(84) + 's'(83) + 'X'(56) (44-module crib!), then garbage
    if ((seed & 1) === 0) {
      // 44-module real tsX crib + random bar/space runs (no valid symbol framing)
      symBuf[0] = CODE128_START_B;
      symBuf[1] = 84; // 't'
      symBuf[2] = 83; // 's'
      symBuf[3] = 56; // 'X'
      const prefixMods = encodeSymbolsToModules(symBuf, 4, false, 10, modBuf) - 10; // keep leading quiet only
      let c = prefixMods;
      let isBar = 1;
      while (c < 166) {
        const w = 1 + ((rng() * 4) | 0);
        for (let k = 0; k < w && c < 166; k++) modBuf[c++] = isBar;
        isBar ^= 1;
      }
      for (let q = 0; q < 10; q++) modBuf[c++] = 0;
      renderModulesToRow(modBuf, c, 2, barLuma, spaceLuma, rowBuf);
    } else {
      // 44-module real tsX crib + random Code 128 symbols + real Stop, guaranteed INVALID checksum
      const dataSyms = 4 + ((rng() * 5) | 0); // 4..8 random symbols after tsX
      symBuf[0] = CODE128_START_B;
      symBuf[1] = 84;
      symBuf[2] = 83;
      symBuf[3] = 56;
      for (let k = 0; k < dataSyms; k++) symBuf[4 + k] = (rng() * 95) | 0;
      const checkIdx = 4 + dataSyms;
      const trueCheck = mod103Check(symBuf, checkIdx);
      const wrongDelta = 1 + ((rng() * 102) | 0);
      symBuf[checkIdx] = (trueCheck + wrongDelta) % 103;
      const total = encodeSymbolsToModules(symBuf, checkIdx + 1, true, 10, modBuf);
      renderModulesToRow(modBuf, total, 2, barLuma, spaceLuma, rowBuf);
    }
    stampRowBand(frameBuf, rowBuf, bgLuma, rng, 0);
    return { expectedPayload: null, categoryName: 'tsx-lookalike-garbage' };
  }

  // 6. Valid tsX label with a flipped Mod-103 check digit (exact 44-module crib + valid data + valid Stop)
  const payload = randomStr(rng, 11, 'tsX');
  symBuf[0] = CODE128_START_B;
  for (let k = 0; k < payload.length; k++) symBuf[1 + k] = payload.charCodeAt(k) - 32;
  const checkIdx = 1 + payload.length;
  const trueCheck = mod103Check(symBuf, checkIdx);
  const delta = 1 + ((rng() * 102) | 0); // guaranteed != 0 mod 103
  symBuf[checkIdx] = (trueCheck + delta) % 103;
  const total = encodeSymbolsToModules(symBuf, checkIdx + 1, true, 10, modBuf);
  renderModulesToRow(modBuf, total, 2, barLuma, spaceLuma, rowBuf);
  stampRowBand(frameBuf, rowBuf, bgLuma, rng, 0);
  return { expectedPayload: null, categoryName: 'tsx-flipped-check' };
}

let passed = 0;
function test(name, fn) {
  fn();
  console.log(`  PASS  ${name}`);
  passed++;
}

const TOTAL_FRAMES = parseFrameCount();
// Category weights out of 10: [2 noise, 2 random-ladder, 2 truncated/corrupted, 1 valid-non-tsx, 2 tsx-lookalike, 1 tsx-flipped-check]
const CAT_SCHEDULE = [0, 0, 1, 1, 2, 2, 3, 4, 4, 5];

console.log(`Running H2 false-positive stress tests (${TOTAL_FRAMES} seeded frames)...`);

test(`H2 processFrameMulti (${TOTAL_FRAMES} seeded frames, requirePrefix+cribMatch) accepts 0 wrong payloads`, () => {
  const state = createPipelineState(W, H);
  const result = createPipelineResult();
  state.flags = FLAGS_H2;

  const t0 = performance.now();
  let wrongCount = 0;
  let validNonTsxTotal = 0;
  let validNonTsxDecoded = 0;
  const firstWrong = [];

  for (let i = 0; i < TOTAL_FRAMES; i++) {
    const seed = (0x9E3779B9 + Math.imul(i + 1, 0x85EBCA6B)) >>> 0;
    const cat = CAT_SCHEDULE[i % CAT_SCHEDULE.length];
    const { expectedPayload, categoryName } = generateFrame(cat, seed);
    if (expectedPayload !== null) validNonTsxTotal++;

    const detCount = processFrameMulti(frameBuf, W, H, state, result, false);
    if (detCount > 0) {
      const dets = extractMultiDetections(state);
      for (let d = 0; d < dets.length; d++) {
        const got = dets[d].payload;
        if (expectedPayload !== null && got === expectedPayload) {
          validNonTsxDecoded++;
        } else {
          wrongCount++;
          if (firstWrong.length < 5) {
            firstWrong.push({ frame: i, seed, categoryName, expectedPayload, got });
          }
        }
      }
    }
  }

  const elapsedSec = (performance.now() - t0) / 1000;
  const empiricalRate = wrongCount / TOTAL_FRAMES;
  const ruleOf3Bound = 3 / TOTAL_FRAMES;
  const mod103SingleLineBound = 1 / 103;
  const tsxPrefixPlusCheckBound = Math.pow(1 / 103, 4);

  console.log(
    `  INFO  H2 multi: ${TOTAL_FRAMES} frames in ${elapsedSec.toFixed(2)}s | ` +
    `wrongFP=${wrongCount} (empirical=${empiricalRate.toExponential(2)}, 95%-CI upper<=${ruleOf3Bound.toExponential(2)}) | ` +
    `validNonTsx=${validNonTsxDecoded}/${validNonTsxTotal}`
  );
  console.log(
    `  INFO  H2 theoretical bounds: Mod-103 single-candidate <= ${mod103SingleLineBound.toExponential(2)}; ` +
    `3-sym tsX prefix + Mod-103 on random symbols <= ${tsxPrefixPlusCheckBound.toExponential(2)}`
  );

  if (wrongCount > 0) {
    console.error('  FAIL  False positive seeds:', JSON.stringify(firstWrong));
  }
  assert.equal(wrongCount, 0, `expected 0 false positives, got ${wrongCount}; first=${JSON.stringify(firstWrong[0])}`);
  assert.ok(
    validNonTsxDecoded >= Math.floor(validNonTsxTotal * 0.90),
    `valid non-tsX decode sanity too low: ${validNonTsxDecoded}/${validNonTsxTotal}`
  );
});

test('H2 single-line-accept processFrame path (neededVotes=1 on tsX crib) accepts 0 wrong payloads across 5,000 adversarial frames', () => {
  const state = createPipelineState(W, H);
  const result = createPipelineResult();
  state.flags = FLAGS_H2;

  // Sanity check: a real valid tsX barcode actually hits cribMatched=1 and locks in 1 line
  const validEnc = encodeCode128('tsX07wz7py1', { subset: 'B', quietZoneModules: 10 });
  renderModulesToRow(validEnc.modules, validEnc.totalModules, 2, 24, 232, rowBuf);
  stampRowBand(frameBuf, rowBuf, 160, mulberry32(12345), 0);
  const ok = processFrame(frameBuf, W, H, state, result, false);
  assert.equal(ok, 1);
  assert.equal(extractPayloadString(result), 'tsX07wz7py1');
  assert.equal(state.consensus.c128.cribMatched, 1);
  assert.equal(result.consensusCount, 1, 'requirePrefix+cribMatch single-line path should lock on 1 vote');

  // Now hammer the single-line-accept path with adversarial categories (noise, ladders, corrupted tsX, tsX+garbage, flipped check)
  const ADV_CATS = [0, 1, 2, 4, 4, 5, 5];
  const ADV_FRAMES = Math.min(5000, Math.max(300, Math.floor(TOTAL_FRAMES / 10)));
  let wrongCount = 0;
  let firstWrong = null;

  for (let i = 0; i < ADV_FRAMES; i++) {
    const seed = (0x517CC1B7 + Math.imul(i + 1, 0x27D4EB2D)) >>> 0;
    const cat = ADV_CATS[i % ADV_CATS.length];
    const { categoryName } = generateFrame(cat, seed);
    const dec = processFrame(frameBuf, W, H, state, result, false);
    if (dec === 1) {
      wrongCount++;
      if (!firstWrong) {
        firstWrong = { frame: i, seed, categoryName, got: extractPayloadString(result), consensusCount: result.consensusCount };
      }
    }
  }
  console.log(
    `  INFO  H2 single-line (processFrame): ${ADV_FRAMES} adversarial frames | wrongFP=${wrongCount} (95%-CI upper<=${(3 / ADV_FRAMES).toExponential(2)})`
  );
  if (wrongCount > 0) {
    console.error('  FAIL  Single-line FP seed:', JSON.stringify(firstWrong));
  }
  assert.equal(wrongCount, 0, `single-line path accepted wrong payload: ${JSON.stringify(firstWrong)}`);
});

test('H2 requirePrefixStrict rejects valid non-tsX labels while accepting valid tsX labels', () => {
  const state = createPipelineState(W, H);
  const result = createPipelineResult();
  state.flags = FLAGS_H2 | FLAG_REQUIRE_PREFIX_STRICT;

  for (let i = 0; i < 20; i++) {
    const seed = (0xA5A5A5A5 + i * 7919) >>> 0;
    generateFrame(3, seed); // valid non-tsX
    const detCount = processFrameMulti(frameBuf, W, H, state, result, false);
    assert.equal(detCount, 0, `requirePrefixStrict must reject non-tsX label (seed=${seed})`);
  }

  const enc = encodeCode128('tsX07wz7py1', { subset: 'B', quietZoneModules: 10 });
  renderModulesToRow(enc.modules, enc.totalModules, 2, 24, 232, rowBuf);
  stampRowBand(frameBuf, rowBuf, 160, mulberry32(999), 0);
  const detCount = processFrameMulti(frameBuf, W, H, state, result, false);
  assert.equal(detCount, 1);
  assert.equal(extractMultiDetections(state)[0].payload, 'tsX07wz7py1');
});

/**
 * Renders a 1D binary module stream rotated by `angleDeg` into a pre-allocated `w x h`
 * grayscale buffer, optionally clipping the trailing `clipRightMods` modules or applying
 * 1D horizontal blur along the rotated barcode axis (zero external deps, pure deterministic RNG).
 */
function renderRotatedLabel(modules, modLen, angleDeg, modPx, barH, barLuma, spaceLuma, bgLuma, rng, opts, outBuf, w, h) {
  const clipRightMods = opts.clipRightMods || 0;
  const effectiveMods = Math.max(20, modLen - clipRightMods);
  const rad = (angleDeg * Math.PI) / 180;
  const cosA = Math.cos(rad);
  const sinA = Math.sin(rad);
  const cx = w * 0.5;
  const cy = h * 0.5;
  const halfLen = (effectiveMods * modPx) * 0.5;
  const halfH = barH * 0.5;
  const invModPx = 1.0 / modPx;
  const noiseAmp = opts.noiseAmp || 0;

  let xorshift = (rng() * 0xffffffff) >>> 0 || 17;
  for (let y = 0; y < h; y++) {
    const dy = y - cy;
    const rowOff = y * w;
    for (let x = 0; x < w; x++) {
      const dx = x - cx;
      const u = dx * cosA + dy * sinA + halfLen;
      const v = -dx * sinA + dy * cosA;
      let val = bgLuma;
      if (v >= -halfH && v <= halfH && u >= 0 && u < effectiveMods * modPx) {
        const mPos = u * invModPx;
        const m0 = mPos | 0;
        const frac = mPos - m0;
        // 2-tap linear anti-aliasing along module axis simulates finite sensor PSF / oblique sampling
        const b0 = m0 < effectiveMods ? modules[m0] : 0;
        const b1 = (m0 + 1) < effectiveMods ? modules[m0 + 1] : b0;
        const cov = b0 + (b1 - b0) * (frac > 0.7 ? (frac - 0.7) * 3.33 : 0);
        val = (spaceLuma + (barLuma - spaceLuma) * cov) | 0;
      }
      if (noiseAmp > 0) {
        xorshift ^= xorshift << 13; xorshift ^= xorshift >>> 17; xorshift ^= xorshift << 5;
        val += (((xorshift & 255) - 128) * noiseAmp) >> 7;
        if (val < 0) val = 0; else if (val > 255) val = 255;
      }
      outBuf[rowOff + x] = val;
    }
  }
}

test('H2/F1 rotated 25-40 deg and clipped-tail stress batch (stopGuard) produces 0 FP', () => {
  const RW = 480;
  const RH = 320;
  const rotBuf = new Uint8Array(RW * RH);
  const state = createPipelineState(RW, RH);
  const result = createPipelineResult();
  const flagsRot = FLAGS_H2 | FLAG_SCAN_SMOOTH | FLAG_STOP_GUARD;
  state.flags = flagsRot;

  const ROT_FRAMES = Math.min(480, Math.max(120, Math.floor(TOTAL_FRAMES / 100)));
  let wrongCount = 0;
  let validRotTotal = 0;
  let validRotDecoded = 0;
  let firstWrong = null;

  for (let i = 0; i < ROT_FRAMES; i++) {
    const seed = (0xC2B2AE35 + Math.imul(i + 1, 0x165667B1)) >>> 0;
    const rng = mulberry32(seed);
    const angleDeg = 25 + rng() * 15; // [25, 40] deg
    const modPx = 1.45 + rng() * 0.75; // low-to-medium PPM [1.45 .. 2.20]
    const barLuma = 20 + ((rng() * 30) | 0);
    const spaceLuma = 210 + ((rng() * 40) | 0);
    const bgLuma = 140 + ((rng() * 55) | 0);
    const mode = i % 4;

    let expectedPayload = null;
    let modeName = '';

    if (mode === 0) {
      // Valid rotated 25-40 deg tsX label (including tsX41A00013B)
      modeName = 'rotated-valid-tsx';
      const payload = (i % 8 === 0) ? 'tsX41A00013B' : randomStr(rng, 11, 'tsX');
      const enc = encodeCode128(payload, { subset: 'B', quietZoneModules: 10 });
      modBuf.set(enc.modules);
      renderRotatedLabel(
        modBuf, enc.totalModules, angleDeg, modPx, 68, barLuma, spaceLuma, bgLuma, rng,
        { clipRightMods: 0, noiseAmp: 6 }, rotBuf, RW, RH
      );
      expectedPayload = payload;
      validRotTotal++;
    } else if (mode === 1) {
      // Rotated 25-40 deg right-clipped tail (cuts off trailing quiet zone + >= 3 modules of Stop/check)
      modeName = 'rotated-clipped-tail';
      const payload = (i % 8 === 1) ? 'tsX41A00013B' : randomStr(rng, 11, 'tsX');
      const enc = encodeCode128(payload, { subset: 'B', quietZoneModules: 10 });
      modBuf.set(enc.modules);
      const clipMods = 13 + ((rng() * 32) | 0); // removes trailing quiet zone + at least 3 modules of Stop
      renderRotatedLabel(
        modBuf, enc.totalModules, angleDeg, modPx, 68, barLuma, spaceLuma, bgLuma, rng,
        { clipRightMods: clipMods, noiseAmp: 4 }, rotBuf, RW, RH
      );
    } else if (mode === 2) {
      // Horizontal clipped-tail cutting into Stop / check symbols (no intact Stop exists)
      modeName = 'horiz-clipped-tail';
      const payload = randomStr(rng, 11, 'tsX');
      const enc = encodeCode128(payload, { subset: 'B', quietZoneModules: 10 });
      modBuf.set(enc.modules);
      const clipMods = 13 + ((rng() * 28) | 0);
      renderRotatedLabel(
        modBuf, enc.totalModules, rng() * 4, modPx, 68, barLuma, spaceLuma, bgLuma, rng,
        { clipRightMods: clipMods, noiseAmp: 4 }, rotBuf, RW, RH
      );
    } else {
      // Rotated 25-40 deg tsX label with flipped Mod-103 check digit
      modeName = 'rotated-flipped-check';
      const payload = randomStr(rng, 11, 'tsX');
      symBuf[0] = CODE128_START_B;
      for (let k = 0; k < payload.length; k++) symBuf[1 + k] = payload.charCodeAt(k) - 32;
      const checkIdx = 1 + payload.length;
      symBuf[checkIdx] = (mod103Check(symBuf, checkIdx) + 1 + ((rng() * 102) | 0)) % 103;
      const total = encodeSymbolsToModules(symBuf, checkIdx + 1, true, 10, modBuf);
      renderRotatedLabel(
        modBuf, total, angleDeg, modPx, 68, barLuma, spaceLuma, bgLuma, rng,
        { clipRightMods: 0, noiseAmp: 6 }, rotBuf, RW, RH
      );
    }

    const detCount = processFrameMulti(rotBuf, RW, RH, state, result, false);
    if (detCount > 0) {
      const dets = extractMultiDetections(state);
      for (let d = 0; d < dets.length; d++) {
        const got = dets[d].payload;
        if (expectedPayload !== null && got === expectedPayload) {
          validRotDecoded++;
        } else {
          wrongCount++;
          if (!firstWrong) {
            firstWrong = { frame: i, seed, modeName, angleDeg: Number(angleDeg.toFixed(1)), modPx: Number(modPx.toFixed(2)), expectedPayload, got };
          }
        }
      }
    }
  }

  console.log(
    `  INFO  H2/F1 rotated(25-40deg)+clipped-tail: ${ROT_FRAMES} frames | wrongFP=${wrongCount} | ` +
    `validRotated=${validRotDecoded}/${validRotTotal}`
  );
  if (wrongCount > 0) {
    console.error('  FAIL  Rotated/clipped FP:', JSON.stringify(firstWrong));
  }
  assert.equal(wrongCount, 0, `expected 0 FP on rotated/clipped-tail batch, got ${wrongCount}; first=${JSON.stringify(firstWrong)}`);
  assert.ok(
    validRotDecoded >= Math.floor(validRotTotal * 0.70),
    `valid rotated 25-40 deg decode rate too low: ${validRotDecoded}/${validRotTotal}`
  );
});

console.log(`All ${passed} false-positive stress tests passed.`);
