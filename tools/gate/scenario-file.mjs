/**
 * R3 — loads a Labs `dbc-scenario` JSON file as a SimGate scenario (`tools/gate/scenario-file.mjs`).
 * Uses the same `specFromScenarioJson` as the in-browser A/B runner, so the file means the same thing in both.
 */
import { readFileSync } from 'node:fs';
import { specFromScenarioJson } from '../../src/sim/labs-scenario.js';
import { createScenarioFromPreset } from './scenarios.mjs';

export function scenarioFromSpec(spec, flagSet) {
  const sc = createScenarioFromPreset(spec.presetId, {
    id: `file-${spec.presetId}-${flagSet.id}`,
    group: 'file',
    profile: spec.profile || 'ideal',
    flagSet: flagSet.worker.length ? flagSet.worker.join(',') : 'off',
    seeds: spec.seeds,
    durationSec: spec.durationSec,
    sceneOverrides: {},
    width: spec.width,
    height: spec.height,
  });
  // the file's own scene, camera and path replace the preset's (the page may have edited them)
  sc.scene = spec.scene;
  sc.path = spec.path;
  sc.distanceIn = spec.distanceIn;
  sc.hfovDeg = spec.hfovDeg;
  sc.speed = spec.speed;
  sc.fpsCap = spec.fpsCap;
  sc.shutterMs = spec.shutterMs;
  sc.jitter = spec.jitter;
  sc.loop = spec.loop;
  sc.manualPose = spec.manualPose;
  sc.expectedPayloads = spec.scene.cells.map((c) => c.payload);
  sc.flags = { id: flagSet.id, worker: [...flagSet.worker], page: [], workerMask: flagSet.workerMask };
  return sc;
}

export function loadScenarioFile(path) {
  const obj = JSON.parse(readFileSync(path, 'utf8'));
  const spec = specFromScenarioJson(obj);
  return { obj, spec, scenarios: spec.flagSets.map((fs) => ({ flagSet: fs, scenario: scenarioFromSpec(spec, fs) })) };
}
