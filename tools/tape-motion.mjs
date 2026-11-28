#!/usr/bin/env node
/**
 * T3 — Motion statistics from a tape (`tools/tape-motion.mjs`).
 *
 * Extracts the angular-rate power spectrum, peak rates, the pitch-vs-yaw split and the sweep speed
 * along the scan axis from a `.dbct` tape, fits the per-axis motion model (AR(2) and the Welch table;
 * see `src/sim/measured-motion.js`) and writes it as a `dbc-motion-model` JSON the sim loads when the
 * `simMeasuredMotion` flag is on.
 *
 *   node tools/tape-motion.mjs tapes/<name>.dbct [--out model.json] [--distance 10] [--seed 1]
 *
 * Prints the statistics and, as a self-check, the generator's band power against the tape's in
 * 6 log-spaced bands over 0.5-10 Hz (acceptance: each within 20%).
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { readTapeSensors, quatToPanTiltRollDeg } from '../src/sim/tape-pose.js';
import {
  AXES,
  rateSeriesFromSamples,
  fitMotionModel,
  createMeasuredMotion,
  welchPsd,
  bandPowers,
  compareBandPsd,
  logBandEdges,
} from '../src/sim/measured-motion.js';

/** Fits a tape file/bytes. Returns `{ model, series }`. */
export function modelFromTapeBytes(bytes, opts = {}) {
  const tape = readTapeSensors(bytes);
  const series = rateSeriesFromSamples(tape.samples, quatToPanTiltRollDeg);
  const model = fitMotionModel(series, opts);
  return { model, series };
}

/**
 * Compares the generator's band power per axis with the source series' (Welch) in 6 log bands over the
 * model's band. Two ways, both returned:
 *  - `analytic`: the exact power of the generator's sinusoids per band (its true PSD, no estimator noise);
 *  - `empirical`: Welch of a long generated record (default 600 s, 1024-point segments, fine enough to
 *    resolve the components) against the same source reference.
 * Returns `{ perAxis: {pan: {analytic: {rel[], worst}, empirical: {...}}}, worst, edges }` where `worst`
 * is the larger of the two worst errors.
 */
export function checkModelAgainstSeries(model, series, opts = {}) {
  const gen = createMeasuredMotion(model, { seed: opts.seed ?? 1 });
  const edges = logBandEdges(model.bandHz[0], model.bandHz[1], 6);
  const n = Math.round((opts.empiricalSec || 600) * series.fs);
  const gx = { pan: new Float64Array(n), tilt: new Float64Array(n), roll: new Float64Array(n) };
  for (let i = 0; i < n; i++) {
    const r = gen.rates(i / series.fs);
    gx.pan[i] = r.yawDeg;
    gx.tilt[i] = r.pitchDeg;
    gx.roll[i] = r.rollDeg;
  }
  const perAxis = {};
  let worst = 0;
  for (const ax of AXES) {
    const ref = bandPowers(welchPsd(series[ax], series.fs), edges);
    const rel = (v) => v.map((x, i) => (ref[i] > 0 ? Math.abs(x - ref[i]) / ref[i] : (x > 0 ? Infinity : 0)));
    const a = rel(gen.bandPower(ax, edges));
    const e = compareBandPsd(welchPsd(gx[ax], series.fs, { segLen: 1024 }), welchPsd(series[ax], series.fs), edges);
    perAxis[ax] = {
      analytic: { rel: a, worst: Math.max(...a) },
      empirical: { rel: e.rel, worst: e.worst },
    };
    worst = Math.max(worst, perAxis[ax].analytic.worst, perAxis[ax].empirical.worst);
  }
  return { perAxis, worst, edges };
}

export function formatStats(model) {
  const s = model.stats;
  const f = (v) => v.toFixed(2);
  const lines = [];
  lines.push(`tape ${model.source.name || ''}: ${model.source.frames} frames @ ${f(model.fsHz)} Hz (${f(model.source.durationSec)} s), rates from ${model.source.rates}`);
  lines.push(`band ${model.bandHz[0]}-${f(model.bandHz[1])} Hz`);
  for (const ax of AXES) {
    const a = model.axes[ax];
    lines.push(`  ${ax.padEnd(4)} rms ${f(s.rmsRateDps[ax])} dps  p99 ${f(s.p99RateDps[ax])}  peak ${f(s.peakRateDps[ax])}  sweep rms ${f(s.sweep.rmsDps[ax])}  model ${a.chosen} (AR(2) band error ${(a.ar2.bandWorstRelError * 100).toFixed(0)}%)`);
  }
  lines.push(`  split pan/tilt/roll: ${(s.split.panFrac * 100).toFixed(0)}% / ${(s.split.tiltFrac * 100).toFixed(0)}% / ${(s.split.rollFrac * 100).toFixed(0)}%`);
  if (s.sweep.alongScanInPerSec !== null) lines.push(`  sweep along the scan axis at ${s.sweep.distanceIn} in: ${f(s.sweep.alongScanInPerSec)} in/s`);
  return lines.join('\n');
}

if (typeof process !== 'undefined' && process.argv[1] && process.argv[1].endsWith('tape-motion.mjs')) {
  const argv = process.argv.slice(2);
  const val = (n) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : null);
  const file = argv.find((a, i) => !a.startsWith('--') && !['--out', '--distance', '--seed'].includes(argv[i - 1]));
  if (!file) {
    console.error('usage: node tools/tape-motion.mjs <file.dbct> [--out model.json] [--distance in] [--seed n]');
    process.exit(2);
  }
  const { model, series } = modelFromTapeBytes(readFileSync(file), { name: basename(file), distanceIn: val('--distance') ? Number(val('--distance')) : undefined });
  console.log(formatStats(model));
  const chk = checkModelAgainstSeries(model, series, { seed: Number(val('--seed')) || 1 });
  for (const ax of AXES) {
    const pc = (v) => v.map((r) => `${(r * 100).toFixed(0)}%`).join(' ');
    console.log(`  generator vs tape band power ${ax}: exact ${pc(chk.perAxis[ax].analytic.rel)} | measured ${pc(chk.perAxis[ax].empirical.rel)}`);
  }
  console.log(`  worst band error ${(chk.worst * 100).toFixed(0)}% -> ${chk.worst <= 0.2 ? 'within 20%' : 'OUTSIDE 20% (needs a longer tape?)'}`);
  if (val('--out')) {
    writeFileSync(val('--out'), JSON.stringify(model));
    console.log(`wrote ${val('--out')}`);
  }
  process.exit(0);
}
