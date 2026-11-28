/**
 * G2 — SimGate Scenario Matrix & Flag-Set Definitions (`tools/gate/scenarios.mjs`).
 *
 * Wave 1 scope:
 *  - Profile: `ideal` only (no K-model yet; K9 adds A53 profiles in Wave 3).
 *  - Presets: the 4 original presets (`S01` flags-off, `S02` W-all) + the 6 FC presets
 *    (including `snake-h-fast-step`) from `src/sim/presets.js`.
 *  - Flag sets per spec section 10.1: `off`, `W-fc`, `W-all`, `strict`, `A-all`, `single:<flag>`.
 */

import { FLAG_DEFS, flagsToWorkerMask } from '../../src/flags.js';
import {
  ORIGINAL_PRESET_IDS,
  FC_PRESET_IDS,
  getPreset,
  createSceneForPreset,
} from '../../src/sim/presets.js';
import { PATH_DEFINITIONS, computeOptics } from '../../src/sim/paths.js';
import { computeCode128Modules } from '../../src/sim/label.js';

export const DEFAULT_SEEDS = Object.freeze([1, 2, 3, 4, 5]);
export const QUICK_SEEDS = Object.freeze([1]);
export const QUICK_MAX_DURATION_SEC = 10;

// Spec section 10.1 canonical worker flag sets
export const W_FC_FLAGS = Object.freeze([
  'vertFallback',
  'extraLines',
  'cribMatch',
  'requirePrefix',
  'prefixStack',
  'illumNorm',
  'scanSmooth',
  'stopGuard',
]);

export const W_ALL_FLAGS = Object.freeze(
  FLAG_DEFS
    .filter((d) => d.bit !== null && !d.exclusive)
    .map((d) => d.name)
);

export const STRICT_FLAGS = Object.freeze([...W_FC_FLAGS, 'requirePrefixStrict']);

export const A_ALL_FLAGS = Object.freeze(
  FLAG_DEFS
    .filter((d) => d.item && /^A\d+/.test(d.item))
    .map((d) => d.name)
);

export const FLAG_SETS = Object.freeze({
  off: Object.freeze({ id: 'off', worker: Object.freeze([]), page: Object.freeze([]) }),
  'W-fc': Object.freeze({ id: 'W-fc', worker: W_FC_FLAGS, page: Object.freeze([]) }),
  'W-all': Object.freeze({ id: 'W-all', worker: W_ALL_FLAGS, page: Object.freeze([]) }),
  strict: Object.freeze({ id: 'strict', worker: STRICT_FLAGS, page: Object.freeze([]) }),
  'A-all': Object.freeze({ id: 'A-all', worker: Object.freeze([]), page: A_ALL_FLAGS }),
});

const FLAG_DEF_MAP = new Map(FLAG_DEFS.map((d) => [d.name, d]));

/**
 * Resolves a flag set name (`off`, `W-fc`, `W-all`, `strict`, `A-all`, `single:<flag>`,
 * or comma-separated flag names) into `{ id, worker: string[], page: string[], workerMask: number }`.
 */
export function resolveFlagSet(spec) {
  if (typeof spec === 'string') {
    const trimmed = spec.trim();
    if (FLAG_SETS[trimmed]) {
      const def = FLAG_SETS[trimmed];
      return {
        id: def.id,
        worker: [...def.worker],
        page: [...def.page],
        workerMask: namesToWorkerMask(def.worker),
      };
    }
    if (trimmed.startsWith('single:')) {
      const name = trimmed.slice('single:'.length);
      const def = FLAG_DEF_MAP.get(name);
      if (!def) throw new Error(`Unknown flag in single:<flag>: ${name}`);
      const worker = def.bit !== null ? [name] : [];
      const page = def.bit === null ? [name] : [];
      return {
        id: trimmed,
        worker,
        page,
        workerMask: namesToWorkerMask(worker),
      };
    }
    // Comma-separated ad-hoc flag list
    const tokens = trimmed.split(',').map((s) => s.trim()).filter(Boolean);
    const worker = [];
    const page = [];
    for (const tok of tokens) {
      const def = FLAG_DEF_MAP.get(tok);
      if (!def) throw new Error(`Unknown flag in flag set "${spec}": ${tok}`);
      if (def.bit !== null) worker.push(tok);
      else page.push(tok);
    }
    return {
      id: trimmed || 'off',
      worker,
      page,
      workerMask: namesToWorkerMask(worker),
    };
  }
  if (spec && typeof spec === 'object') {
    const worker = Array.isArray(spec.worker) ? [...spec.worker] : [];
    const page = Array.isArray(spec.page) ? [...spec.page] : [];
    return {
      id: spec.id || (worker.length ? worker.join(',') : 'off'),
      worker,
      page,
      workerMask: namesToWorkerMask(worker),
    };
  }
  return { id: 'off', worker: [], page: [], workerMask: 0 };
}

function namesToWorkerMask(names) {
  const map = {};
  for (let i = 0; i < names.length; i++) {
    map[names[i]] = true;
  }
  return flagsToWorkerMask(map);
}

/**
 * Computes the physical duration (seconds) for one complete traversal of a preset path.
 * Static (`manual`) presets use 2.0 s (60 frames at 30 fps) as one canonical observation loop.
 */
export function computePresetLoopDurationSec(preset) {
  const pathDef = PATH_DEFINITIONS.find((p) => p.id === preset.pathId);
  if (!pathDef || pathDef.lengthIn <= 0) {
    return 2.0;
  }
  return pathDef.lengthIn / Math.max(0.5, preset.speedInPerSec || 18);
}

/**
 * Builds a complete scenario object from a preset ID in `src/sim/presets.js`.
 */
export function createScenarioFromPreset(presetId, opts = {}) {
  const preset = getPreset(presetId);
  const scene = createSceneForPreset(presetId, opts.sceneOverrides || {});
  const loops = opts.loops > 0 ? (opts.loops | 0) : 1;
  const loopDurationSec = computePresetLoopDurationSec(preset);
  const durationSec = Number.isFinite(opts.durationSec)
    ? opts.durationSec
    : Number((loopDurationSec * loops).toFixed(4));
  const flagSetId = opts.flagSet || 'off';
  const flags = resolveFlagSet(flagSetId);

  const samplePayload = scene.cells[0]?.payload || '';
  const totalModules = samplePayload ? computeCode128Modules(samplePayload, scene.label.quietModules) : 231;
  const optics = computeOptics({
    distanceIn: preset.distanceIn,
    hfovDeg: preset.hfovDeg,
    widthPx: preset.width,
    heightPx: preset.height,
    totalModules,
    labelWidthIn: preset.labelWidthIn,
    labelHeightIn: preset.labelHeightIn,
    orientation: scene.label.orientation,
  });

  return {
    id: opts.id || presetId,
    group: opts.group || preset.group,
    presetId,
    profile: opts.profile || 'ideal',
    fidelityStatus: 'uncalibrated',
    path: preset.pathId,
    scene,
    width: opts.width || preset.width,
    height: opts.height || preset.height,
    hfovDeg: preset.hfovDeg,
    distanceIn: preset.distanceIn,
    speed: preset.speedInPerSec,
    fpsCap: preset.fpsCap,
    shutterMs: preset.shutterMs,
    jitter: preset.jitter,
    loop: preset.loop,
    loops,
    loopDurationSec: Number(loopDurationSec.toFixed(4)),
    manualPose: preset.manualPose ? { ...preset.manualPose } : null,
    durationSec,
    seeds: Array.isArray(opts.seeds) ? [...opts.seeds] : [...DEFAULT_SEEDS],
    flags,
    flagSets: Array.isArray(opts.flagSets) ? [...opts.flagSets] : [flags.id],
    array: Boolean(opts.array),
    quick: Boolean(opts.quick),
    quickFullLength: Boolean(opts.quickFullLength),
    quickFlagSets: Array.isArray(opts.quickFlagSets) ? [...opts.quickFlagSets] : null,
    quickSeeds: Array.isArray(opts.quickSeeds) ? [...opts.quickSeeds] : null,
    quickMode: Boolean(opts.quickMode),
    truncated: Boolean(opts.truncated),
    truncatedAtSec: opts.truncatedAtSec ?? null,
    coverageGated: opts.coverageGated !== false,
    fpGated: Boolean(opts.fpGated),
    ppm: Number(optics.ppm.toFixed(3)),
    expectedPayloads: opts.expectedPayloads
      ? [...opts.expectedPayloads]
      : scene.cells.map((c) => c.payload),
  };
}

/**
 * Builds the canonical Wave 1 scenario registry:
 *  - S01: the 4 original presets (`ideal`, `off`) — quick-eligible (truncated at 10 s in --quick)
 *  - S02: the 4 original presets (`ideal`, `W-all`)
 *  - FC presets + `snake-h-fast-step` (`ideal`, `off` / `W-fc` / `W-all`;
 *    `fc-tele-30-3p5` also runs full-length `off,W-fc` in `--quick` as the F1/F6 stopGuard FP gate)
 */
export function buildWave1Scenarios() {
  const list = [];

  for (const presetId of ORIGINAL_PRESET_IDS) {
    list.push(createScenarioFromPreset(presetId, {
      id: `S01-${presetId}`,
      group: 'S01',
      profile: 'ideal',
      flagSet: 'off',
      flagSets: ['off'],
      quick: true,
      quickFullLength: false,
      quickFlagSets: ['off'],
      quickSeeds: [...QUICK_SEEDS],
    }));
  }

  for (const presetId of ORIGINAL_PRESET_IDS) {
    list.push(createScenarioFromPreset(presetId, {
      id: `S02-${presetId}`,
      group: 'S02',
      profile: 'ideal',
      flagSet: 'W-all',
      flagSets: ['W-all'],
      quick: false,
    }));
  }

  for (const presetId of FC_PRESET_IDS) {
    const isQuickFpGate = presetId === 'fc-tele-30-3p5';
    list.push(createScenarioFromPreset(presetId, {
      id: `fc-${presetId.replace(/^fc-/, '')}`,
      group: 'fc',
      profile: 'ideal',
      flagSet: 'off',
      flagSets: ['off', 'W-fc', 'W-all'],
      quick: isQuickFpGate,
      quickFullLength: isQuickFpGate,
      quickFlagSets: isQuickFpGate ? ['off', 'W-fc'] : null,
      quickSeeds: isQuickFpGate ? [1, 2] : null,
    }));
  }

  return list;
}

/**
 * Filters and expands Wave 1 scenarios according to CLI switches (`--only`, `--quick`,
 * `--seeds`, `--flags`, `--loops`, `--duration`).
 */
export function selectScenarios(opts = {}) {
  let scenarios = buildWave1Scenarios();

  if (opts.only) {
    const wanted = String(opts.only)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const wantedSet = new Set(wanted);
    scenarios = scenarios.filter((sc) =>
      wantedSet.has(sc.id) ||
      wantedSet.has(sc.presetId) ||
      wantedSet.has(sc.group)
    );
    if (scenarios.length === 0) {
      throw new Error(`No scenarios match --only=${opts.only}`);
    }
  } else if (opts.quick) {
    scenarios = scenarios.filter((sc) => sc.quick);
  }

  const expanded = [];
  for (const sc of scenarios) {
    const flagSetIds = opts.flags
      ? String(opts.flags).split(',').map((s) => s.trim()).filter(Boolean)
      : (opts.quick ? (sc.quickFlagSets || [sc.flagSets[0]]) : sc.flagSets);

    for (const fsId of flagSetIds) {
      let seeds = sc.seeds;
      if (Number.isFinite(opts.seeds) && opts.seeds > 0) {
        const n = opts.seeds | 0;
        seeds = Array.from({ length: n }, (_, i) => i + 1);
      } else if (opts.quick) {
        seeds = sc.quickSeeds ? [...sc.quickSeeds] : [...QUICK_SEEDS];
      }

      const loops = Number.isFinite(opts.loops) && opts.loops > 0 ? (opts.loops | 0) : sc.loops;
      const fullDurationSec = Number((sc.loopDurationSec * loops).toFixed(4));
      let durationSec = Number.isFinite(opts.durationSec)
        ? opts.durationSec
        : fullDurationSec;
      if (opts.quick && !Number.isFinite(opts.durationSec) && !sc.quickFullLength) {
        durationSec = Math.min(durationSec, QUICK_MAX_DURATION_SEC);
      }

      const truncated = Boolean(opts.quick && durationSec + 1e-6 < fullDurationSec);
      const truncatedAtSec = truncated ? durationSec : null;
      const flagObj = resolveFlagSet(fsId);
      const runId = flagSetIds.length > 1 || (opts.flags && fsId !== sc.flags.id)
        ? `${sc.id}[${flagObj.id}]`
        : sc.id;

      expanded.push({
        ...sc,
        runId,
        loops,
        durationSec,
        fullDurationSec,
        seeds,
        flags: flagObj,
        quickMode: Boolean(opts.quick),
        truncated,
        truncatedAtSec,
        coverageGated: !opts.quick,
        fpGated: Boolean(opts.quick && flagObj.id !== 'off'),
      });
    }
  }

  return expanded;
}
