/**
 * R3 — Labs panel for `sim.html` (`src/sim/labs-panel.js`).
 *
 * A collapsible panel (same pattern as the `array.html` B6 Labs panel) that lists:
 *  - the worker/product flags (`src/flags.js`), toggled live: the worker mask is read on every frame message;
 *  - the sim/AR flags (`src/sim/simflags.js`), marked when they have no live or headless effect yet;
 *  - the run parameters (preset, path, distance, label/lips settings) read from the page state;
 *  - the camera profile row (K9 is not built yet, shown disabled);
 *  - an A/B button: runs "flags off" then "flags as selected" over the same path and seed on the CPU
 *    renderer + real worker (`ab-run.js`) and shows both rows;
 *  - "Download scenario JSON": a `dbc-scenario` file that `node tools/run-scenario.mjs --scenario file`
 *    reproduces headless.
 *
 * DOM access goes through the injected `deps.document`, so the panel is unit-tested with a fake DOM.
 */

import { buildScenarioJson, specFromScenarioJson, HEADLESS_SIM_FLAGS } from './labs-scenario.js';
import { runAb } from './ab-run.js';

/** Sim flags whose live effect exists in sim.html (T1: simTapePose adds a tape file row; the rest are headless or later items). */
export const LIVE_SIM_FLAGS = Object.freeze(['simTapePose']);

/** Pure model of what the panel shows (testable without a DOM). */
export function buildLabsModel({ workerFlags, simFlags, state, presetId, mask }) {
  return {
    maskText: `0x${(mask >>> 0).toString(16)}`,
    workerFlags: workerFlags.map((f) => ({ name: f.name, item: f.item, enabled: f.enabled, desc: f.desc, exclusive: f.exclusive })),
    simFlags: simFlags.map((f) => ({
      name: f.name,
      item: f.item,
      enabled: f.enabled,
      desc: f.desc,
      effect: LIVE_SIM_FLAGS.includes(f.name) ? 'live' : HEADLESS_SIM_FLAGS.includes(f.name) ? 'headless' : 'none-yet',
    })),
    params: [
      ['preset', presetId],
      ['path', state.pathId],
      ['distance', `${state.distanceIn} in`],
      ['hfov', `${state.hfovDeg} deg`],
      ['speed', `${state.speedInPerSec} in/s`],
      ['fps', String(state.fpsCap)],
      ['shutter', `${state.shutterMs} ms`],
      ['jitter', String(state.jitter)],
      ['frame', `${state.width}x${state.height}`],
      ['label', `${state.fcMode ? 'FC 2x' : '2x'}${state.labelHeightIn} in`],
    ],
    cameraProfile: { available: false, note: 'Camera profile (K9) is not built yet' },
  };
}

function el(doc, tag, props = {}, kids = []) {
  const e = doc.createElement(tag);
  for (const k of Object.keys(props)) {
    if (k === 'style') e.style.cssText = props[k];
    else if (k === 'text') e.textContent = props[k];
    else e[k] = props[k];
  }
  for (const c of kids) e.appendChild(c);
  return e;
}

/**
 * @param {*} container
 * @param {{
 *   document: *, describeFlags: Function, setFlag: Function, toWorkerMask: Function,
 *   describeSimFlags: Function, setSimFlag: Function,
 *   getState: () => object, getPresetId: () => string,
 *   onChange?: () => void, download?: (name: string, text: string) => void,
 *   runAb?: Function, yieldFn?: (() => Promise<void>) | null
 * }} deps
 */
export function mountLabsPanel(container, deps) {
  const doc = deps.document;
  const abRunner = deps.runAb || runAb;
  const ui = {};
  let lastRows = null;
  let busy = false;

  function selectedWorkerFlags() {
    return deps.describeFlags().filter((f) => f.enabled && f.bit !== null).map((f) => f.name);
  }
  function selectedSimFlags() {
    return deps.describeSimFlags().filter((f) => f.enabled).map((f) => f.name);
  }

  function renderFlags() {
    const model = buildLabsModel({
      workerFlags: deps.describeFlags(),
      simFlags: deps.describeSimFlags(),
      state: deps.getState(),
      presetId: deps.getPresetId(),
      mask: deps.toWorkerMask(),
    });
    ui.mask.textContent = `(mask ${model.maskText})`;
    ui.workerList.textContent = '';
    for (const f of model.workerFlags) {
      const cb = el(doc, 'input', { type: 'checkbox', checked: f.enabled });
      cb.addEventListener('change', () => {
        deps.setFlag(f.name, cb.checked, true);
        ui.mask.textContent = `(mask 0x${(deps.toWorkerMask() >>> 0).toString(16)})`;
        if (deps.onChange) deps.onChange();
      });
      ui.workerList.appendChild(el(doc, 'label', { title: `${f.item}: ${f.desc}`, className: 'labs-flag' }, [cb, el(doc, 'span', { text: `${f.name} (${f.item})` })]));
    }
    ui.simList.textContent = '';
    for (const f of model.simFlags) {
      const cb = el(doc, 'input', { type: 'checkbox', checked: f.enabled });
      cb.addEventListener('change', () => {
        deps.setSimFlag(f.name, cb.checked, true);
        if (deps.onChange) deps.onChange();
      });
      const tag = f.effect === 'live' ? '' : f.effect === 'headless' ? ' [headless]' : ' [no effect yet]';
      ui.simList.appendChild(el(doc, 'label', { title: `${f.item}: ${f.desc}`, className: 'labs-flag' }, [cb, el(doc, 'span', { text: `${f.name}${tag}` })]));
    }
    ui.params.textContent = model.params.map(([k, v]) => `${k}: ${v}`).join(' · ');
    return model;
  }

  function renderResults(rows) {
    ui.results.textContent = '';
    for (const r of rows) {
      const t = r.timeToAllSec === null ? '--' : `${r.timeToAllSec}s`;
      ui.results.appendChild(el(doc, 'div', {
        className: 'labs-row',
        text: `${r.id.padEnd(8)} decoded ${r.decoded}/${r.total} · FP ${r.falsePositives} · all ${t} · worker p50 ${r.seeds[0].workerMs.p50} ms · mask 0x${(r.workerMask >>> 0).toString(16)}`,
      }));
    }
  }

  function currentScenario(reported) {
    const worker = selectedWorkerFlags();
    return buildScenarioJson({
      presetId: deps.getPresetId(),
      state: deps.getState(),
      workerFlags: worker,
      simFlags: selectedSimFlags(),
      seeds: [Number(ui.seed.value) || 1],
      flagSets: [{ id: 'A-off', worker: [] }, { id: 'B-on', worker }],
      reported,
    });
  }

  async function runAbNow() {
    if (busy) return;
    busy = true;
    ui.run.disabled = true;
    ui.status.textContent = 'running A/B on the CPU renderer…';
    try {
      const spec = specFromScenarioJson(currentScenario());
      const scale = Number(ui.scale.value) || 1;
      lastRows = await abRunner(spec, {
        scale,
        yieldFn: deps.yieldFn === undefined ? () => new Promise((r) => setTimeout(r, 0)) : deps.yieldFn,
        yieldEvery: 4,
        onProgress: (f) => { ui.status.textContent = `running… ${Math.round(f * 100)}%`; },
      });
      renderResults(lastRows);
      ui.status.textContent = scale < 1 ? `done (scaled ${scale}x: the downloaded scenario records full size, so numbers can differ)` : 'done';
    } catch (e) {
      ui.status.textContent = `A/B failed: ${e && e.message ? e.message : e}`;
    } finally {
      busy = false;
      ui.run.disabled = false;
    }
  }

  function downloadScenario() {
    let reported = null;
    if (lastRows && Number(ui.scale.value) === 1) {
      reported = {};
      for (const r of lastRows) reported[r.id] = { decoded: r.decoded, total: r.total, falsePositives: r.falsePositives, timeToAllSec: r.timeToAllSec };
    }
    const json = currentScenario(reported);
    const name = `dbc-scenario-${json.presetId}.json`;
    deps.download(name, JSON.stringify(json, null, 2));
    ui.status.textContent = `downloaded ${name}${reported ? ' (with the A/B result the page showed)' : ''}`;
    return json;
  }

  function resetAll() {
    for (const f of deps.describeFlags()) deps.setFlag(f.name, false, false);
    for (const f of deps.describeSimFlags()) deps.setSimFlag(f.name, false, false);
    try { if (typeof localStorage !== 'undefined') { localStorage.removeItem('dbc.flags'); localStorage.removeItem('dbc.simflags'); } } catch {}
    renderFlags();
    if (deps.onChange) deps.onChange();
  }

  // ---- build DOM ------------------------------------------------------------------------------
  ui.mask = el(doc, 'span', { className: 'mono', text: '(mask 0x0)' });
  const summary = el(doc, 'summary', {}, [el(doc, 'span', { text: 'Labs — flags, A/B, scenario ' }), ui.mask]);
  ui.workerList = el(doc, 'div', { className: 'labs-grid' });
  ui.simList = el(doc, 'div', { className: 'labs-grid' });
  ui.params = el(doc, 'div', { className: 'mono' });
  const cam = el(doc, 'label', { className: 'labs-flag', title: 'K9' }, [
    el(doc, 'select', { disabled: true }, [el(doc, 'option', { text: 'ideal (camera profiles: K9 not built)' })]),
  ]);
  ui.seed = el(doc, 'input', { type: 'number', value: '1', min: '1' });
  ui.scale = el(doc, 'select', {}, [el(doc, 'option', { value: '1', text: 'full size' }), el(doc, 'option', { value: '0.5', text: 'half size (fast)' })]);
  ui.run = el(doc, 'button', { type: 'button', text: 'Run A/B (off vs selected)' });
  ui.dl = el(doc, 'button', { type: 'button', text: 'Download scenario JSON' });
  ui.reset = el(doc, 'button', { type: 'button', text: 'Reset all flags OFF' });
  ui.status = el(doc, 'div', { className: 'mono', text: '' });
  ui.results = el(doc, 'div', { className: 'mono' });
  ui.run.addEventListener('click', runAbNow);
  ui.dl.addEventListener('click', downloadScenario);
  ui.reset.addEventListener('click', resetAll);

  container.appendChild(summary);
  container.appendChild(el(doc, 'div', { text: 'Worker flags (live: applied on the next frame)' }));
  container.appendChild(ui.workerList);
  container.appendChild(el(doc, 'div', { text: 'Sim / AR flags' }));
  container.appendChild(ui.simList);
  container.appendChild(el(doc, 'div', { text: 'Run parameters (from the page controls)' }));
  container.appendChild(ui.params);
  container.appendChild(cam);
  container.appendChild(el(doc, 'div', {}, [el(doc, 'span', { text: 'seed ' }), ui.seed, ui.scale]));
  container.appendChild(el(doc, 'div', {}, [ui.run, ui.dl, ui.reset]));
  container.appendChild(ui.status);
  container.appendChild(ui.results);
  renderFlags();

  return { refresh: renderFlags, runAb: runAbNow, downloadScenario, resetAll, ui, getLastRows: () => lastRows };
}
