#!/usr/bin/env node
/**
 * R3 — `simgate --scenario <file>` equivalent: reproduces a Labs "Download scenario JSON" file headless.
 *
 *   node tools/run-scenario.mjs --scenario dbc-scenario-fc-8-3p5.json [--seeds 1,2] [--json out.json]
 *
 * (Kept out of tools/simgate.mjs on purpose so it cannot conflict with the pending F6 change to that file;
 * the one-line hook `if (opts.scenario) ...` can be added to simgate after F6 lands.)
 *
 * Exit code 1 if a flag set's coverage differs from what the page reported (when the file carries `reported`).
 */
import { writeFileSync } from 'node:fs';
import { loadScenarioFile } from './gate/scenario-file.mjs';
import { runScenarioSeed } from './gate/score.mjs';

const argv = process.argv.slice(2);
const arg = (n) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : null);
const file = arg('--scenario');
if (!file) {
  console.error('usage: node tools/run-scenario.mjs --scenario file.json [--seeds 1,2] [--json out.json]');
  process.exit(2);
}
const { obj, spec, scenarios } = loadScenarioFile(file);
const seeds = arg('--seeds') ? arg('--seeds').split(',').map(Number) : spec.seeds;
if (spec.unsupportedSimFlags.length) {
  console.log(`note: sim flags with no headless effect yet (recorded only): ${spec.unsupportedSimFlags.join(', ')}`);
}
let mismatch = false;
const out = [];
for (const { flagSet, scenario } of scenarios) {
  const res = seeds.map((s) => runScenarioSeed(scenario, s, { deviceFactor: 1 }));
  const first = res[0];
  const fp = res.reduce((a, r) => a + r.falsePositives, 0);
  let line = `${flagSet.id.padEnd(8)} decoded ${first.decodedCount}/${first.totalCells} FP ${fp} all ${first.timeToAllSec ?? '--'}s (seed ${seeds[0]}, ${scenario.width}x${scenario.height}, mask 0x${(flagSet.workerMask >>> 0).toString(16)})`;
  const rep = obj.reported && obj.reported[flagSet.id];
  if (rep && seeds[0] === spec.seeds[0]) {
    const same = rep.decoded === first.decodedCount && rep.falsePositives === fp;
    line += same ? '  == page result' : `  != page result (page: ${rep.decoded}/${rep.total} FP ${rep.falsePositives})`;
    if (!same) mismatch = true;
  }
  console.log(line);
  out.push({ id: flagSet.id, seeds: res });
}
if (arg('--json')) writeFileSync(arg('--json'), JSON.stringify(out));
process.exit(mismatch ? 1 : 0);
