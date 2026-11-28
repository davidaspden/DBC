/**
 * R3 — Labs scenario description (`src/sim/labs-scenario.js`).
 *
 * A browser-safe (no node imports) description of one sim run that the Labs panel in `sim.html` can
 * download and `tools/run-scenario.mjs` (the `simgate --scenario` equivalent) can reproduce headless.
 *
 *   {
 *     format: 'dbc-scenario', version: 1,
 *     presetId, params: { pathId, distanceIn, hfovDeg, speedInPerSec, fpsCap, shutterMs, jitter,
 *                         width, height, loop, manualPose? },
 *     sceneOverrides: { shadowStrength, noiseStrength, glareStrength, fcMode?, label: { widthIn?, heightIn? } },
 *     flags: { worker: [names], sim: [names] },
 *     run: { seeds: [1], durationSec, flagSets: [{ id, worker: [names] }] },
 *     reported?: { [flagSetId]: { decoded, total, falsePositives, timeToAllSec } }   // what the page showed
 *   }
 *
 * Pure functions. Never imported by the worker.
 */

import { flagsToWorkerMask } from '../flags.js';
import { getPreset, createSceneForPreset, applySimFcLabel } from './presets.js';
import { PATH_DEFINITIONS } from './paths.js';

export const SCENARIO_FORMAT = 'dbc-scenario';
export const SCENARIO_VERSION = 1;

/** Sim flags the headless run honours today (the rest are recorded in the file but have no effect yet). */
export const HEADLESS_SIM_FLAGS = Object.freeze(['simFcLabel']);

export function workerMaskFromNames(names) {
  const map = {};
  for (let i = 0; i < names.length; i++) map[names[i]] = true;
  return flagsToWorkerMask(map);
}

/** One canonical pass of a preset path in seconds (static `manual` paths use 2 s), as simgate does. */
export function loopDurationSec(pathId, speedInPerSec) {
  const def = PATH_DEFINITIONS.find((p) => p.id === pathId);
  if (!def || def.lengthIn <= 0) return 2.0;
  return def.lengthIn / Math.max(0.5, speedInPerSec || 18);
}

/**
 * Builds the downloadable scenario object from the sim page state and the Labs panel selections.
 *
 * @param {{ presetId: string, state: object, workerFlags: string[], simFlags?: string[],
 *           seeds?: number[], durationSec?: number, flagSets?: Array<{id:string, worker:string[]}>,
 *           reported?: object }} o
 */
export function buildScenarioJson(o) {
  const st = o.state || {};
  const preset = getPreset(o.presetId);
  const speed = Number.isFinite(st.speedInPerSec) ? st.speedInPerSec : preset.speedInPerSec;
  const pathId = st.pathId || preset.pathId;
  const out = {
    format: SCENARIO_FORMAT,
    version: SCENARIO_VERSION,
    generator: 'sim.html Labs panel',
    presetId: o.presetId,
    params: {
      pathId,
      distanceIn: st.distanceIn ?? preset.distanceIn,
      hfovDeg: st.hfovDeg ?? preset.hfovDeg,
      speedInPerSec: speed,
      fpsCap: st.fpsCap ?? preset.fpsCap,
      shutterMs: st.shutterMs ?? preset.shutterMs,
      jitter: st.jitter ?? preset.jitter,
      width: st.width ?? preset.width,
      height: st.height ?? preset.height,
      loop: false,
    },
    sceneOverrides: {
      shadowStrength: st.shadowStrength ?? preset.shadowStrength,
      noiseStrength: st.noiseStrength ?? preset.noiseStrength,
      glareStrength: preset.glareStrength,
      fcMode: Boolean(st.fcMode ?? preset.fcMode),
      label: { widthIn: preset.labelWidthIn, heightIn: st.labelHeightIn ?? preset.labelHeightIn },
    },
    flags: {
      worker: [...(o.workerFlags || [])],
      sim: [...(o.simFlags || [])],
    },
    run: {
      seeds: o.seeds && o.seeds.length ? [...o.seeds] : [1],
      durationSec: Number.isFinite(o.durationSec) ? o.durationSec : Number(loopDurationSec(pathId, speed).toFixed(4)),
      flagSets: o.flagSets && o.flagSets.length
        ? o.flagSets.map((f) => ({ id: f.id, worker: [...f.worker] }))
        : [{ id: 'selected', worker: [...(o.workerFlags || [])] }],
    },
  };
  if (pathId === 'manual' && st.manualPose) out.params.manualPose = { ...st.manualPose };
  if (o.reported) out.reported = o.reported;
  return out;
}

export function validateScenarioJson(obj) {
  const errors = [];
  if (!obj || typeof obj !== 'object') return { ok: false, errors: ['not an object'] };
  if (obj.format !== SCENARIO_FORMAT) errors.push(`format must be "${SCENARIO_FORMAT}"`);
  if (obj.version !== SCENARIO_VERSION) errors.push(`unsupported version ${obj.version}`);
  try {
    getPreset(obj.presetId);
  } catch {
    errors.push(`unknown presetId ${obj.presetId}`);
  }
  const p = obj.params || {};
  if (!PATH_DEFINITIONS.some((d) => d.id === p.pathId)) errors.push(`unknown pathId ${p.pathId}`);
  for (const k of ['distanceIn', 'hfovDeg', 'speedInPerSec', 'fpsCap', 'width', 'height']) {
    if (!(p[k] > 0)) errors.push(`params.${k} must be > 0`);
  }
  const run = obj.run || {};
  if (!Array.isArray(run.seeds) || run.seeds.length === 0) errors.push('run.seeds must be a non-empty array');
  if (!(run.durationSec > 0)) errors.push('run.durationSec must be > 0');
  if (!Array.isArray(run.flagSets) || run.flagSets.length === 0) errors.push('run.flagSets must be non-empty');
  return { ok: errors.length === 0, errors };
}

/**
 * Turns a validated scenario object into a run spec (scene + camera + path + flag sets) shared by the
 * in-browser A/B runner (`ab-run.js`) and the headless loader (`tools/gate/scenario-file.mjs`).
 */
export function specFromScenarioJson(obj) {
  const v = validateScenarioJson(obj);
  if (!v.ok) throw new Error(`Invalid scenario: ${v.errors.join('; ')}`);
  const p = obj.params;
  const so = obj.sceneOverrides || {};
  let scene = createSceneForPreset(obj.presetId, {
    ...(Number.isFinite(so.shadowStrength) ? { shadowStrength: so.shadowStrength } : {}),
    ...(Number.isFinite(so.noiseStrength) ? { noiseStrength: so.noiseStrength } : {}),
    ...(Number.isFinite(so.glareStrength) ? { glareStrength: so.glareStrength } : {}),
    ...(typeof so.fcMode === 'boolean' ? { fcMode: so.fcMode } : {}),
    label: { ...(so.label || {}) },
  });
  const simFlags = (obj.flags && obj.flags.sim) || [];
  if (simFlags.includes('simFcLabel')) scene = applySimFcLabel(scene, { simFcLabel: true, seed: obj.run.seeds[0] });
  return {
    presetId: obj.presetId,
    scene,
    path: p.pathId,
    distanceIn: p.distanceIn,
    hfovDeg: p.hfovDeg,
    speed: p.speedInPerSec,
    fpsCap: p.fpsCap,
    shutterMs: p.shutterMs || 0,
    jitter: p.jitter || 0,
    width: p.width | 0,
    height: p.height | 0,
    loop: false,
    manualPose: p.manualPose ? { ...p.manualPose } : null,
    durationSec: obj.run.durationSec,
    seeds: [...obj.run.seeds],
    flagSets: obj.run.flagSets.map((f) => ({ id: f.id, worker: [...f.worker], workerMask: workerMaskFromNames(f.worker) })),
    unsupportedSimFlags: simFlags.filter((n) => !HEADLESS_SIM_FLAGS.includes(n)),
    reported: obj.reported || null,
  };
}
