#!/usr/bin/env node
/**
 * R7 — prints the array-mapper-in-the-loop scoreboard (`src/sim/array-loop.js`).
 *
 *   node tools/array-loop.mjs                 # S01/S02 (4 presets), S12 (start orientations), S07 (slide)
 *   node tools/array-loop.mjs --only s12      # one section: s01 | s12 | standoff | singles | s07
 *   node tools/array-loop.mjs --native        # preset-native frame size and fps (slow)
 *   node tools/array-loop.mjs --legacy        # also compare flags-off mapped cells with d917944 (needs git history)
 *   node tools/array-loop.mjs --json out.json # also write the raw results
 *
 * Default frame size is 960x540 so the whole board runs in about a minute; the flag-independent
 * render+decode is done once per scenario and replayed for each flag set.
 */

import { writeFileSync } from 'node:fs';
import { loadLegacyArrayModules } from './gate/array-legacy.mjs';
import {
  recordStandbackRun,
  recordSlideRun,
  synthSensors,
  runArrayLoop,
  runSlideLoop,
  flagsFromNames,
  tableKey,
  START_ORIENTATIONS,
  A_ALL_STANDBACK,
} from '../src/sim/array-loop.js';
import { ORIGINAL_PRESET_IDS } from '../src/sim/presets.js';

const argv = process.argv.slice(2);
const native = argv.includes('--native');
const legacy = argv.includes('--legacy');
const only = argv.includes('--only') ? argv[argv.indexOf('--only') + 1] : null;
const jsonOut = argv.includes('--json') ? argv[argv.indexOf('--json') + 1] : null;
const size = native ? {} : { width: 960, height: 540 };
const want = (s) => !only || only === s;
const out = {};

function row(tag, r) {
  const d = r.driftIn;
  return `${tag.padEnd(44)} ${String(r.placed).padStart(4)} ${String(r.correct).padStart(4)} ${String(r.wrong).padStart(4)}  ${String(r.attribution ?? '-').padStart(5)}  ${String(r.correctCells).padStart(2)}/${String(r.readCells).padEnd(2)} ${String(r.wrongCells).padStart(2)} ${String(r.conflictCells).padStart(2)}  ${String(d.mean).padStart(5)} ${String(d.max).padStart(6)} ${String(r.timeToZeroSec ?? '-').padStart(5)}`;
}
const HEAD = `${'case'.padEnd(44)} plcd   ok wrng   attr  cells  wC cf   drift(in) mean   max  t0(s)`;

const BASE = { presetId: 'tele-30', trueDistanceIn: 30, hfovDeg: 26, speedInPerSec: 30, ...size };

if (want('s01')) {
  console.log('\nS01/S02 — the 4 original presets as stand-back runs (30 in, 26 deg rig), flags off vs A-all');
  console.log(HEAD);
  out.s01 = {};
  const legacyMods = legacy ? await loadLegacyArrayModules() : null;
  for (const id of ORIGINAL_PRESET_IDS) {
    const run = recordStandbackRun({ presetId: id, ...size });
    const s = synthSensors(run, {});
    const off = runArrayLoop(run, s, {});
    const aall = runArrayLoop(run, s, { flags: flagsFromNames(A_ALL_STANDBACK.filter((n) => n !== 'orientGravityZero')) });
    console.log(row(`${id} off`, off));
    console.log(row(`${id} A-all (no gravityZero)`, aall));
    out.s01[id] = { off, aall };
    if (legacyMods) {
      const old = runArrayLoop(run, s, { modules: { createPanArrayMapper: legacyMods.createPanArrayMapper } });
      const same = tableKey(old) === tableKey(off) && old.placed === off.placed && old.correct === off.correct;
      console.log(`  d917944 mapper, flags off: mapped cells ${same ? 'IDENTICAL' : 'DIFFER'} (${old.correct}/${old.placed} correct)`);
      out.s01[id].legacyIdentical = same;
    }
  }
}

if (want('s12')) {
  console.log('\nS12 — start orientation (sensor stream rotated), tele-30 stand-back, 2 deg/min yaw drift');
  console.log(HEAD);
  out.s12 = {};
  const rec = {};
  for (const o of START_ORIENTATIONS) {
    rec[o.id] = {
      centre: recordStandbackRun({ ...BASE, stance: 'centre', rollOffsetDeg: o.rollOffsetDeg }),
      front: recordStandbackRun({ ...BASE, stance: 'in-front', rollOffsetDeg: o.rollOffsetDeg }),
    };
  }
  for (const o of START_ORIENTATIONS) {
    const cases = [
      ['off (centre stance)', [], 'centre'],
      ['A-all minus gravityZero (centre)', A_ALL_STANDBACK.filter((n) => n !== 'orientGravityZero'), 'centre'],
      ['axisRemapAuto only (centre)', ['axisRemapAuto'], 'centre'],
      ['orientGravityZero only (in-front)', ['orientGravityZero'], 'front'],
      ['A-all (in-front)', A_ALL_STANDBACK, 'front'],
    ];
    out.s12[o.id] = {};
    for (const [tag, names, st] of cases) {
      const run = rec[o.id][st];
      const gz = names.includes('orientGravityZero');
      const s = synthSensors(run, { alphaDeg: o.alphaDeg, gravityFrame: gz });
      const r = runArrayLoop(run, s, { flags: flagsFromNames(names) });
      console.log(row(`${o.id} ${tag}`, r));
      out.s12[o.id][tag] = r;
    }
  }
}

if (want('standoff')) {
  console.log('\nMis-set standoff (user dials 22.5 / 37.5 in, true 30 in), upright, centre stance');
  console.log(HEAD);
  const run = recordStandbackRun({ ...BASE, stance: 'centre' });
  const s = synthSensors(run, {});
  out.standoff = {};
  for (const ud of [22.5, 37.5]) {
    for (const names of [[], ['panKalman'], ['nudgeDamp'], ['panKalman', 'nudgeDamp']]) {
      const r = runArrayLoop(run, s, { flags: flagsFromNames(names), userDistanceIn: ud });
      console.log(row(`D=${ud} ${names.join('+') || 'off'} (ends D=${r.standDistanceIn})`, r));
      out.standoff[`${ud}:${names.join('+') || 'off'}`] = r;
    }
  }
}

if (want('singles')) {
  console.log('\nSingle-flag sweep, upright and tilted (25 deg roll), centre stance');
  console.log(HEAD);
  out.singles = {};
  for (const [tag, roll] of [['upright', 0], ['tilted', 25]]) {
    const run = recordStandbackRun({ ...BASE, stance: 'centre', rollOffsetDeg: roll });
    const s = synthSensors(run, {});
    for (const n of ['off', ...A_ALL_STANDBACK.filter((x) => x !== 'orientGravityZero')]) {
      const r = runArrayLoop(run, s, { flags: flagsFromNames(n === 'off' ? [] : [n]) });
      console.log(row(`${tag} ${n}`, r));
      out.singles[`${tag}:${n}`] = r;
    }
  }
}

if (want('s07')) {
  console.log('\nS07 — slide pass (fc-8-3p5, 8 in, snake-h) through createSlideWallMapper');
  const run = recordSlideRun({ presetId: 'fc-8-3p5', ...size });
  out.s07 = {};
  for (const [tag, o] of [['flow ok', {}], ['flow dropped 5-9 s', { dropFlowFromSec: 5, dropFlowToSec: 9 }]]) {
    const r = runSlideLoop(run, o);
    console.log(`${tag.padEnd(22)} placed ${r.placed} ok ${r.correct} wrong ${r.wrong} cells ${r.correctCells}/16 silentWrong ${r.silentWrongCells} missing ${r.missingCells} drift mean ${r.driftIn.mean} max ${r.driftIn.max} tracking ${JSON.stringify(r.trackingCounts)}`);
    out.s07[tag] = r;
  }
}

if (jsonOut) writeFileSync(jsonOut, JSON.stringify(out));
