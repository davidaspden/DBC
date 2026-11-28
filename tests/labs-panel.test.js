/**
 * R3 — Labs panel in the sim (`src/sim/labs-panel.js`, `labs-scenario.js`, `ab-run.js`,
 * `tools/run-scenario.mjs`).   node tests/labs-panel.test.js
 */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { describe as describeFlags, setFlag, toWorkerMask } from '../src/flags.js';
import { describeSimFlags, setSimFlag } from '../src/sim/simflags.js';
import {
  buildScenarioJson,
  validateScenarioJson,
  specFromScenarioJson,
  loopDurationSec,
  SCENARIO_FORMAT,
} from '../src/sim/labs-scenario.js';
import { runSpecSeed, runAb } from '../src/sim/ab-run.js';
import { buildLabsModel, mountLabsPanel } from '../src/sim/labs-panel.js';
import { createScenarioFromPreset } from '../tools/gate/scenarios.mjs';
import { runScenarioSeed } from '../tools/gate/score.mjs';
import { scenarioFromSpec } from '../tools/gate/scenario-file.mjs';
import { getPreset } from '../src/sim/presets.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0;
async function test(name, fn) {
  await fn();
  console.log(`  PASS  ${name}`);
  passed++;
}

// ---- minimal fake DOM --------------------------------------------------------------------
class FakeEl {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.listeners = {};
    this.style = {};
    this._text = '';
    this.value = '';
    this.checked = false;
    this.disabled = false;
  }
  appendChild(c) { this.children.push(c); return c; }
  addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); }
  fire(t) { for (const fn of this.listeners[t] || []) fn({ target: this }); }
  set textContent(v) { this._text = v; if (v === '') this.children = []; }
  get textContent() { return this._text; }
  walk(fn) { fn(this); for (const c of this.children) c.walk(fn); }
}
const fakeDoc = { createElement: (t) => new FakeEl(t) };
const find = (root, pred) => { const out = []; root.walk((n) => { if (pred(n)) out.push(n); }); return out; };

function makeDeps(over = {}) {
  const store = { downloads: [], changes: 0 };
  const state = { pathId: 'snake-h', distanceIn: 10, hfovDeg: 70.7, speedInPerSec: 18, fpsCap: 13, shutterMs: 2, jitter: 0.15, width: 640, height: 360, fcMode: false, labelHeightIn: 6, shadowStrength: 0.35, noiseStrength: 0.015 };
  return {
    store,
    deps: {
      document: fakeDoc,
      describeFlags,
      setFlag,
      toWorkerMask,
      describeSimFlags,
      setSimFlag,
      getState: () => state,
      getPresetId: () => 'a53-8-720',
      onChange: () => { store.changes++; },
      download: (n, t) => store.downloads.push({ n, t }),
      yieldFn: null,
      ...over,
    },
    state,
  };
}

await test('R3 scenario JSON: default duration equals the simgate preset loop duration and the file validates', () => {
  for (const id of ['a53-8-720', 'tele-30', 'full-wall', 'fc-8-3p5']) {
    const p = getPreset(id);
    const json = buildScenarioJson({
      presetId: id,
      state: { pathId: p.pathId, speedInPerSec: p.speedInPerSec, manualPose: p.manualPose },
      workerFlags: [],
    });
    assert.equal(json.format, SCENARIO_FORMAT);
    assert.deepEqual(validateScenarioJson(json), { ok: true, errors: [] });
    const gate = createScenarioFromPreset(id, {});
    assert.equal(json.run.durationSec, gate.durationSec, id);
    assert.ok(loopDurationSec(p.pathId, p.speedInPerSec) > 0);
  }
  assert.equal(validateScenarioJson({ format: 'x' }).ok, false);
  assert.equal(validateScenarioJson(null).ok, false);
});

await test('R3 browser-safe A/B runner matches the SimGate runner exactly (same decodes, FP, time to all)', async () => {
  const json = buildScenarioJson({
    presetId: 'a53-8-720',
    state: { ...getPreset('a53-8-720'), pathId: 'snake-h', width: 640, height: 360, speedInPerSec: 40, jitter: 0.1, shutterMs: 2 },
    workerFlags: ['vertFallback', 'extraLines', 'cribMatch'],
    seeds: [2],
    durationSec: 4,
    flagSets: [{ id: 'A-off', worker: [] }, { id: 'B-on', worker: ['vertFallback', 'extraLines', 'cribMatch'] }],
  });
  const spec = specFromScenarioJson(json);
  const rows = await runAb(spec, { yieldFn: null });
  assert.equal(rows.length, 2);
  for (const fs of spec.flagSets) {
    const gate = runScenarioSeed(scenarioFromSpec(spec, fs), 2, { deviceFactor: 1 });
    const row = rows.find((r) => r.id === fs.id);
    assert.deepEqual(row.seeds[0].decodedPayloads, gate.decodedPayloads, fs.id);
    assert.equal(row.seeds[0].falsePositives, gate.falsePositives);
    assert.equal(row.seeds[0].timeToAllSec, gate.timeToAllSec);
    assert.equal(row.decoded, gate.decodedCount);
  }
});

await test('R3 panel: mounting changes no flag; toggling a worker flag calls setFlag and updates the mask', () => {
  const { deps, store } = makeDeps();
  const calls = [];
  const spy = { ...deps, setFlag: (...a) => { calls.push(a); return setFlag(...a); } };
  const root = new FakeEl('details');
  const panel = mountLabsPanel(root, spy);
  assert.equal(calls.length, 0, 'mounting must not change any flag');
  const boxes = find(root, (n) => n.tag === 'input' && n.type === 'checkbox');
  const nWorker = describeFlags().length;
  const nSim = describeSimFlags().length;
  assert.equal(boxes.length, nWorker + nSim);
  const idx = describeFlags().findIndex((f) => f.name === 'decodeAnchor');
  assert.ok(idx >= 0);
  const before = toWorkerMask();
  boxes[idx].checked = true;
  boxes[idx].fire('change');
  assert.deepEqual(calls[0], ['decodeAnchor', true, true]);
  assert.notEqual(toWorkerMask(), before);
  assert.equal(store.changes, 1);
  assert.match(panel.ui.mask.textContent, /mask 0x[0-9a-f]+/);
  panel.resetAll();
  assert.equal(toWorkerMask(), 0, 'reset puts every worker flag back OFF');
  assert.equal(describeSimFlags().every((f) => !f.enabled), true);
});

await test('R3 panel model: sim flags are labelled by what they do, camera profile row is disabled (K9)', () => {
  const { deps, state } = makeDeps();
  const m = buildLabsModel({
    workerFlags: describeFlags(),
    simFlags: describeSimFlags(),
    state,
    presetId: deps.getPresetId(),
    mask: toWorkerMask(),
  });
  assert.equal(m.simFlags.find((f) => f.name === 'simFcLabel').effect, 'headless');
  assert.equal(m.simFlags.find((f) => f.name === 'arWall').effect, 'none-yet');
  assert.equal(m.cameraProfile.available, false);
  const root = new FakeEl('details');
  mountLabsPanel(root, deps);
  const sel = find(root, (n) => n.tag === 'select' && n.disabled);
  assert.equal(sel.length, 1, 'camera profile select is present but disabled');
});

await test('R3 panel: A/B run shows both rows; the downloaded scenario reproduces the page numbers headless', async () => {
  setFlag('vertFallback', true, false);
  setFlag('extraLines', true, false);
  const { deps, state } = makeDeps();
  Object.assign(state, { speedInPerSec: 40, jitter: 0.1 });
  const root = new FakeEl('details');
  const panel = mountLabsPanel(root, deps);
  panel.ui.seed.value = '2';
  // shorten the run for the test by wrapping the runner (the scenario file keeps the same shortened duration)
  const shortRunner = (spec, o) => { spec.durationSec = 4; return runAb(spec, o); };
  const panel2 = mountLabsPanel(new FakeEl('details'), { ...deps, runAb: shortRunner });
  panel2.ui.seed.value = '2';
  await panel2.runAb();
  const rows = panel2.getLastRows();
  assert.deepEqual(rows.map((r) => r.id), ['A-off', 'B-on']);
  assert.equal(rows[0].workerMask, 0);
  assert.equal(rows[1].workerMask, toWorkerMask());
  const shown = find(panel2.ui.results, (n) => n.className === 'labs-row');
  assert.equal(shown.length, 2);
  assert.match(shown[0].textContent, /decoded \d+\/16/);
  // download, then force the same short duration in the file and give it the page's reported numbers
  const json = panel2.downloadScenario();
  assert.equal(deps.download === undefined, false);
  assert.equal(json.run.flagSets.length, 2);
  json.run.durationSec = 4;
  json.reported = {};
  for (const r of rows) json.reported[r.id] = { decoded: r.decoded, total: r.total, falsePositives: r.falsePositives, timeToAllSec: r.timeToAllSec };
  const dir = mkdtempSync(join(tmpdir(), 'dbc-scn-'));
  const file = join(dir, 'scenario.json');
  writeFileSync(file, JSON.stringify(json));
  const res = spawnSync('node', ['tools/run-scenario.mjs', '--scenario', file], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.equal((res.stdout.match(/== page result/g) || []).length, 2, res.stdout);
  // a file whose reported numbers differ exits non-zero
  json.reported['B-on'].decoded += 1;
  writeFileSync(file, JSON.stringify(json));
  const bad = spawnSync('node', ['tools/run-scenario.mjs', '--scenario', file], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /!= page result/);
  panel.resetAll();
});

await test('R3 scenario file: invalid files and missing --scenario fail loudly', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dbc-scn-'));
  const file = join(dir, 'bad.json');
  writeFileSync(file, JSON.stringify({ format: 'dbc-scenario', version: 1, presetId: 'nope' }));
  const res = spawnSync('node', ['tools/run-scenario.mjs', '--scenario', file], { cwd: ROOT, encoding: 'utf8' });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /Invalid scenario/);
  const none = spawnSync('node', ['tools/run-scenario.mjs'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(none.status, 2);
});

await test('R3 sim.html hosts the Labs container and mounts it; flags-off page behaviour is unchanged', () => {
  const html = readFileSync(join(ROOT, 'sim.html'), 'utf8');
  assert.ok(html.includes('id="labs-panel"'));
  assert.ok(html.includes("from './src/sim/labs-panel.js'"));
  assert.ok(html.includes('mountLabsPanel('));
  // the page still posts the worker mask exactly as before
  assert.ok(html.includes('flags: toWorkerMask()'));
});

console.log(`\nAll ${passed} R3 Labs panel tests passed.`);
