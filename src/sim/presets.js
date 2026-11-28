/**
 * R4 — Frozen Canonical Simulator Presets (`src/sim/presets.js`).
 *
 * Exact data copy of the presets defined in `sim.html` `applyPreset()` so headless gate runs,
 * CPU baseline captures (G3), and browser sessions share identical scenario parameters.
 * Protected by `tests/sim-presets-golden.test.js`.
 */

import { createScene } from './scene.js';
import { createFcLabelSpec } from './label.js';

export const ORIGINAL_PRESET_IDS = Object.freeze([
  'a53-8-720',
  'a53-8-1080',
  'tele-30',
  'full-wall',
]);

export const FC_PRESET_IDS = Object.freeze([
  'fc-8-3p5',
  'fc-12-3p5-auto',
  'fc-tele-30-3p5',
  'fc-30-1x-fail',
  'fc-jitter-hard',
  'snake-h-fast-step',
]);

function freezePreset(obj) {
  if (obj.manualPose) Object.freeze(obj.manualPose);
  return Object.freeze(obj);
}

export const SIM_PRESETS = Object.freeze({
  'a53-8-720': freezePreset({
    id: 'a53-8-720',
    group: 'original',
    fcMode: false,
    labelWidthIn: 2,
    labelHeightIn: 6,
    pathId: 'snake-h',
    distanceIn: 10,
    hfovDeg: 70.7,
    speedInPerSec: 18,
    fpsCap: 13,
    shutterMs: 2,
    jitter: 0.15,
    shadowStrength: 0.35,
    noiseStrength: 0.015,
    glareStrength: 0.16,
    width: 1280,
    height: 720,
    loop: true,
    multi: true,
  }),
  'a53-8-1080': freezePreset({
    id: 'a53-8-1080',
    group: 'original',
    fcMode: false,
    labelWidthIn: 2,
    labelHeightIn: 6,
    pathId: 'snake-h',
    distanceIn: 12,
    hfovDeg: 70.7,
    speedInPerSec: 20,
    fpsCap: 13,
    shutterMs: 2,
    jitter: 0.15,
    shadowStrength: 0.35,
    noiseStrength: 0.015,
    glareStrength: 0.16,
    width: 1920,
    height: 1080,
    loop: true,
    multi: true,
  }),
  'tele-30': freezePreset({
    id: 'tele-30',
    group: 'original',
    fcMode: false,
    labelWidthIn: 2,
    labelHeightIn: 6,
    pathId: 'pan-snake',
    distanceIn: 30,
    hfovDeg: 26,
    speedInPerSec: 22,
    fpsCap: 30,
    shutterMs: 2,
    jitter: 0.15,
    shadowStrength: 0.35,
    noiseStrength: 0.015,
    glareStrength: 0.16,
    width: 1920,
    height: 1080,
    loop: true,
    multi: true,
  }),
  'full-wall': freezePreset({
    id: 'full-wall',
    group: 'original',
    fcMode: false,
    labelWidthIn: 2,
    labelHeightIn: 6,
    pathId: 'manual',
    distanceIn: 52,
    manualPose: { x: 0, y: 0, z: 52, yawDeg: 0, pitchDeg: 0, rollDeg: 0 },
    hfovDeg: 70.7,
    speedInPerSec: 18,
    fpsCap: 30,
    shutterMs: 0,
    jitter: 0,
    shadowStrength: 0.35,
    noiseStrength: 0.015,
    glareStrength: 0.16,
    width: 1920,
    height: 1080,
    loop: true,
    multi: true,
  }),
  'fc-8-3p5': freezePreset({
    id: 'fc-8-3p5',
    group: 'fc',
    fcMode: true,
    labelWidthIn: 2,
    labelHeightIn: 3.5,
    pathId: 'snake-h',
    distanceIn: 8,
    hfovDeg: 70.7,
    speedInPerSec: 14,
    fpsCap: 13,
    shutterMs: 4,
    jitter: 0.25,
    shadowStrength: 0.35,
    noiseStrength: 0.015,
    glareStrength: 0.16,
    width: 1920,
    height: 1080,
    loop: true,
    multi: true,
  }),
  'fc-12-3p5-auto': freezePreset({
    id: 'fc-12-3p5-auto',
    group: 'fc',
    fcMode: true,
    labelWidthIn: 2,
    labelHeightIn: 3.5,
    pathId: 'snake-h',
    distanceIn: 12,
    hfovDeg: 70.7,
    speedInPerSec: 14,
    fpsCap: 13,
    shutterMs: 16,
    jitter: 0.30,
    shadowStrength: 0.35,
    noiseStrength: 0.015,
    glareStrength: 0.16,
    width: 1920,
    height: 1080,
    loop: true,
    multi: true,
  }),
  'fc-tele-30-3p5': freezePreset({
    id: 'fc-tele-30-3p5',
    group: 'fc',
    fcMode: true,
    labelWidthIn: 2,
    labelHeightIn: 3.5,
    pathId: 'pan-snake',
    distanceIn: 30,
    hfovDeg: 26,
    speedInPerSec: 18,
    fpsCap: 30,
    shutterMs: 4,
    jitter: 0.25,
    shadowStrength: 0.35,
    noiseStrength: 0.015,
    glareStrength: 0.16,
    width: 1920,
    height: 1080,
    loop: true,
    multi: true,
  }),
  'fc-30-1x-fail': freezePreset({
    id: 'fc-30-1x-fail',
    group: 'fc',
    fcMode: true,
    labelWidthIn: 2,
    labelHeightIn: 3.5,
    pathId: 'pan-snake',
    distanceIn: 30,
    hfovDeg: 70.7,
    speedInPerSec: 16,
    fpsCap: 13,
    shutterMs: 8,
    jitter: 0.20,
    shadowStrength: 0.35,
    noiseStrength: 0.015,
    glareStrength: 0.16,
    width: 1920,
    height: 1080,
    loop: true,
    multi: true,
  }),
  'fc-jitter-hard': freezePreset({
    id: 'fc-jitter-hard',
    group: 'fc',
    fcMode: true,
    labelWidthIn: 2,
    labelHeightIn: 3.5,
    pathId: 'snake-h',
    distanceIn: 10,
    hfovDeg: 70.7,
    speedInPerSec: 16,
    fpsCap: 10,
    shutterMs: 8,
    jitter: 0.65,
    shadowStrength: 0.35,
    noiseStrength: 0.015,
    glareStrength: 0.16,
    width: 1920,
    height: 1080,
    loop: true,
    multi: true,
  }),
  'snake-h-fast-step': freezePreset({
    id: 'snake-h-fast-step',
    group: 'fc',
    fcMode: true,
    labelWidthIn: 2,
    labelHeightIn: 3.5,
    pathId: 'snake-h-fast-step',
    distanceIn: 12,
    hfovDeg: 70.7,
    speedInPerSec: 14,
    fpsCap: 13,
    shutterMs: 4,
    jitter: 0.25,
    shadowStrength: 0.35,
    noiseStrength: 0.015,
    glareStrength: 0.16,
    width: 1920,
    height: 1080,
    loop: true,
    multi: true,
  }),
});

export function getPreset(id) {
  const preset = SIM_PRESETS[id];
  if (!preset) {
    throw new Error(`Unknown sim preset: ${id}`);
  }
  return preset;
}

export function listPresets() {
  return Object.values(SIM_PRESETS);
}

export function createSceneForPreset(id, overrides = {}) {
  const preset = getPreset(id);
  return createScene({
    fcMode: preset.fcMode,
    shadowStrength: preset.shadowStrength,
    noiseStrength: preset.noiseStrength,
    glareStrength: preset.glareStrength,
    ...overrides,
    label: {
      widthIn: preset.labelWidthIn,
      heightIn: preset.labelHeightIn,
      ...(overrides.label || {}),
    },
  });
}

/**
 * L2 — Flag-gated helper that applies the FC 2x3.5 in 11-char `tsX` label spec
 * (`simFcLabel`) to a scene, preset object, or preset ID without mutating any
 * frozen preset or altering legacy 12-char/16-char payloads when `simFcLabel` is false.
 *
 * @param {object | string} sceneOrPreset
 * @param {{ seed?: number, simFcLabel?: boolean }} [opts]
 */
export function applySimFcLabel(sceneOrPreset, opts = {}) {
  const simFcLabel = Boolean(opts && opts.simFcLabel);
  const seed = opts && opts.seed !== undefined ? opts.seed : 1;

  if (typeof sceneOrPreset === 'string') {
    const baseScene = createSceneForPreset(sceneOrPreset);
    return simFcLabel ? applySimFcLabel(baseScene, { seed, simFcLabel: true }) : baseScene;
  }

  if (!simFcLabel || !sceneOrPreset || typeof sceneOrPreset !== 'object') {
    return sceneOrPreset;
  }

  // Scene object (has `cells` array)
  if (Array.isArray(sceneOrPreset.cells)) {
    const count = Math.max(16, (sceneOrPreset.cols | 0) * (sceneOrPreset.rows | 0));
    const fcSpec = createFcLabelSpec({ seed, count });
    return createScene({
      cols: sceneOrPreset.cols,
      rows: sceneOrPreset.rows,
      pitchXIn: sceneOrPreset.pitchXIn,
      pitchYIn: sceneOrPreset.pitchYIn,
      tote: sceneOrPreset.tote,
      fcMode: true,
      label: {
        ...sceneOrPreset.label,
        widthIn: fcSpec.widthIn,
        heightIn: fcSpec.heightIn,
        quietModules: fcSpec.quietModules,
        printGain: fcSpec.printGain,
        orientation: fcSpec.orientation,
        payloadFn: fcSpec.payloadFn,
      },
      labelOffset: sceneOrPreset.labelOffset,
      lips: sceneOrPreset.lips,
      negatives: sceneOrPreset.negatives,
      defects: sceneOrPreset.defects,
      wallTexture: sceneOrPreset.wallTexture,
      shadowStrength: sceneOrPreset.shadowStrength,
      noiseStrength: sceneOrPreset.noiseStrength,
      glareStrength: sceneOrPreset.glareStrength,
    });
  }

  // Preset object (never mutate frozen SIM_PRESETS entry; return a new object)
  const fcSpec = createFcLabelSpec({ seed, count: 16 });
  return {
    ...sceneOrPreset,
    fcMode: true,
    labelWidthIn: fcSpec.widthIn,
    labelHeightIn: fcSpec.heightIn,
    labelOrientation: fcSpec.orientation,
    printGain: fcSpec.printGain,
    label: fcSpec,
    simFcLabel: true,
    seed,
  };
}
