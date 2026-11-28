/**
 * L7 — Seeded Per-Label Physical & Print Defects (`src/sim/defects.js`).
 *
 * Flag-gated behind `simDefects` (`scene.defects`). When disabled/null, rendering is
 * bit-for-bit unchanged. All randomness uses deterministic `mulberry32` (never `Math.random`).
 *
 * Models 9 per-label defect mechanisms packed into a flat `Float32Array` (zero hot-loop allocs):
 *  1. Tilt (`±6 deg`)
 *  2. Placement offset (`offsetXIn`, `offsetYIn`)
 *  3. Curvature / peel bar-spacing warp (`peelWarp`)
 *  4. Print gain (`1.0 ± 10%`)
 *  5. Thermal-print dead-dot white streak (`streakU`, `streakHalfW`)
 *  6. Abrasion scuff patch (`scuffU`, `scuffV`, `scuffRadU`, `scuffRadV`, `scuffStrength`)
 *  7. Partial tape / sticker occlusion (`coverFrac`, `coverSide`)
 *  8. Dark smudge blotch (`smudgeU`, `smudgeV`, `smudgeRadU`, `smudgeRadV`, `smudgeStrength`)
 *  9. Missing / truncated quiet zone (`quietCutFrac`)
 */

import { mulberry32 } from './label.js';

const DEG2RAD = Math.PI / 180;

export const DEFECT_STRIDE = 24;

// Flat Float32Array field offsets per cell
export const DEF_OFF_X = 0;
export const DEF_OFF_Y = 1;
export const DEF_COS_TILT = 2;
export const DEF_SIN_TILT = 3;
export const DEF_PEEL_WARP = 4;
export const DEF_PRINT_GAIN = 5;
export const DEF_STREAK_U = 6;
export const DEF_STREAK_HALF_W = 7;
export const DEF_SCUFF_U = 8;
export const DEF_SCUFF_V = 9;
export const DEF_SCUFF_INV_RU = 10;
export const DEF_SCUFF_INV_RV = 11;
export const DEF_SCUFF_STRENGTH = 12;
export const DEF_COVER_FRAC = 13;
export const DEF_COVER_SIDE = 14; // +1 = bottom (v01 >= 1 - frac), -1 = top (v01 <= frac)
export const DEF_SMUDGE_U = 15;
export const DEF_SMUDGE_V = 16;
export const DEF_SMUDGE_INV_RU = 17;
export const DEF_SMUDGE_INV_RV = 18;
export const DEF_SMUDGE_STRENGTH = 19;
export const DEF_QUIET_CUT = 20;  // fraction of quiet zone replaced with dark clutter (0..1)
export const DEF_TILT_DEG = 21;

export const DEFAULT_DEFECTS_SPEC = Object.freeze({
  enabled: true,
  seed: 1,
  maxTiltDeg: 6.0,
  maxOffsetXIn: 0.35,
  maxOffsetYIn: 0.35,
  maxPeelWarp: 0.14,
  maxPrintGainDelta: 0.10,
  streakProb: 0.35,
  scuffProb: 0.35,
  coverProb: 0.25,
  smudgeProb: 0.35,
  quietCutProb: 0.25,
});

/**
 * Normalizes a defects specification.
 * Returns `null` when disabled (`null`, `undefined`, `false`, or `{ enabled: false }`).
 *
 * @param {object | boolean | null | undefined} defects
 * @returns {object | null}
 */
export function normalizeDefectsSpec(defects) {
  if (!defects || defects === false) return null;
  if (defects === true) {
    return { ...DEFAULT_DEFECTS_SPEC, force: null };
  }
  if (defects.enabled === false) return null;

  return {
    enabled: true,
    seed: Number.isFinite(defects.seed) ? (defects.seed >>> 0) : DEFAULT_DEFECTS_SPEC.seed,
    maxTiltDeg: Number.isFinite(defects.maxTiltDeg) ? Math.max(0, defects.maxTiltDeg) : DEFAULT_DEFECTS_SPEC.maxTiltDeg,
    maxOffsetXIn: Number.isFinite(defects.maxOffsetXIn) ? Math.max(0, defects.maxOffsetXIn) : DEFAULT_DEFECTS_SPEC.maxOffsetXIn,
    maxOffsetYIn: Number.isFinite(defects.maxOffsetYIn) ? Math.max(0, defects.maxOffsetYIn) : DEFAULT_DEFECTS_SPEC.maxOffsetYIn,
    maxPeelWarp: Number.isFinite(defects.maxPeelWarp) ? Math.max(0, defects.maxPeelWarp) : DEFAULT_DEFECTS_SPEC.maxPeelWarp,
    maxPrintGainDelta: Number.isFinite(defects.maxPrintGainDelta) ? Math.max(0, Math.min(0.35, defects.maxPrintGainDelta)) : DEFAULT_DEFECTS_SPEC.maxPrintGainDelta,
    streakProb: Number.isFinite(defects.streakProb) ? defects.streakProb : DEFAULT_DEFECTS_SPEC.streakProb,
    scuffProb: Number.isFinite(defects.scuffProb) ? defects.scuffProb : DEFAULT_DEFECTS_SPEC.scuffProb,
    coverProb: Number.isFinite(defects.coverProb) ? defects.coverProb : DEFAULT_DEFECTS_SPEC.coverProb,
    smudgeProb: Number.isFinite(defects.smudgeProb) ? defects.smudgeProb : DEFAULT_DEFECTS_SPEC.smudgeProb,
    quietCutProb: Number.isFinite(defects.quietCutProb) ? defects.quietCutProb : DEFAULT_DEFECTS_SPEC.quietCutProb,
    force: defects.force && typeof defects.force === 'object' ? defects.force : null,
  };
}

/**
 * Generates a packed `Float32Array(numCells * DEFECT_STRIDE)` of deterministic per-cell defects
 * so the renderer reads flat floats with zero allocations in its hot loop.
 *
 * @param {number} numCells
 * @param {object} spec - normalized defects spec from `normalizeDefectsSpec`
 * @param {number} [basePrintGain=1.0]
 * @returns {Float32Array}
 */
export function buildCellDefectsTable(numCells, spec, basePrintGain = 1.0) {
  const table = new Float32Array(numCells * DEFECT_STRIDE);
  const rng = mulberry32((spec.seed >>> 0) ^ 0x7f4a7c15);
  const f = spec.force;

  for (let i = 0; i < numCells; i++) {
    const o = i * DEFECT_STRIDE;

    // 1. Tilt (+/- maxTiltDeg)
    const tiltDeg = (f && Number.isFinite(f.tiltDeg))
      ? f.tiltDeg
      : ((rng() * 2.0 - 1.0) * spec.maxTiltDeg);
    const tiltRad = tiltDeg * DEG2RAD;
    table[o + DEF_TILT_DEG] = tiltDeg;
    table[o + DEF_COS_TILT] = Math.cos(tiltRad);
    table[o + DEF_SIN_TILT] = Math.sin(tiltRad);

    // 2. Placement offset
    table[o + DEF_OFF_X] = (f && Number.isFinite(f.offsetXIn))
      ? f.offsetXIn
      : ((rng() * 2.0 - 1.0) * spec.maxOffsetXIn);
    table[o + DEF_OFF_Y] = (f && Number.isFinite(f.offsetYIn))
      ? f.offsetYIn
      : ((rng() * 2.0 - 1.0) * spec.maxOffsetYIn);

    // 3. Curvature / peel bar-spacing warp
    table[o + DEF_PEEL_WARP] = (f && Number.isFinite(f.peelWarp))
      ? f.peelWarp
      : ((rng() * 2.0 - 1.0) * spec.maxPeelWarp);

    // 4. Print gain (basePrintGain +/- maxPrintGainDelta)
    table[o + DEF_PRINT_GAIN] = (f && Number.isFinite(f.printGain))
      ? f.printGain
      : (basePrintGain + (rng() * 2.0 - 1.0) * spec.maxPrintGainDelta);

    // 5. Thermal-print dead-dot white streak (cross-bar coordinate u in [-0.8, +0.8])
    const hasStreak = (f && f.streak !== undefined)
      ? Boolean(f.streak)
      : (rng() < spec.streakProb);
    if (hasStreak) {
      const sU = (f && f.streak && Number.isFinite(f.streak.u)) ? f.streak.u : ((rng() * 1.4) - 0.7);
      const sW = (f && f.streak && Number.isFinite(f.streak.halfW)) ? f.streak.halfW : (0.04 + rng() * 0.06);
      table[o + DEF_STREAK_U] = sU;
      table[o + DEF_STREAK_HALF_W] = sW;
    }

    // 6. Abrasion scuff patch (elliptical bright fade)
    const hasScuff = (f && f.scuff !== undefined)
      ? Boolean(f.scuff)
      : (rng() < spec.scuffProb);
    if (hasScuff) {
      const sc = (f && f.scuff && typeof f.scuff === 'object') ? f.scuff : null;
      table[o + DEF_SCUFF_U] = (sc && Number.isFinite(sc.u)) ? sc.u : ((rng() * 1.2) - 0.6);
      table[o + DEF_SCUFF_V] = (sc && Number.isFinite(sc.v)) ? sc.v : (0.18 + rng() * 0.64);
      const ru = (sc && Number.isFinite(sc.radU)) ? sc.radU : (0.22 + rng() * 0.25);
      const rv = (sc && Number.isFinite(sc.radV)) ? sc.radV : (0.04 + rng() * 0.06);
      table[o + DEF_SCUFF_INV_RU] = ru > 1e-4 ? 1.0 / ru : 0.0;
      table[o + DEF_SCUFF_INV_RV] = rv > 1e-4 ? 1.0 / rv : 0.0;
      table[o + DEF_SCUFF_STRENGTH] = (sc && Number.isFinite(sc.strength)) ? sc.strength : (0.55 + rng() * 0.35);
    }

    // 7. Partial tape / sticker occlusion
    const hasCover = (f && f.cover !== undefined)
      ? Boolean(f.cover)
      : (rng() < spec.coverProb);
    if (hasCover) {
      const cv = (f && f.cover && typeof f.cover === 'object') ? f.cover : null;
      table[o + DEF_COVER_FRAC] = (cv && Number.isFinite(cv.frac)) ? cv.frac : (0.08 + rng() * 0.14);
      table[o + DEF_COVER_SIDE] = (cv && Number.isFinite(cv.side)) ? (cv.side >= 0 ? 1 : -1) : (rng() < 0.5 ? 1 : -1);
    }

    // 8. Dark smudge blotch
    const hasSmudge = (f && f.smudge !== undefined)
      ? Boolean(f.smudge)
      : (rng() < spec.smudgeProb);
    if (hasSmudge) {
      const sm = (f && f.smudge && typeof f.smudge === 'object') ? f.smudge : null;
      table[o + DEF_SMUDGE_U] = (sm && Number.isFinite(sm.u)) ? sm.u : ((rng() * 1.2) - 0.6);
      table[o + DEF_SMUDGE_V] = (sm && Number.isFinite(sm.v)) ? sm.v : (0.18 + rng() * 0.64);
      const ru = (sm && Number.isFinite(sm.radU)) ? sm.radU : (0.25 + rng() * 0.25);
      const rv = (sm && Number.isFinite(sm.radV)) ? sm.radV : (0.04 + rng() * 0.07);
      table[o + DEF_SMUDGE_INV_RU] = ru > 1e-4 ? 1.0 / ru : 0.0;
      table[o + DEF_SMUDGE_INV_RV] = rv > 1e-4 ? 1.0 / rv : 0.0;
      table[o + DEF_SMUDGE_STRENGTH] = (sm && Number.isFinite(sm.strength)) ? sm.strength : (0.45 + rng() * 0.35);
    }

    // 9. Missing / truncated quiet zone
    const hasQuietCut = (f && Number.isFinite(f.quietCutFrac))
      ? (f.quietCutFrac > 0)
      : (rng() < spec.quietCutProb);
    if (hasQuietCut) {
      table[o + DEF_QUIET_CUT] = (f && Number.isFinite(f.quietCutFrac))
        ? Math.max(0, Math.min(1, f.quietCutFrac))
        : (0.45 + rng() * 0.55);
    }
  }

  return table;
}
