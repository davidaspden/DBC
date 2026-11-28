#!/usr/bin/env node
/**
 * R6 — checks the GL half of the GL to CPU parity (`tools/gl-parity-check.mjs`).
 *
 *   node tools/gl-parity-check.mjs <dir>            # dir holds the files `tools/gl-parity.html` downloaded
 *   node tools/gl-parity-check.mjs <dir> --install  # also copy them into tests/fixtures-sim/gl-parity/
 *
 * Re-renders every case on the CPU, compares with the GL PGMs and applies the R6 thresholds
 * (labels <= 6/255, elsewhere <= 10/255, same decoded payloads). Exit 1 on any failure.
 */
import { readFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PARITY_CASES, buildParityCase, judgeCase, decodePgm } from '../src/sim/gl-parity.js';
import { renderFrame } from '../src/sim/cpu-render.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const FIXTURE_DIR = join(HERE, '..', 'tests', 'fixtures-sim', 'gl-parity');

/** @returns {{ ok: boolean, problems: string[], rows: object[], manifest: object|null }} */
export function checkFixtureDir(dir) {
  const problems = [];
  const rows = [];
  const mpath = join(dir, 'manifest.json');
  if (!existsSync(mpath)) return { ok: false, problems: [`no manifest.json in ${dir}`], rows, manifest: null };
  const manifest = JSON.parse(readFileSync(mpath, 'utf8'));
  if (manifest.format !== 'dbc-gl-parity') problems.push('manifest format is not dbc-gl-parity');
  if (manifest.softwareRenderer) problems.push(`GL frames came from a SOFTWARE renderer (${manifest.gpu}); a real GPU run is needed for gl-verified`);
  const ids = (manifest.cases || []).map((c) => c.id).sort().join(',');
  if (ids !== PARITY_CASES.map((c) => c.id).sort().join(',')) problems.push(`case list differs from this repo's PARITY_CASES (manifest: ${ids})`);
  for (const c of PARITY_CASES) {
    const file = join(dir, `${c.id}.pgm.gz`);
    if (!existsSync(file)) { problems.push(`missing ${c.id}.pgm.gz`); continue; }
    const pgm = decodePgm(new Uint8Array(gunzipSync(readFileSync(file))));
    if (pgm.width !== c.width || pgm.height !== c.height) { problems.push(`${c.id}: size ${pgm.width}x${pgm.height}, expected ${c.width}x${c.height}`); continue; }
    const built = buildParityCase(c);
    const cpu = renderFrame(built.scene, built.pose, built.opts);
    const v = judgeCase(built, cpu, pgm.luma);
    rows.push(v);
    if (!v.pass) {
      problems.push(`${c.id}: labels ${v.meanInside.toFixed(2)}/6, elsewhere ${v.meanOutside.toFixed(2)}/10, decodes ${v.decodeParity ? 'match' : `differ (CPU ${v.cpuDecoded.length}, GL ${v.otherDecoded.length})`}${v.flippedWouldPass ? ', image is upside down' : ''}`);
    }
  }
  return { ok: problems.length === 0, problems, rows, manifest };
}

if (typeof process !== 'undefined' && process.argv[1] && process.argv[1].endsWith('gl-parity-check.mjs')) {
  const argv = process.argv.slice(2);
  const dir = argv.find((a) => !a.startsWith('--'));
  if (!dir) {
    console.error('usage: node tools/gl-parity-check.mjs <dir with manifest.json and *.pgm.gz> [--install]');
    process.exit(2);
  }
  const res = checkFixtureDir(dir);
  for (const r of res.rows) {
    console.log(`${r.id.padEnd(22)} labels ${r.meanInside.toFixed(2)}  elsewhere ${r.meanOutside.toFixed(2)}  max ${r.maxAbs}  decodes ${r.decodeParity ? 'match' : 'DIFFER'}  ${r.pass ? 'PASS' : 'FAIL'}`);
  }
  for (const p of res.problems) console.log(`PROBLEM: ${p}`);
  console.log(res.ok ? 'GL PARITY: PASS' : 'GL PARITY: FAIL');
  if (res.ok && argv.includes('--install')) {
    mkdirSync(FIXTURE_DIR, { recursive: true });
    copyFileSync(join(dir, 'manifest.json'), join(FIXTURE_DIR, 'manifest.json'));
    for (const c of PARITY_CASES) copyFileSync(join(dir, `${c.id}.pgm.gz`), join(FIXTURE_DIR, `${c.id}.pgm.gz`));
    console.log(`installed into ${FIXTURE_DIR}`);
  }
  process.exit(res.ok ? 0 : 1);
}
