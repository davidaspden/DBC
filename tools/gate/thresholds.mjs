/**
 * G6 — Per-profile thresholds and the gate subset behind `node tools/verify.mjs --gate`
 * (`tools/gate/thresholds.mjs`, rules in `baseline/thresholds.json`, notes in `docs/gate.md`).
 *
 * Three kinds of check, as in the plan (section 10.3):
 *  1. Flags OFF vs the recorded reference (`references`, captured with `--capture`): decode set and
 *     coverage identical, time-to-first within a tolerance, FP not above the reference, delivered fps for
 *     camera profiles. Deterministic fields compare across machines. Timing (p50/p95/heap) is compared
 *     only against a baseline captured on the same machine (`timing[<machine>]`); otherwise it is skipped
 *     and said so.
 *  2. Flags ON vs flags OFF of the same scenario in the same run: coverage not worse, time-to-all within
 *     +5%, FP 0 (gated rows) or not above off, p50 within +20% (W-fc) / +30% (W-all and others).
 *     A flags-on row that has its own reference (the `single:verticalMode` canary) is also held to it.
 *  3. Absolute floors, all marked `uncalibrated` until G7 fits the profiles: the camera-profile frame
 *     rates (about 10 fps in low light, about 30 locked) and FP 0 on every profile row. The coverage
 *     floors from the plan need a full snake pass per profile, which the 6 s profile runs cannot give;
 *     they are listed as `report-only`.
 *
 * Pure functions plus a small CLI:
 *   node tools/gate/thresholds.mjs --check   gate-results/x.json
 *   node tools/gate/thresholds.mjs --capture gate-results/x.json [--timing] [--out baseline/thresholds.json]
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { selectScenarios } from './scenarios.mjs';
import { getMachineSlug } from './report.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const THRESHOLDS_PATH = join(HERE, '..', '..', 'baseline', 'thresholds.json');

/** The gate canary: verticalMode on a ladder scene, held to its own reference (see `docs/gate.md`). */
export const CANARY_ONLY = 'S01-a53-8-720';
export const CANARY_FLAGS = 'single:verticalMode';

export function loadThresholds(path = THRESHOLDS_PATH) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/**
 * The scenarios `verify --gate` runs.
 *  - quick: the existing quick set (S01 x4 truncated, fc-tele-30-3p5 off + W-fc full length), the canary
 *    (verticalMode, 10 s) and the five profile rows (2 s, 1 seed).
 *  - full: the whole default matrix, the canary, and the profile group at its full 6 s length (both flag sets).
 */
export function selectGateScenarios(mode = 'quick') {
  const quick = mode !== 'full';
  const base = selectScenarios({ quick });
  const canary = selectScenarios({ only: CANARY_ONLY, flags: CANARY_FLAGS, quick, seeds: 1 });
  const prof = selectScenarios({ profiles: true, quick });
  return [...base, ...canary, ...prof];
}

const r3 = (x) => Math.round(x * 1000) / 1000;

function refKey(r) {
  return `${r.id}@${r.quickMode ? 'quick' : 'full'}`;
}

function ttfSum(r) {
  const t = r.seeds && r.seeds[0] ? r.seeds[0].timeToFirstByLabel : null;
  if (!t) return null;
  let s = 0;
  for (const k of Object.keys(t)) s += t[k];
  return r3(s);
}

function decodedSet(r) {
  return r.seeds && r.seeds[0] && Array.isArray(r.seeds[0].decodedPayloads) ? r.seeds[0].decodedPayloads : [];
}

/** Which kind of reference row a result is. */
function refKind(r) {
  if (r.group === 'prof') return 'profile';
  if (r.flagSet === 'off') return 'flagsOff';
  return 'canary';
}

/**
 * Builds the `references` (and optionally `timing`) sections from a gate run.
 * @param {object[]} results scenario summaries (`runScenarios` output)
 */
export function captureReferences(results, { machine = getMachineSlug(), withTiming = false } = {}) {
  const references = {};
  const timing = {};
  for (const r of results) {
    const kind = refKind(r);
    // flags-on rows other than the canary have no reference: they are judged relative to flags-off
    if (kind === 'canary' && r.flagSet !== CANARY_FLAGS) continue;
    if (r.group === 'prof' && r.flagSet !== 'off') continue;
    references[refKey(r)] = {
      kind,
      flagSet: r.flagSet,
      profile: r.profile,
      coverageMedian: r.coverageMedian,
      totalCells: r.totalCells,
      decodedPayloads: decodedSet(r),
      falsePositivesTotal: r.falsePositivesTotal,
      timeToFirstSumSec: ttfSum(r),
      // canary rows keep every label's time: the sum alone hides a few labels arriving 1-4 frames late
      ...(kind === 'canary' && r.seeds && r.seeds[0] ? { timeToFirstByLabel: { ...r.seeds[0].timeToFirstByLabel } } : {}),
      timeToAllMedianSec: r.timeToAllMedianSec,
      fpsDelivered: r.fpsDelivered,
      ...(r.camera ? { camera: { cameraFps: r.camera.cameraFps, deliveredFps: r.camera.deliveredFps, droppedFrames: r.camera.droppedFrames } } : {}),
      deterministicHash: r.deterministicHash,
    };
    if (withTiming) {
      (timing[machine] ||= {})[refKey(r)] = {
        p50: r.workerMs.node.p50,
        p95: r.workerMs.node.p95,
        heapBytesPerFrame: r.heapBytesPerFrame,
      };
    }
  }
  return { references, timing };
}

function pctOver(value, ref) {
  return ref > 0 ? ((value - ref) / ref) * 100 : (value > 0 ? Infinity : 0);
}

function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

/**
 * Evaluates a gate run against the thresholds. Returns `{ ok, rows, failures, warnings }` where each row is
 * `{ run, check, status: 'PASS'|'FAIL'|'WARN'|'SKIP', detail }`.
 *
 * @param {object[]} results
 * @param {object} th  parsed baseline/thresholds.json
 * @param {{ machine?: string, mode?: string }} [opts]
 */
export function evaluateGate(results, th, opts = {}) {
  const machine = opts.machine || getMachineSlug();
  const rows = [];
  const add = (run, check, status, detail) => rows.push({ run, check, status, detail });
  const R = th.rules;
  const byId = new Map(results.map((r) => [r.id, r]));
  const timingBase = (th.timing && th.timing[machine]) || null;

  for (const r of results) {
    const key = refKey(r);
    const ref = th.references ? th.references[key] : null;

    // ---- 1. reference rows (flags off, profile rows, canary) ----
    if (ref) {
      const tol = ref.kind === 'canary' ? R.canary.timeToFirstTolerancePct : R.flagsOff.timeToFirstTolerancePct;
      const refSet = new Set(ref.decodedPayloads);
      const gotSet = new Set(decodedSet(r));
      const missing = [...refSet].filter((p) => !gotSet.has(p));
      const covOk = ref.kind === 'canary'
        ? r.coverageMedian >= ref.coverageMedian
        : r.coverageMedian === ref.coverageMedian;
      add(r.id, 'coverage vs reference', covOk && missing.length === 0 ? 'PASS' : 'FAIL',
        `${r.coverageMedian}/${r.totalCells} (reference ${ref.coverageMedian})${missing.length ? `, lost ${missing.join(',')}` : ''}`);

      const fpOk = r.falsePositivesTotal <= ref.falsePositivesTotal;
      add(r.id, 'false positives', fpOk ? 'PASS' : 'FAIL', `${r.falsePositivesTotal} (reference ${ref.falsePositivesTotal})`);

      const s = ttfSum(r);
      if (s !== null && ref.timeToFirstSumSec !== null) {
        const over = pctOver(s, ref.timeToFirstSumSec);
        const under = ref.kind === 'canary' ? false : over < -tol;
        const bad = over > tol || under;
        add(r.id, 'time-to-first (sum)', bad ? 'FAIL' : 'PASS',
          `${s} s vs ${ref.timeToFirstSumSec} s (${over >= 0 ? '+' : ''}${over.toFixed(1)}%, tolerance ${ref.kind === 'canary' ? '+' : '+/-'}${tol}%)`);
      }
      if (ref.kind === 'canary' && ref.timeToFirstByLabel && r.seeds && r.seeds[0]) {
        const slack = R.canary.perLabelSlackSec;
        const got = r.seeds[0].timeToFirstByLabel || {};
        const late = [];
        for (const label of Object.keys(ref.timeToFirstByLabel)) {
          if (got[label] !== undefined && got[label] > ref.timeToFirstByLabel[label] + slack) {
            late.push(`${label} ${got[label]} s vs ${ref.timeToFirstByLabel[label]} s`);
          }
        }
        add(r.id, 'per-label time-to-first', late.length === 0 ? 'PASS' : 'FAIL',
          late.length === 0 ? `no label later than reference + ${slack} s` : `${late.length} label(s) later than reference + ${slack} s: ${late.slice(0, 3).join('; ')}`);
      }
      if (r.timeToAllMedianSec !== null && ref.timeToAllMedianSec !== null && ref.kind !== 'canary') {
        const over = pctOver(r.timeToAllMedianSec, ref.timeToAllMedianSec);
        add(r.id, 'time-to-all', Math.abs(over) <= tol ? 'PASS' : 'FAIL', `${r.timeToAllMedianSec} s vs ${ref.timeToAllMedianSec} s (${over.toFixed(1)}%)`);
      }
      if (ref.camera && r.camera) {
        const d = Math.abs(r.camera.deliveredFps - ref.camera.deliveredFps);
        const tolFps = Math.max(0.3, ref.camera.deliveredFps * (R.profiles.deliveredFpsTolerancePct / 100));
        add(r.id, 'delivered fps vs reference', d <= tolFps ? 'PASS' : 'FAIL', `${r.camera.deliveredFps} (reference ${ref.camera.deliveredFps}, tolerance ${tolFps.toFixed(2)})`);
      }
      if (r.deterministicHash !== ref.deterministicHash) {
        add(r.id, 'decode trace', 'WARN', `deterministic hash changed (${ref.deterministicHash} -> ${r.deterministicHash}); metrics above decide. Re-capture with --capture-thresholds if the change is intended`);
      }
      if (timingBase && timingBase[key]) {
        const tb = timingBase[key];
        const p50 = pctOver(r.workerMs.node.p50, tb.p50);
        const p95 = pctOver(r.workerMs.node.p95, tb.p95);
        const okT = p50 <= R.flagsOff.p50TolerancePct && p95 <= R.flagsOff.p95TolerancePct;
        add(r.id, 'timing vs same-machine baseline', okT ? 'PASS' : 'FAIL',
          `p50 ${r.workerMs.node.p50} ms (${p50 >= 0 ? '+' : ''}${p50.toFixed(0)}%, limit +${R.flagsOff.p50TolerancePct}%), p95 ${r.workerMs.node.p95} ms (${p95 >= 0 ? '+' : ''}${p95.toFixed(0)}%, limit +${R.flagsOff.p95TolerancePct}%)`);
        if (tb.heapBytesPerFrame != null && r.heapBytesPerFrame != null && !r.quickMode) {
          add(r.id, 'heap not worse', r.heapBytesPerFrame <= Math.max(tb.heapBytesPerFrame * 1.1, tb.heapBytesPerFrame + 64) ? 'PASS' : 'FAIL',
            `${r.heapBytesPerFrame} B/frame vs ${tb.heapBytesPerFrame}`);
        }
      }
    } else if (r.flagSet === 'off' && r.group !== 'prof') {
      add(r.id, 'reference', 'SKIP', `no reference for ${key} in baseline/thresholds.json (capture with --capture-thresholds)`);
    }

    // ---- 2. flags on vs flags off, same run ----
    if (r.flagSet !== 'off') {
      const offId = r.id.replace(/\[[^\]]+\]$/, '[off]');
      const off = byId.get(offId) || byId.get(r.id.replace(/\[[^\]]+\]$/, ''));
      if (off && off !== r) {
        const rel = R.flagsOn;
        add(r.id, `coverage vs ${off.flagSet}`, r.coverageMedian >= off.coverageMedian ? 'PASS' : 'FAIL', `${r.coverageMedian} vs ${off.coverageMedian}`);
        const fpLimit = r.fpGated ? rel.fpMax : off.falsePositivesTotal;
        add(r.id, 'false positives vs off', r.falsePositivesTotal <= fpLimit ? 'PASS' : 'FAIL', `${r.falsePositivesTotal} (limit ${fpLimit})`);
        if (r.timeToAllMedianSec !== null && off.timeToAllMedianSec !== null) {
          const over = pctOver(r.timeToAllMedianSec, off.timeToAllMedianSec);
          add(r.id, 'time-to-all vs off', over <= rel.timeToAllTolerancePct ? 'PASS' : 'FAIL', `${r.timeToAllMedianSec} s vs ${off.timeToAllMedianSec} s (${over.toFixed(1)}%)`);
        }
        const lim = rel.p50TolerancePct[r.flagSet] ?? rel.p50TolerancePct.default;
        const p50over = pctOver(r.workerMs.node.p50, off.workerMs.node.p50);
        const slack = rel.p50SlackMs;
        const okP = r.workerMs.node.p50 <= off.workerMs.node.p50 * (1 + lim / 100) + slack;
        add(r.id, 'p50 vs off (same run)', okP ? 'PASS' : 'FAIL', `${r.workerMs.node.p50} ms vs ${off.workerMs.node.p50} ms (${p50over >= 0 ? '+' : ''}${p50over.toFixed(0)}%, limit +${lim}% +${slack} ms)`);
      }
    }

    // ---- 3. profile rows: FP 0 ----
    if (r.group === 'prof' && R.profiles.fpMax !== undefined) {
      add(r.id, 'profile false positives', r.falsePositivesTotal <= R.profiles.fpMax ? 'PASS' : 'FAIL', `${r.falsePositivesTotal} (limit ${R.profiles.fpMax})`);
    }
  }

  // ---- absolute floors ----
  for (const f of th.floors || []) {
    const r = byId.get(f.run);
    if (!r) {
      add(f.run, `floor ${f.id}`, 'SKIP', 'run not in this gate selection');
      continue;
    }
    if (f.appliesTo === 'fullLength' && r.quickMode) {
      add(f.run, `floor ${f.id}`, 'SKIP', 'full-length floor, not applied to quick runs');
      continue;
    }
    let v;
    let detail;
    if (f.ratioTo) {
      const o = byId.get(f.ratioTo);
      if (!o) { add(f.run, `floor ${f.id}`, 'SKIP', `${f.ratioTo} not in this gate selection`); continue; }
      const a = getPath(r, f.metric);
      const b = getPath(o, f.metric);
      v = b > 0 ? a / b : Infinity;
      detail = `${f.metric} ${a} / ${b} = ${Number.isFinite(v) ? v.toFixed(2) : 'inf'}`;
    } else {
      v = getPath(r, f.metric);
      detail = `${f.metric} = ${v}`;
    }
    const okMin = f.min === undefined || v >= f.min;
    const okMax = f.max === undefined || v <= f.max;
    const tag = f.status === 'report-only' ? 'report-only' : (f.status || 'uncalibrated');
    const range = `${f.min !== undefined ? `>= ${f.min}` : ''}${f.min !== undefined && f.max !== undefined ? ' and ' : ''}${f.max !== undefined ? `<= ${f.max}` : ''}`;
    if (f.status === 'report-only') {
      add(f.run, `floor ${f.id} [report-only]`, okMin && okMax ? 'PASS' : 'WARN', `${detail} (want ${range})`);
    } else {
      add(f.run, `floor ${f.id} [${tag}]`, okMin && okMax ? 'PASS' : 'FAIL', `${detail} (want ${range})`);
    }
  }

  const failures = rows.filter((x) => x.status === 'FAIL');
  const warnings = rows.filter((x) => x.status === 'WARN');
  return { ok: failures.length === 0, rows, failures, warnings };
}

/** One line per row, FAIL/WARN first-class, PASS/SKIP compact. */
export function formatGateTable(evalResult, { verbose = false } = {}) {
  const lines = [];
  const runW = Math.min(36, Math.max(...evalResult.rows.map((r) => r.run.length), 8));
  for (const r of evalResult.rows) {
    if (!verbose && r.status === 'PASS') continue;
    lines.push(`  [${r.status}] ${r.run.padEnd(runW)}  ${r.check.padEnd(34)} ${r.detail}`);
  }
  const counts = { PASS: 0, FAIL: 0, WARN: 0, SKIP: 0 };
  for (const r of evalResult.rows) counts[r.status]++;
  lines.push(`  gate checks: ${counts.PASS} pass, ${counts.FAIL} fail, ${counts.WARN} warn, ${counts.SKIP} skipped`);
  return lines.join('\n');
}

/** Writes captured references (and timing) into baseline/thresholds.json, keeping rules and floors. */
export function writeCapturedThresholds(path, results, { withTiming = false, commit = 'unknown', machine = getMachineSlug() } = {}) {
  const th = JSON.parse(readFileSync(path, 'utf8'));
  const cap = captureReferences(results, { machine, withTiming });
  th.references = { ...(th.references || {}), ...cap.references };
  if (withTiming) th.timing = { ...(th.timing || {}), ...cap.timing };
  th.capturedAtCommit = commit;
  writeFileSync(path, JSON.stringify(th, null, 2) + '\n', 'utf8');
  return th;
}

async function cli() {
  const argv = process.argv.slice(2);
  const get = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : null; };
  const check = get('--check');
  const capture = get('--capture');
  const path = get('--out') || THRESHOLDS_PATH;
  const file = check || capture;
  if (!file) {
    console.error('usage: node tools/gate/thresholds.mjs --check <report.json> | --capture <report.json> [--timing] [--out file]');
    process.exit(2);
  }
  const report = JSON.parse(readFileSync(file, 'utf8'));
  if (capture) {
    writeCapturedThresholds(path, report.scenarios, { withTiming: argv.includes('--timing'), commit: report.commit || 'unknown', machine: report.machine || getMachineSlug() });
    console.log(`captured ${report.scenarios.length} runs into ${path}`);
    return;
  }
  const ev = evaluateGate(report.scenarios, loadThresholds(path), { machine: report.machine });
  console.log(formatGateTable(ev, { verbose: argv.includes('--verbose') }));
  process.exit(ev.ok ? 0 : 1);
}

if (process.argv[1] && process.argv[1].endsWith('thresholds.mjs')) {
  cli().catch((e) => { console.error(e); process.exit(1); });
}
