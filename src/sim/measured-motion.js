/**
 * T3 — Measured hand motion (`src/sim/measured-motion.js`), sim flag `simMeasuredMotion` (default OFF).
 *
 * Replaces the sim's "jitter %" slider (the fixed multi-harmonic wobble in `sampleCameraPose`) with a
 * seeded generator fitted to the angular-rate spectrum of real tapes (`tools/tape-motion.mjs`).
 *
 * Model (`dbc-motion-model` v1), per axis pan / tilt / roll, either
 *   - `lines`: explicit sinusoids `{ fHz, ampDeg, phaseRad }` (the shipped default: the current slider's
 *     wobble at jitter 0.25, the median of the presets), or
 *   - a fitted rate PSD: `psd` (Welch estimate, (deg/s)^2/Hz on a frequency grid) and `ar2`
 *     (Yule-Walker AR(2) fit of the rate series); `chosen` says which one the generator realises
 *     (AR(2) when its band error vs the Welch estimate is within 10%, else the Welch table).
 *
 * The generator is a sum of sinusoids with seeded random phases and sub-bin frequency offsets, so it is
 * a pure function of time: `sampleCameraPose` can be asked for any `t` (sub-frame shutter poses, repeated
 * seeds) and always gets the same answer, which a recursive AR(2) filter could not do.
 * Rate amplitude -> angle amplitude: A_angle = A_rate / (2 pi f).
 *
 * Browser-safe, no dependencies.
 */

import { setMeasuredMotionHook } from './paths.js';
import { isSimOn } from './simflags.js';
import { mulberry32 } from './prng.js';

export const MODEL_FORMAT = 'dbc-motion-model';
export const MODEL_VERSION = 1;
export const BAND_HZ = Object.freeze([0.5, 10]);
export const AXES = Object.freeze(['pan', 'tilt', 'roll']);
const TWO_PI = Math.PI * 2;

// ---- spectral estimation ---------------------------------------------------------------------

function fftInPlace(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-TWO_PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k];
        const ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
}

/**
 * Welch one-sided PSD of `x` sampled at `fs` Hz (Hann window, 50% overlap, per-segment mean removed).
 * @returns {{ f: Float64Array, p: Float64Array, df: number, segments: number }}
 */
export function welchPsd(x, fs, opts = {}) {
  let n = opts.segLen || 256;
  while (n > x.length / 2 && n > 16) n >>= 1;
  const hop = n >> 1;
  const win = new Float64Array(n);
  let u = 0;
  for (let i = 0; i < n; i++) {
    win[i] = 0.5 - 0.5 * Math.cos((TWO_PI * i) / (n - 1));
    u += win[i] * win[i];
  }
  const half = n / 2 + 1;
  const acc = new Float64Array(half);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  let segs = 0;
  for (let s = 0; s + n <= x.length; s += hop) {
    let m = 0;
    for (let i = 0; i < n; i++) m += x[s + i];
    m /= n;
    for (let i = 0; i < n; i++) { re[i] = (x[s + i] - m) * win[i]; im[i] = 0; }
    fftInPlace(re, im);
    for (let k = 0; k < half; k++) acc[k] += re[k] * re[k] + im[k] * im[k];
    segs++;
  }
  const f = new Float64Array(half);
  const p = new Float64Array(half);
  for (let k = 0; k < half; k++) {
    f[k] = (k * fs) / n;
    p[k] = segs ? (acc[k] / segs / (fs * u)) * (k === 0 || k === n / 2 ? 1 : 2) : 0;
  }
  return { f, p, df: fs / n, segments: segs };
}

/** Log-spaced band edges between `lo` and `hi` Hz. */
export function logBandEdges(lo = BAND_HZ[0], hi = BAND_HZ[1], count = 6) {
  const e = [];
  for (let i = 0; i <= count; i++) e.push(lo * Math.pow(hi / lo, i / count));
  return e;
}

/** Integrated power (units^2) of a PSD `{f, p}` in each band; linear interpolation at band edges. */
export function bandPowers(psd, edges) {
  const out = [];
  const at = (hz) => {
    const { f, p } = psd;
    if (hz <= f[0]) return p[0];
    if (hz >= f[f.length - 1]) return p[f.length - 1];
    let lo = 0;
    let hi = f.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (f[mid] <= hz) lo = mid; else hi = mid; }
    return p[lo] + ((p[hi] - p[lo]) * (hz - f[lo])) / (f[hi] - f[lo]);
  };
  for (let b = 0; b + 1 < edges.length; b++) {
    const a = edges[b];
    const c = edges[b + 1];
    const steps = 64;
    let sum = 0;
    for (let i = 0; i < steps; i++) {
      const h0 = a + ((c - a) * i) / steps;
      const h1 = a + ((c - a) * (i + 1)) / steps;
      sum += 0.5 * (at(h0) + at(h1)) * (h1 - h0);
    }
    out.push(sum);
  }
  return out;
}

/** Per-band relative power errors and the worst one: `{ rel: number[], worst, total }`. */
export function compareBandPsd(model, ref, edges = logBandEdges()) {
  const a = bandPowers(model, edges);
  const b = bandPowers(ref, edges);
  const rel = a.map((v, i) => (b[i] > 0 ? Math.abs(v - b[i]) / b[i] : (v > 0 ? Infinity : 0)));
  const ta = a.reduce((s, v) => s + v, 0);
  const tb = b.reduce((s, v) => s + v, 0);
  return { rel, worst: Math.max(...rel), total: tb > 0 ? Math.abs(ta - tb) / tb : 0, modelPower: a, refPower: b };
}

/** Yule-Walker AR(2) of a series: `{ a1, a2, sigma2 }` for x[n] = a1 x[n-1] + a2 x[n-2] + e. */
export function fitAr2(x) {
  const n = x.length;
  let m = 0;
  for (let i = 0; i < n; i++) m += x[i];
  m /= n;
  const r = [0, 0, 0];
  for (let lag = 0; lag < 3; lag++) {
    let s = 0;
    for (let i = lag; i < n; i++) s += (x[i] - m) * (x[i - lag] - m);
    r[lag] = s / n;
  }
  const det = r[0] * r[0] - r[1] * r[1];
  if (!(det > 0)) return { a1: 0, a2: 0, sigma2: r[0] };
  const a1 = (r[1] * (r[0] - r[2])) / det;
  const a2 = (r[0] * r[2] - r[1] * r[1]) / det;
  return { a1, a2, sigma2: Math.max(0, r[0] - a1 * r[1] - a2 * r[2]) };
}

/** One-sided PSD of an AR(2) at frequency `hz`, sampled at `fs`. */
export function ar2PsdAt(ar2, fs, hz) {
  const w = (TWO_PI * hz) / fs;
  const re = 1 - ar2.a1 * Math.cos(w) - ar2.a2 * Math.cos(2 * w);
  const im = ar2.a1 * Math.sin(w) + ar2.a2 * Math.sin(2 * w);
  return (2 * ar2.sigma2) / fs / (re * re + im * im);
}

// ---- fitting a tape --------------------------------------------------------------------------

/** Resamples (tMs, v) to a uniform grid at `fs`. */
function resample(tMs, v, fs) {
  const n = tMs.length;
  if (n < 2) return new Float64Array(0);
  const dur = (tMs[n - 1] - tMs[0]) / 1000;
  const count = Math.floor(dur * fs) + 1;
  const out = new Float64Array(count);
  let j = 0;
  for (let i = 0; i < count; i++) {
    const t = tMs[0] + (i * 1000) / fs;
    while (j < n - 2 && tMs[j + 1] <= t) j++;
    const span = tMs[j + 1] - tMs[j];
    const f = span > 0 ? Math.min(1, Math.max(0, (t - tMs[j]) / span)) : 0;
    out[i] = v[j] + (v[j + 1] - v[j]) * f;
  }
  return out;
}

/**
 * Angular-rate series (deg/s) per axis from tape samples (`readTapeSensors().samples`): recorded rates
 * (`wPanDps`, `wPitchDps`, `wRollDps`) where present, else the derivative of the recorded quaternion's
 * pan/tilt/roll. Returns `{ fs, pan, tilt, roll, source }` on a uniform grid (fs = the tape's median rate).
 */
export function rateSeriesFromSamples(samples, quatToPtr) {
  const n = samples.length;
  if (n < 8) throw new Error('need at least 8 tape frames to fit motion');
  const tMs = new Float64Array(n);
  for (let i = 0; i < n; i++) tMs[i] = samples[i].tMs;
  const dts = [];
  for (let i = 1; i < n; i++) dts.push(tMs[i] - tMs[i - 1]);
  dts.sort((a, b) => a - b);
  const medDt = dts[dts.length >> 1];
  if (!(medDt > 0)) throw new Error('tape timestamps are not increasing');
  const fs = 1000 / medDt;
  const cols = { pan: new Float64Array(n), tilt: new Float64Array(n), roll: new Float64Array(n) };
  const keys = { pan: 'wPanDps', tilt: 'wPitchDps', roll: 'wRollDps' };
  let source = 'recorded rates';
  const haveRates = samples.every((s) => s.sensor && Number.isFinite(s.sensor.wPanDps) && Number.isFinite(s.sensor.wPitchDps));
  if (haveRates) {
    for (let i = 0; i < n; i++) {
      for (const ax of AXES) {
        const v = samples[i].sensor[keys[ax]];
        cols[ax][i] = Number.isFinite(v) ? v : 0;
      }
    }
  } else {
    if (!quatToPtr || !samples.every((s) => s.sensor && s.sensor.q && s.sensor.q.length === 4)) {
      throw new Error('tape has neither angular rates nor quaternions');
    }
    source = 'derivative of recorded quaternion';
    const ang = { pan: new Float64Array(n), tilt: new Float64Array(n), roll: new Float64Array(n) };
    const tmp = { panDeg: 0, tiltDeg: 0, rollDeg: 0 };
    for (let i = 0; i < n; i++) {
      quatToPtr(samples[i].sensor.q, tmp);
      ang.pan[i] = tmp.panDeg; ang.tilt[i] = tmp.tiltDeg; ang.roll[i] = tmp.rollDeg;
    }
    for (const ax of AXES) {
      for (let i = 0; i < n; i++) {
        const a = Math.max(0, i - 1);
        const b = Math.min(n - 1, i + 1);
        cols[ax][i] = ((ang[ax][b] - ang[ax][a]) * 1000) / (tMs[b] - tMs[a]);
      }
    }
  }
  return {
    fs,
    pan: resample(tMs, cols.pan, fs),
    tilt: resample(tMs, cols.tilt, fs),
    roll: resample(tMs, cols.roll, fs),
    source,
  };
}

function rms(x) {
  let m = 0;
  for (let i = 0; i < x.length; i++) m += x[i];
  m /= x.length || 1;
  let s = 0;
  for (let i = 0; i < x.length; i++) s += (x[i] - m) * (x[i] - m);
  return Math.sqrt(s / (x.length || 1));
}

function boxMean(x, win) {
  const out = new Float64Array(x.length);
  const half = win >> 1;
  let sum = 0;
  let lo = 0;
  let hi = -1;
  for (let i = 0; i < x.length; i++) {
    const a = Math.max(0, i - half);
    const b = Math.min(x.length - 1, i + half);
    while (hi < b) sum += x[++hi];
    while (lo < a) sum -= x[lo++];
    out[i] = sum / (hi - lo + 1);
  }
  return out;
}

/**
 * Fits the model to a rate series set and computes the tape's motion statistics.
 *
 * @param {{fs:number, pan:Float64Array, tilt:Float64Array, roll:Float64Array, source?:string}} series
 * @param {{ band?: number[], segLen?: number, sweepWindowSec?: number, distanceIn?: number, name?: string }} [opts]
 */
export function fitMotionModel(series, opts = {}) {
  const fs = series.fs;
  const nyq = fs / 2;
  const band = [opts.band ? opts.band[0] : BAND_HZ[0], Math.min(opts.band ? opts.band[1] : BAND_HZ[1], 0.9 * nyq)];
  const edges = logBandEdges(band[0], band[1], 6);
  const axes = {};
  const stats = { peakRateDps: {}, rmsRateDps: {}, p99RateDps: {}, sweepRmsDps: {} };
  const winSamples = Math.max(3, Math.round((opts.sweepWindowSec || 2) * fs) | 1);
  let totalVar = 0;
  for (const ax of AXES) {
    const x = series[ax];
    const psd = welchPsd(x, fs, { segLen: opts.segLen });
    const ar2 = fitAr2(x);
    const grid = { f: psd.f, p: Float64Array.from(psd.f, (hz) => ar2PsdAt(ar2, fs, hz)) };
    const ar2Cmp = compareBandPsd(grid, psd, edges);
    const chosen = ar2Cmp.worst <= 0.1 ? 'ar2' : 'welch';
    const abs = Array.from(x, (v) => Math.abs(v)).sort((a, b) => a - b);
    stats.peakRateDps[ax] = abs[abs.length - 1] || 0;
    stats.p99RateDps[ax] = abs[Math.floor(abs.length * 0.99)] || 0;
    stats.rmsRateDps[ax] = rms(x);
    stats.sweepRmsDps[ax] = rms(boxMean(x, winSamples));
    totalVar += stats.rmsRateDps[ax] ** 2;
    axes[ax] = {
      chosen,
      ar2: { a1: ar2.a1, a2: ar2.a2, sigma2: ar2.sigma2, bandWorstRelError: ar2Cmp.worst },
      psd: { fHz: Array.from(psd.f), rateDps2PerHz: Array.from(psd.p), dfHz: psd.df, segments: psd.segments },
    };
  }
  const split = {
    panFrac: totalVar > 0 ? stats.rmsRateDps.pan ** 2 / totalVar : 0,
    tiltFrac: totalVar > 0 ? stats.rmsRateDps.tilt ** 2 / totalVar : 0,
    rollFrac: totalVar > 0 ? stats.rmsRateDps.roll ** 2 / totalVar : 0,
  };
  const d = opts.distanceIn || null;
  const sweep = {
    windowSec: opts.sweepWindowSec || 2,
    rmsDps: stats.sweepRmsDps,
    // the scan axis of a ladder label is vertical (tilt), horizontal sweeps (pan) do not smear the bars
    alongScanInPerSec: d ? stats.sweepRmsDps.tilt * (Math.PI / 180) * d : null,
    distanceIn: d,
  };
  return {
    format: MODEL_FORMAT,
    version: MODEL_VERSION,
    source: { name: opts.name || null, fsHz: fs, frames: series.pan.length, durationSec: (series.pan.length - 1) / fs, rates: series.source || null },
    fsHz: fs,
    bandHz: band,
    axes,
    stats: { peakRateDps: stats.peakRateDps, p99RateDps: stats.p99RateDps, rmsRateDps: stats.rmsRateDps, split, sweep },
  };
}

// ---- default (conservative) model: the current slider's wobble ------------------------------------

/** Equivalent jitter value of the shipped default (the median of the presets' jitter). */
export const DEFAULT_JITTER_EQUIVALENT = 0.25;

/**
 * The wobble `sampleCameraPose` adds at `jitter` (yaw/pitch/roll terms) as explicit sinusoid lines,
 * so that the default model with the flag on equals the slider at `DEFAULT_JITTER_EQUIVALENT`.
 */
export function legacyJitterModel(jitter = DEFAULT_JITTER_EQUIVALENT) {
  const line = (omega, amp, phase) => ({ fHz: omega / TWO_PI, ampDeg: amp * jitter, phaseRad: phase });
  const H = Math.PI / 2; // cos(x) = sin(x + pi/2)
  return {
    format: MODEL_FORMAT,
    version: MODEL_VERSION,
    source: { default: true, note: `the jitter slider's wobble at jitter ${jitter}` },
    axes: {
      pan: { lines: [line(3.9, 1.8, 0.4), line(9.1, 0.9, H)] },
      tilt: { lines: [line(3.3, 1.6, 0.9 + H), line(8.4, 0.8, 0)] },
      roll: { lines: [line(2.2, 3.2, 0.7), line(5.7, 1.2, H)] },
    },
  };
}

export function validateMotionModel(m) {
  const errors = [];
  if (!m || typeof m !== 'object') return { ok: false, errors: ['not an object'] };
  if (m.format !== MODEL_FORMAT) errors.push(`format must be ${MODEL_FORMAT}`);
  if (m.version !== MODEL_VERSION) errors.push(`unsupported version ${m.version}`);
  for (const ax of AXES) {
    const a = m.axes && m.axes[ax];
    if (!a) { errors.push(`missing axis ${ax}`); continue; }
    if (a.lines) {
      if (!Array.isArray(a.lines) || a.lines.some((l) => !Number.isFinite(l.fHz) || !Number.isFinite(l.ampDeg))) errors.push(`axis ${ax}: bad lines`);
    } else if (!(a.psd && Array.isArray(a.psd.fHz) && Array.isArray(a.psd.rateDps2PerHz) && a.psd.fHz.length === a.psd.rateDps2PerHz.length)) {
      errors.push(`axis ${ax}: needs lines or psd`);
    }
  }
  return { ok: errors.length === 0, errors };
}

// ---- generator -------------------------------------------------------------------------------

function psdAtGrid(psd, hz) {
  const f = psd.fHz;
  const p = psd.rateDps2PerHz;
  if (hz <= f[0] || hz >= f[f.length - 1]) return 0;
  let lo = 0;
  let hi = f.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (f[mid] <= hz) lo = mid; else hi = mid; }
  return p[lo] + ((p[hi] - p[lo]) * (hz - f[lo])) / (f[hi] - f[lo]);
}

/**
 * Builds the generator. `offsets(t)` returns a SHARED object `{ yawDeg, pitchDeg, rollDeg }` (degrees,
 * pan/tilt/roll offsets) and `rates(t)` the matching angular rates (deg/s).
 *
 * @param {object} model validated `dbc-motion-model`
 * @param {{ seed?: number, gain?: number, gridHz?: number }} [opts]
 */
export function createMeasuredMotion(model, opts = {}) {
  const v = validateMotionModel(model);
  if (!v.ok) throw new Error(`invalid motion model: ${v.errors.join('; ')}`);
  const rng = mulberry32(((opts.seed | 0) * 2654435761 + 12345) >>> 0);
  const gain = opts.gain === undefined ? 1 : opts.gain;
  const dfGrid = opts.gridHz || 0.04;
  const comps = {};
  const band = model.bandHz || BAND_HZ;
  const fs = model.fsHz || 30;
  for (const ax of AXES) {
    const a = model.axes[ax];
    const w = [];
    const amp = [];
    const ph = [];
    const rateAmp = [];
    if (a.lines) {
      for (const l of a.lines) {
        w.push(TWO_PI * l.fHz);
        amp.push(l.ampDeg * gain);
        ph.push(l.phaseRad || 0);
        rateAmp.push(l.ampDeg * gain * TWO_PI * l.fHz);
      }
    } else {
      const fLo = Math.max(band[0], dfGrid);
      const fHi = Math.min(0.45 * fs, a.psd.fHz[a.psd.fHz.length - 1] - 1e-6);
      const useAr2 = a.chosen === 'ar2' && a.ar2;
      // One component per cell [f0 - df/2, f0 + df/2): its power is the integral of the PSD over the cell
      // (midpoint rule, 8 points), so band powers are not subject to sampling error. The frequency is the
      // cell centre plus a small seeded offset (the sum is quasi-periodic, not 1/df periodic).
      for (let f0 = fLo + dfGrid / 2; f0 < fHi; f0 += dfGrid) {
        let s = 0;
        for (let q = 0; q < 8; q++) {
          const fq = f0 - dfGrid / 2 + ((q + 0.5) * dfGrid) / 8;
          s += (useAr2 ? ar2PsdAt(a.ar2, fs, fq) : psdAtGrid(a.psd, fq)) / 8;
        }
        if (!(s > 0)) continue;
        const f = f0 + (rng() - 0.5) * 0.3 * dfGrid;
        const rateA = Math.sqrt(2 * s * dfGrid) * gain;
        w.push(TWO_PI * f);
        rateAmp.push(rateA);
        amp.push(rateA / (TWO_PI * f));
        ph.push(rng() * TWO_PI);
      }
    }
    comps[ax] = { w: Float64Array.from(w), amp: Float64Array.from(amp), ph: Float64Array.from(ph), rateAmp: Float64Array.from(rateAmp) };
  }
  const out = { yawDeg: 0, pitchDeg: 0, rollDeg: 0 };
  const rate = { yawDeg: 0, pitchDeg: 0, rollDeg: 0 };
  const sumSin = (c, t) => { let s = 0; for (let i = 0; i < c.w.length; i++) s += c.amp[i] * Math.sin(c.w[i] * t + c.ph[i]); return s; };
  const sumCos = (c, t) => { let s = 0; for (let i = 0; i < c.w.length; i++) s += c.rateAmp[i] * Math.cos(c.w[i] * t + c.ph[i]); return s; };
  return {
    components: { pan: comps.pan.w.length, tilt: comps.tilt.w.length, roll: comps.roll.w.length },
    offsets(t) {
      out.yawDeg = sumSin(comps.pan, t);
      out.pitchDeg = sumSin(comps.tilt, t);
      out.rollDeg = sumSin(comps.roll, t);
      return out;
    },
    /** Exact power ((deg/s)^2) the generator puts in each band: sum of A_rate^2 / 2 of the components inside it. */
    bandPower(axis, edges) {
      const c = comps[axis];
      const out = new Array(edges.length - 1).fill(0);
      for (let i = 0; i < c.w.length; i++) {
        const f = c.w[i] / TWO_PI;
        for (let b = 0; b + 1 < edges.length; b++) {
          if (f >= edges[b] && f < edges[b + 1]) { out[b] += (c.rateAmp[i] * c.rateAmp[i]) / 2; break; }
        }
      }
      return out;
    },
    rates(t) {
      rate.yawDeg = sumCos(comps.pan, t);
      rate.pitchDeg = sumCos(comps.tilt, t);
      rate.rollDeg = sumCos(comps.roll, t);
      return rate;
    },
  };
}

let activeGenerator = null;

/**
 * Installs the generator as the sim's motion source (replaces the jitter slider's angular wobble).
 * Does nothing and returns `false` unless the `simMeasuredMotion` flag is on (or `opts.enabled === true`).
 * `model` defaults to the conservative built-in (`legacyJitterModel()`).
 */
export function enableMeasuredMotion(model = legacyJitterModel(), opts = {}) {
  const enabled = opts.enabled === undefined ? isSimOn('simMeasuredMotion') : Boolean(opts.enabled);
  if (!enabled) return false;
  activeGenerator = createMeasuredMotion(model, opts);
  setMeasuredMotionHook((t) => activeGenerator.offsets(t));
  return true;
}

export function disableMeasuredMotion() {
  activeGenerator = null;
  setMeasuredMotionHook(null);
}

export function getActiveMotionGenerator() {
  return activeGenerator;
}
