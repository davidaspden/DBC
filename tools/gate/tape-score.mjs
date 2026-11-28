#!/usr/bin/env node
/**
 * T2 — Golden-tape replay scoring (`tools/gate/tape-score.mjs`), gate scenario S15.
 *
 * Replays every `tapes/*.dbct` (or the tapes you name) with each flag set through the real worker
 * pipeline (`tools/replay.mjs`) and reports, per tape and flag set:
 *   decode set, time-to-first per payload (tape clock), false-positive detections, worker ms
 *   (p50/p95/max), and the tape's recorded fps / exposure / ISO ("unknown" when the tape lacks them).
 *
 * Expected payloads ("truth") come from the sidecar `tapes/<name>.json` (`labels[].payload`; an empty
 * list means a negative tape), else a sim-exported tape's header `meta.expectedPayloads`, else unknown.
 *
 * Rules (Plan 1 §1.2 rule 8), checked for every flag set other than `off`:
 *   R1 superset:  everything the flags-off run decoded is still decoded;
 *   R2 no new wrong payloads: decoded-but-not-expected payloads are a subset of the flags-off ones
 *      (only checkable when truth is known; otherwise reported as `unchecked`);
 *   R3 baseline (with `--baseline prev.json`): per tape and set, the decode set contains the baseline's
 *      and the wrong set is inside the baseline's;
 *   R4 golden (with `--golden`): replays with the tape's own recorded worker mask and requires every
 *      per-frame golden payload (`expectedPayloads` in the frame meta) to decode again.
 * Any violation exits 1.
 *
 * Usage:
 *   node tools/gate/tape-score.mjs [tapes...] [--dir tapes] [--sets off,W-fc,W-all]
 *        [--baseline prev.json] [--json out.json] [--golden] [--require-tapes]
 */

import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { parseTapeBytes, replayTape, describeTapeCamera } from '../replay.mjs';
import { resolveFlagSet } from './scenarios.mjs';
import { FLAG_VERTICAL_MODE } from '../../src/worker/flagbits.js';

export const DEFAULT_SETS = Object.freeze(['off', 'W-fc', 'W-all']);

/** `tapes/<name>.json` next to `<name>.dbct`, or `null`. */
export function loadSidecar(dbctPath) {
  const p = dbctPath.replace(/\.dbct$/i, '.json');
  if (p === dbctPath || !existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch (e) {
    throw new Error(`sidecar ${p} is not valid JSON: ${e.message}`);
  }
}

/** Where the expected payloads come from: `{ known, payloads: string[], source }`. */
export function expectedPayloadsFor(parsed, sidecar) {
  if (sidecar && Array.isArray(sidecar.labels)) {
    return { known: true, payloads: sidecar.labels.map((l) => l.payload).filter(Boolean), source: 'sidecar' };
  }
  const hm = (parsed.header && parsed.header.meta) || {};
  if (Array.isArray(hm.expectedPayloads) && hm.expectedPayloads.length) {
    return { known: true, payloads: [...hm.expectedPayloads], source: 'header' };
  }
  return { known: false, payloads: [], source: 'unknown' };
}

/** Union of the per-frame golden payloads (what the recording run decoded), or []. */
export function goldenPayloadsOf(parsed) {
  const set = new Set();
  for (const f of parsed.frames) {
    if (Array.isArray(f.meta.expectedPayloads)) for (const p of f.meta.expectedPayloads) set.add(p);
  }
  return [...set].sort();
}

function labelOrientation(parsed, sidecar) {
  const fromSidecar = sidecar && Array.isArray(sidecar.labels) && sidecar.labels[0] && sidecar.labels[0].orientation;
  const fromHeader = parsed.header && parsed.header.meta && parsed.header.meta.labelOrientation;
  return fromSidecar || fromHeader || 'ladder';
}

function sub(a, b) {
  const bs = new Set(b);
  return a.filter((x) => !bs.has(x));
}

/**
 * Scores one parsed tape over flag sets. `sets` are names for `resolveFlagSet`.
 * @returns {object} per-tape result with `sets[]` and `violations[]`
 */
export function scoreParsedTape(parsed, opts = {}) {
  const sidecar = opts.sidecar || null;
  const replay = opts.replay || replayTape; // injectable for rule tests
  const names = opts.sets || DEFAULT_SETS;
  const truth = expectedPayloadsFor(parsed, sidecar);
  const truthSet = new Set(truth.payloads);
  const orient = labelOrientation(parsed, sidecar);
  const camera = describeTapeCamera(parsed);
  const order = names.includes('off') ? names : ['off', ...names];
  const results = [];
  for (const name of order) {
    const fs = resolveFlagSet(name);
    const vertical = orient === 'ladder' && (fs.workerMask & FLAG_VERTICAL_MODE) !== 0;
    const rep = replay(parsed, fs.workerMask, { vertical });
    const wrong = truth.known ? rep.decodedPayloads.filter((p) => !truthSet.has(p)) : [];
    const fpDetections = truth.known ? wrong.reduce((a, p) => a + rep.payloadFrameCounts[p], 0) : null;
    const ttf = {};
    for (const p of rep.decodedPayloads) ttf[p] = rep.firstSeen[p].tSec;
    results.push({
      id: fs.id,
      workerMask: fs.workerMask,
      vertical,
      decoded: rep.decodedPayloads,
      expectedDecoded: truth.known ? rep.decodedPayloads.filter((p) => truthSet.has(p)).length : null,
      wrong,
      falsePositiveDetections: fpDetections,
      timeToFirstSec: ttf,
      workerMs: { p50: rep.p50Ms, p95: rep.p95Ms, max: rep.maxMs },
      frames: rep.frameCount,
    });
  }
  const off = results.find((r) => r.id === 'off');
  const violations = [];
  for (const r of results) {
    if (r === off) continue;
    const lost = sub(off.decoded, r.decoded);
    if (lost.length) violations.push({ rule: 'R1-superset', set: r.id, detail: `lost payloads vs flags off: ${lost.join(', ')}` });
    if (truth.known) {
      const fresh = sub(r.wrong, off.wrong);
      if (fresh.length) violations.push({ rule: 'R2-new-wrong', set: r.id, detail: `new wrong payloads: ${fresh.join(', ')}` });
    }
  }
  if (opts.golden) {
    const hm = parsed.header.meta || {};
    if (Number.isFinite(hm.workerMask)) {
      const vertical = orient === 'ladder' && (hm.workerMask & FLAG_VERTICAL_MODE) !== 0;
      const rep = replay(parsed, hm.workerMask | 0, { vertical });
      if (rep.missingPayloads.length) {
        violations.push({
          rule: 'R4-golden',
          set: 'recorded',
          detail: `${rep.missingPayloads.length} golden payload(s) no longer decode (first: frame ${rep.missingPayloads[0].frameId} ${rep.missingPayloads[0].payload})`,
        });
      }
    }
  }
  return {
    frames: parsed.frames.length,
    truth: { known: truth.known, source: truth.source, payloads: truth.payloads },
    r2: truth.known ? 'checked' : 'unchecked (no expected payloads: add a sidecar)',
    camera: {
      fps: camera.fps ?? 'unknown',
      derivedFps: camera.derivedFps ?? 'unknown',
      exposureMs: camera.exposureMs ?? 'unknown',
      exposureTimeRaw: camera.exposureTimeRaw ?? 'unknown',
      iso: camera.iso ?? 'unknown',
      width: camera.width,
      height: camera.height,
    },
    sidecar: sidecar ? { device: sidecar.device || null, lighting: sidecar.lighting || null, distance: sidecar.distance || null } : null,
    sets: results,
    violations,
  };
}

/** R3: compares a fresh result set with a baseline written earlier by `--json`. */
export function compareToBaseline(current, baseline) {
  const violations = [];
  for (const t of current.tapes) {
    const b = baseline && baseline.tapes ? baseline.tapes.find((x) => x.name === t.name) : null;
    if (!b) continue;
    for (const s of t.sets) {
      const bs = b.sets.find((x) => x.id === s.id);
      if (!bs) continue;
      const lost = sub(bs.decoded, s.decoded);
      if (lost.length) violations.push({ tape: t.name, rule: 'R3-baseline', set: s.id, detail: `no longer decodes: ${lost.join(', ')}` });
      const fresh = sub(s.wrong, bs.wrong);
      if (fresh.length) violations.push({ tape: t.name, rule: 'R3-baseline', set: s.id, detail: `new wrong payloads vs baseline: ${fresh.join(', ')}` });
    }
  }
  return violations;
}

export function listTapeFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.dbct')).sort().map((f) => join(dir, f));
}

/** Scores tapes by path; returns `{ tapes, violations, pass }`. */
export function scoreTapes(paths, opts = {}) {
  const tapes = [];
  const violations = [];
  for (const path of paths) {
    const parsed = parseTapeBytes(readFileSync(path));
    const res = scoreParsedTape(parsed, { ...opts, sidecar: loadSidecar(path) });
    const name = basename(path).replace(/\.dbct$/i, '');
    tapes.push({ name, path, ...res });
    for (const v of res.violations) violations.push({ tape: name, ...v });
  }
  const out = { schema: 'dbc-tape-score', version: 1, sets: opts.sets || DEFAULT_SETS, tapes, violations: [] };
  if (opts.baseline) violations.push(...compareToBaseline(out, opts.baseline));
  out.violations = violations;
  out.pass = violations.length === 0;
  return out;
}

export function formatReport(res) {
  const lines = [];
  for (const t of res.tapes) {
    const c = t.camera;
    lines.push(`${t.name}  frames=${t.frames}  fps=${c.fps}${c.fps === 'unknown' ? ` (derived ${c.derivedFps})` : ''}  exposure=${c.exposureMs}ms  iso=${c.iso}  truth=${t.truth.known ? `${t.truth.payloads.length} (${t.truth.source})` : 'unknown'}`);
    for (const s of t.sets) {
      const ttf = Object.entries(s.timeToFirstSec).map(([p, v]) => `${p}@${v}s`).join(' ') || '-';
      lines.push(`  ${s.id.padEnd(8)} decoded ${s.decoded.length}${t.truth.known ? ` (${s.expectedDecoded}/${t.truth.payloads.length} expected, ${s.wrong.length} wrong, FP ${s.falsePositiveDetections})` : ''}  worker p50/p95/max ${s.workerMs.p50}/${s.workerMs.p95}/${s.workerMs.max} ms  first: ${ttf}`);
    }
  }
  if (!res.tapes.length) lines.push('no tapes to score');
  for (const v of res.violations) lines.push(`VIOLATION ${v.tape || ''} ${v.rule} [${v.set}] ${v.detail}`);
  lines.push(res.pass ? 'TAPE SCORE: PASS' : `TAPE SCORE: FAIL (${res.violations.length} violation(s))`);
  return lines.join('\n');
}

if (typeof process !== 'undefined' && process.argv[1] && process.argv[1].endsWith('tape-score.mjs')) {
  const argv = process.argv.slice(2);
  const valueOf = (n) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : null);
  const skip = new Set(['--dir', '--sets', '--baseline', '--json'].flatMap((n) => (argv.includes(n) ? [argv.indexOf(n) + 1] : [])));
  const files = argv.filter((a, i) => !a.startsWith('--') && !skip.has(i));
  const dir = valueOf('--dir') || 'tapes';
  const paths = files.length ? files : listTapeFiles(dir);
  const sets = valueOf('--sets') ? valueOf('--sets').split(',') : [...DEFAULT_SETS];
  const baseline = valueOf('--baseline') ? JSON.parse(readFileSync(valueOf('--baseline'), 'utf8')) : null;
  if (!paths.length && argv.includes('--require-tapes')) {
    console.error(`no .dbct tapes found in ${dir}`);
    process.exit(1);
  }
  const res = scoreTapes(paths, { sets, baseline, golden: argv.includes('--golden') });
  console.log(formatReport(res));
  if (valueOf('--json')) writeFileSync(valueOf('--json'), JSON.stringify(res, null, 2));
  process.exit(res.pass ? 0 : 1);
}
