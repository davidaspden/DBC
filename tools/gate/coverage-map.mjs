/**
 * G5 — Complete Product & Sim/AR Feature-Flag Coverage Map (`tools/gate/coverage-map.mjs`).
 *
 * Maps every flag in `src/flags.js` (`FLAG_DEFS`) and `src/sim/simflags.js` (`SIM_FLAG_DEFS`)
 * to either:
 *   - One or more SimGate scenario IDs (`scenarios: [...]`) that enable the flag, and/or
 *   - One or more existing Node test files (`tests: [{ file, testName? }]`) with a one-line
 *     `reason` explaining why the headless gate cannot directly exercise it (or what future
 *     Wave 2/3 item `planned` adds gate coverage).
 *
 * Guarded by `tests/flag-coverage.test.js`: adding a flag without an entry, or removing a
 * mapped scenario/test file, fails CI.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FLAG_DEFS } from '../../src/flags.js';
import { SIM_FLAG_DEFS } from '../../src/sim/simflags.js';
import { buildWave1Scenarios, resolveFlagSet } from './scenarios.mjs';

export const PRODUCT_FLAG_COVERAGE = Object.freeze({
  // Platform
  tapeRecord: {
    registry: 'product',
    scenarios: [],
    tests: [{ file: 'tests/tape.test.js', testName: 'Tape recorder encodes gzipped .dbct v1 frames' }],
    planned: 'S15/T4',
    reason: 'Browser MediaStream/CompressionStream tape recording; round-trip verified in Node tape test (T4 adds sim-to-tape).',
  },

  // Stream W — Worker / Decoder (all non-exclusive worker flags exercised by S02 & FC scenarios + unit tests)
  vertFallback: {
    registry: 'product',
    scenarios: ['S02-a53-8-720', 'fc-8-3p5'],
    tests: [{ file: 'tests/w1-vertical.test.js', testName: 'W1 vertFallback vertical mode decodes' }],
    planned: 'S03-S05/S18',
    reason: 'Exercised by SimGate W-fc and W-all worker flag sets.',
  },
  extraLines: {
    registry: 'product',
    scenarios: ['S02-a53-8-720', 'fc-8-3p5'],
    tests: [{ file: 'tests/w2-decoder.test.js', testName: 'W2 + W6 + W7 combined decode' }],
    planned: 'S03-S05/S18',
    reason: 'Exercised by SimGate W-fc and W-all worker flag sets.',
  },
  cribMatch: {
    registry: 'product',
    scenarios: ['S02-a53-8-720', 'fc-8-3p5'],
    tests: [{ file: 'tests/w2-decoder.test.js', testName: 'W3 cribMatch detects tsX prefix' }],
    planned: 'S03-S05/S13/S18',
    reason: 'Exercised by SimGate W-fc and W-all worker flag sets.',
  },
  requirePrefix: {
    registry: 'product',
    scenarios: ['S02-a53-8-720', 'fc-8-3p5'],
    tests: [{ file: 'tests/w2-decoder.test.js', testName: 'W4 requirePrefix still decodes plain non-tsX labels' }],
    planned: 'S03-S05/S13/S18',
    reason: 'Exercised by SimGate W-fc and W-all worker flag sets.',
  },
  requirePrefixStrict: {
    registry: 'product',
    scenarios: [],
    tests: [{ file: 'tests/w2-decoder.test.js', testName: 'W4 requirePrefix still decodes plain non-tsX labels' }],
    planned: 'S11/H2',
    reason: 'Exclusive strict tsX gate excluded from W-all (H1); exercised by W4 unit test until S11 negatives/H2 land.',
  },
  prefixStack: {
    registry: 'product',
    scenarios: ['S02-a53-8-720', 'fc-8-3p5'],
    tests: [{ file: 'tests/w3-worker.test.js', testName: 'W5 prefixStack + W8 scanSmooth decode' }],
    planned: 'S03-S05/S18',
    reason: 'Exercised by SimGate W-fc and W-all worker flag sets.',
  },
  illumNorm: {
    registry: 'product',
    scenarios: ['S02-a53-8-720', 'fc-8-3p5'],
    tests: [{ file: 'tests/w2-decoder.test.js', testName: 'W2 + W6 + W7 combined decode' }],
    planned: 'S03-S05/S08/S18',
    reason: 'Exercised by SimGate W-fc and W-all worker flag sets.',
  },
  subpixEdges: {
    registry: 'product',
    scenarios: ['S02-a53-8-720', 'fc-8-3p5'],
    tests: [{ file: 'tests/w2-decoder.test.js', testName: 'W2 + W6 + W7 combined decode' }],
    planned: 'S03-S05/S18',
    reason: 'Exercised by SimGate W-all worker flag set.',
  },
  scanSmooth: {
    registry: 'product',
    scenarios: ['S02-a53-8-720', 'fc-8-3p5'],
    tests: [{ file: 'tests/w3-worker.test.js', testName: 'W5 prefixStack + W8 scanSmooth decode' }],
    planned: 'S03-S05/S18',
    reason: 'Exercised by SimGate W-fc and W-all worker flag sets.',
  },
  roiSmallCodes: {
    registry: 'product',
    scenarios: ['S02-a53-8-720', 'fc-8-3p5'],
    tests: [{ file: 'tests/w3-worker.test.js', testName: 'W9 roiSmallCodes finds small' }],
    planned: 'S03-S05/S18',
    reason: 'Exercised by SimGate W-all worker flag set.',
  },
  verticalMode: {
    registry: 'product',
    scenarios: ['S02-a53-8-720', 'fc-8-3p5'],
    tests: [{ file: 'tests/w2-decoder.test.js', testName: 'W10 verticalMode fast-path decodes' }],
    planned: 'S03-S05/S13/S18',
    reason: 'Exercised by SimGate W-all worker flag set.',
  },
  deblur1d: {
    registry: 'product',
    scenarios: ['S02-a53-8-720', 'fc-12-3p5-auto'],
    tests: [{ file: 'tests/w3-worker.test.js', testName: 'W12 deblurScanlineLuma boosts blurred bar contrast' }],
    planned: 'S04/S18',
    reason: 'Exercised by SimGate W-all worker flag set (including blurred fc-12-3p5-auto).',
  },
  flowOn: {
    registry: 'product',
    scenarios: ['S02-a53-8-720', 'fc-8-3p5'],
    tests: [
      { file: 'tests/flow.test.js', testName: 'W13 recovers synthetic sub-pixel translations' },
      { file: 'tests/w3-worker.test.js', testName: 'W13 flowOn runs cleanly inside processFrameMulti' },
    ],
    planned: 'S07/S18',
    reason: 'Exercised by SimGate W-all worker flag set and dedicated optical-flow unit suite.',
  },
  stopGuard: {
    registry: 'product',
    scenarios: ['S02-a53-8-720', 'fc-tele-30-3p5'],
    tests: [
      { file: 'tests/fp-oblique-tail.test.js', testName: 'F1 stopGuard eliminates oblique-tail false read tsX41A00013!' },
    ],
    planned: 'S11/S18',
    reason: 'Exercised by SimGate W-fc, strict, and W-all worker flag sets plus F1 oblique-tail regression test.',
  },
  decodeAnchor: {
    registry: 'product',
    scenarios: [],
    tests: [
      { file: 'tests/decode-anchor.test.js', testName: 'R8 truth: decodeAnchor cuts the worst centre error from ~25% to <= 3.5% of label length in every case' },
      { file: 'tests/decode-anchor-default-path.test.js', testName: 'decodeAnchor: every crop centre within 12 px and span length within 3% of the true bars' },
    ],
    planned: 'B8/B8p2',
    reason: 'Only changes reported label geometry (centre/ROI/overlay line), never decodes, so decode-count SimGate scenarios cannot score it; scored against R8 overlay ground truth (also enabled by SimGate W-all).',
  },

  // Stream C — Camera / Capture (MediaStreamTrack APIs outside headless worker)
  camProfiles: {
    registry: 'product',
    scenarios: [],
    tests: [{ file: 'tests/capture-ui.test.js', testName: 'C2 setZoom clamps/steps' }],
    planned: 'K8',
    reason: 'Browser MediaStreamTrack camera profile/zoom constraints; verified by capture-ui (and K8 mock track).',
  },
  focusCtl: {
    registry: 'product',
    scenarios: [],
    tests: [{ file: 'tests/capture-ui.test.js', testName: 'C3 pickBackCameras puts camera 0' }],
    planned: 'K8',
    reason: 'Browser MediaStreamTrack focus/lens controls; verified by capture-ui (and K8 mock track).',
  },
  fastShutter: {
    registry: 'product',
    scenarios: [],
    tests: [{ file: 'tests/exposure.test.js', testName: 'setExposure uses two-step applyConstraints' }],
    planned: 'K2/K9',
    reason: 'Browser MediaStreamTrack manual exposure setter; verified by exposure unit tests (K2/K9 adds low-light locked profile).',
  },
  lock30fps: {
    registry: 'product',
    scenarios: [],
    tests: [
      { file: 'tests/exposure.test.js', testName: 'setExposure uses two-step applyConstraints' },
      { file: 'tests/flags.test.js' },
    ],
    planned: 'K2/K9/K8',
    reason: 'PP2 MediaStreamTrack min-30fps + locked shutter/ISO request; verified via exposure/flags tests (K8 mock & K9 lowlight-locked).',
  },
  cropAtSource: {
    registry: 'product',
    scenarios: [],
    tests: [{ file: 'tests/capture-ui.test.js', testName: 'C5 computeEvenCropRect produces even/4-aligned' }],
    planned: 'S14/R8',
    reason: 'WebCodecs VideoFrame copyTo rect crop math; verified by capture-ui (S14/R8 adds gate crop scenario).',
  },
  lensProbe: {
    registry: 'product',
    scenarios: [],
    tests: [{ file: 'tests/capture-ui.test.js', testName: 'C6 selectStandbackLens reports no tele on A53' }],
    planned: 'K8',
    reason: 'Browser MediaDevices rear-lens capability probe; verified by capture-ui (and K8 mock track).',
  },
  predictCrop: {
    registry: 'product',
    scenarios: [],
    tests: [
      { file: 'tests/capture-ui.test.js', testName: 'C7 computePredictedLabelCrop builds even-aligned 4K crop' },
      { file: 'tests/panmodel.test.js', testName: 'A9 allocCleanup reuses footprint & snapshot buffers' },
    ],
    planned: 'S14',
    reason: '4K lattice-node predicted crop math; verified by capture-ui and panmodel tests (S14 adds tele-30 4K crop scenario).',
  },

  // Stream U — Main-Page UI / HUD
  hudStats: {
    registry: 'product',
    scenarios: [],
    tests: [{ file: 'tests/flags.test.js' }],
    planned: 'R9',
    reason: 'DOM-only HUD telemetry formatting on index.html; cannot run headless without browser DOM.',
  },
  overlayDim: {
    registry: 'product',
    scenarios: [],
    tests: [{ file: 'tests/flags.test.js' }],
    planned: 'R9',
    reason: 'DOM-only overlay opacity/auto-fade controller on index.html.',
  },
  tallGuide: {
    registry: 'product',
    scenarios: [],
    tests: [{ file: 'tests/capture-ui.test.js', testName: 'C5 computeEvenCropRect produces even/4-aligned' }],
    planned: 'R8',
    reason: 'Framing guide aspect ratio on index.html; R8 overlay-truth adds projected guide alignment check.',
  },
  pauseCtl: {
    registry: 'product',
    scenarios: [],
    tests: [{ file: 'tests/capture-ui.test.js', testName: 'U4 pauseCtl pauses on manual hold' }],
    planned: 'R9',
    reason: 'Touch hold-to-pause and face-down gravity pause state machine; verified by capture-ui logic test.',
  },

  // Stream A — Array Logic (exercised by array/panmodel/wallmap unit tests today; R7 adds sim-in-the-loop S07/S12)
  fcLabelDefaults: {
    registry: 'product',
    scenarios: [],
    tests: [{ file: 'tests/array.test.js', testName: 'A1 fcLabelDefaults and toteOrientation config' }],
    planned: 'R7/S03-S12',
    reason: 'Array FC 2x3.5 in profile & optics config; verified in array.test.js until R7 array-loop lands.',
  },
  conflictHysteresis: {
    registry: 'product',
    scenarios: [],
    tests: [{ file: 'tests/array.test.js', testName: 'A2 conflictHysteresis ignores single stray misread' }],
    planned: 'R7/S07',
    reason: 'Array cell voting hysteresis; verified in array.test.js until R7 array-loop lands.',
  },
  dupCheck: {
    registry: 'product',
    scenarios: [],
    tests: [{ file: 'tests/array.test.js', testName: 'A3 dupCheck flags cross-cell duplicate payloads' }],
    planned: 'R7/S07',
    reason: 'Cross-cell duplicate payload detector; verified in array.test.js until R7 array-loop lands.',
  },
  nudgeDamp: {
    registry: 'product',
    scenarios: [],
    tests: [{ file: 'tests/array.test.js', testName: 'A3 dupCheck flags cross-cell duplicate payloads' }],
    planned: 'R7/S07',
    reason: 'Damped stance-nudge gain/rate cap; verified in array.test.js until R7 array-loop lands.',
  },
  driftFromLabel: {
    registry: 'product',
    scenarios: [],
    tests: [{ file: 'tests/array.test.js', testName: 'A3 dupCheck flags cross-cell duplicate payloads' }],
    planned: 'R7/S07',
    reason: 'Pixel-ray stance drift anchor; verified in array.test.js until R7 array-loop lands.',
  },
  autoZeroFromLabel: {
    registry: 'product',
    scenarios: [],
    tests: [{ file: 'tests/array.test.js', testName: 'A6 autoZeroFromLabel accepts 2 centred square reads' }],
    planned: 'R7/S12',
    reason: 'Auto-zero state machine from centred label; verified in array.test.js until R7 S12 lands.',
  },
  orientGravityZero: {
    registry: 'product',
    scenarios: [],
    tests: [{ file: 'tests/array.test.js', testName: 'A7 orientGravityZero preserves absolute gravity pitch/roll' }],
    planned: 'R7/S12',
    reason: 'Gravity-levelled pitch/roll yaw-only zero; verified in array.test.js until R7 S12 lands.',
  },
  axisRemapAuto: {
    registry: 'product',
    scenarios: [],
    tests: [{ file: 'tests/array.test.js', testName: 'A7 solveAxisRemap recovers every one of the 8 D4 axis' }],
    planned: 'R7/S12',
    reason: '8-way D4 axis remap solver; verified in array.test.js until R7 S12 lands.',
  },
  panKalman: {
    registry: 'product',
    scenarios: [],
    tests: [{ file: 'tests/panmodel.test.js', testName: 'A8 solveTwoReadFocalAndDistance recovers f and D' }],
    planned: 'R7/S07',
    reason: '2-read Gauss-Newton f/D solver & 3-state Kalman filter; verified in panmodel.test.js (200-run MC) until R7 lands.',
  },
  allocCleanup: {
    registry: 'product',
    scenarios: [],
    tests: [{ file: 'tests/panmodel.test.js', testName: 'A9 allocCleanup reuses footprint & snapshot buffers' }],
    planned: 'R7',
    reason: 'Zero-allocation scratch view reuse on array UI path; verified by panmodel.test.js.',
  },
  slideMap: {
    registry: 'product',
    scenarios: [],
    tests: [{ file: 'tests/wallmap.test.js', testName: 'A10 Monte-Carlo (200 runs at 12 in/s)' }],
    planned: 'R7/S07',
    reason: 'Close-range slide wall mapper; verified in wallmap.test.js (200-run MC) until R7 S07 lands.',
  },

  // Stream B — Array Page UI
  blurGateV2: {
    registry: 'product',
    scenarios: [],
    tests: [{ file: 'tests/array.test.js', testName: 'B1 computeBlurModules gates vertical pitch' }],
    planned: 'R7/S06',
    reason: 'Scan-angle-aware blur modules gate; verified by array.test.js until R7 S06 vs S03 lands.',
  },
  camAlign: {
    registry: 'product',
    scenarios: [],
    tests: [{ file: 'tests/array.test.js', testName: 'B2 computeViewTransform maps 16:9 frame' }],
    planned: 'R8/S16',
    reason: 'Aspect-matched contain transform for array HUD; verified by array.test.js until R8/S16 lands.',
  },
  overlayAlign: {
    registry: 'product',
    scenarios: [],
    tests: [{ file: 'tests/overlay-align.test.js', testName: 'overlayAlign feature flag exists and defaults to false' }],
    planned: 'R8/S16',
    reason: 'Unified DPR mapFrameToScreen overlay alignment; verified by overlay-align.test.js until R8/S16 lands.',
  },
  arrayDim: {
    registry: 'product',
    scenarios: [],
    tests: [{ file: 'tests/flags.test.js' }],
    planned: 'R9',
    reason: 'Page-only overlay dim toggle on array.html; no headless worker impact.',
  },
  arrayFullBleed: {
    registry: 'product',
    scenarios: [],
    tests: [{ file: 'tests/flags.test.js' }],
    planned: 'R9',
    reason: 'Page-only full-bleed camera + PiP CSS layout on array.html.',
  },
  orientPreflight: {
    registry: 'product',
    scenarios: [],
    tests: [{ file: 'tests/array.test.js', testName: 'A7 orientGravityZero preserves absolute gravity pitch/roll' }],
    planned: 'R7/S12',
    reason: 'Hold-attitude preflight banner on array.html; attitude logic in array.test.js, UI checked in R9/Labs.',
  },
  orientLock: {
    registry: 'product',
    scenarios: [],
    tests: [{ file: 'tests/flags.test.js' }],
    planned: 'R7/S12/R9',
    reason: 'Browser ScreenOrientation.lock() API; unavailable in Node headless gate.',
  },
  rowGuide: {
    registry: 'product',
    scenarios: [],
    tests: [{ file: 'tests/flags.test.js' }],
    planned: 'R9',
    reason: 'Page-only sideways row-sweep visual guide on array.html.',
  },
});

export const SIM_FLAG_COVERAGE = Object.freeze({
  simFcLabel: {
    registry: 'sim',
    scenarios: [],
    tests: [{ file: 'tests/simflags.test.js', testName: 'All declared sim and AR flags default to false' }],
    planned: 'L2',
    reason: 'Wave 2 item L2 (FC 2x3.5 in 11-char tsX default); registry tested in simflags.test.js.',
  },
  simLips: {
    registry: 'sim',
    scenarios: [],
    tests: [{ file: 'tests/simflags.test.js', testName: 'All declared sim and AR flags default to false' }],
    planned: 'L4/S09',
    reason: 'Wave 2 item L4 (tote lips and interlock parallax occlusion); registry tested in simflags.test.js.',
  },
  simPhotoWall: {
    registry: 'sim',
    scenarios: [],
    tests: [{ file: 'tests/simflags.test.js', testName: 'All declared sim and AR flags default to false' }],
    planned: 'L5/S10',
    reason: 'Wave 3 item L5 (photo-textured tote walls); registry tested in simflags.test.js.',
  },
  simDefects: {
    registry: 'sim',
    scenarios: [],
    tests: [{ file: 'tests/simflags.test.js', testName: 'All declared sim and AR flags default to false' }],
    planned: 'L7',
    reason: 'Wave 2 item L7 (label tilt, offset, print gain, scuffs); registry tested in simflags.test.js.',
  },
  simCamera: {
    registry: 'sim',
    scenarios: [],
    tests: [{ file: 'tests/simflags.test.js', testName: 'All declared sim and AR flags default to false' }],
    planned: 'K1-K3/K9',
    reason: 'Wave 2 items K1-K3 (camera scheduler, AE/ISO, noise/tone); registry tested in simflags.test.js.',
  },
  simRolling: {
    registry: 'sim',
    scenarios: [],
    tests: [{ file: 'tests/simflags.test.js', testName: 'All declared sim and AR flags default to false' }],
    planned: 'K4',
    reason: 'Wave 2 item K4 (rolling shutter band pose interpolation); registry tested in simflags.test.js.',
  },
  simOptics: {
    registry: 'sim',
    scenarios: [],
    tests: [{ file: 'tests/simflags.test.js', testName: 'All declared sim and AR flags default to false' }],
    planned: 'K5',
    reason: 'Wave 2 item K5 (defocus/AF lag, vignette, distortion, sharpening); registry tested in simflags.test.js.',
  },
  simCompress: {
    registry: 'sim',
    scenarios: [],
    tests: [{ file: 'tests/simflags.test.js', testName: 'All declared sim and AR flags default to false' }],
    planned: 'K6',
    reason: 'Wave 2 item K6 (8x8 DCT quantization compression); registry tested in simflags.test.js.',
  },
  simGlare: {
    registry: 'sim',
    scenarios: [],
    tests: [{ file: 'tests/simflags.test.js', testName: 'All declared sim and AR flags default to false' }],
    planned: 'K7/S08',
    reason: 'Wave 2 item K7 (moving specular glare & torch hotspot); registry tested in simflags.test.js.',
  },
  simTapePose: {
    registry: 'sim',
    scenarios: [],
    tests: [{ file: 'tests/simflags.test.js', testName: 'All declared sim and AR flags default to false' }],
    planned: 'T1',
    reason: 'Wave 2 item T1 (tape-driven gyro pose replay); registry tested in simflags.test.js.',
  },
  simMeasuredMotion: {
    registry: 'sim',
    scenarios: [],
    tests: [{ file: 'tests/simflags.test.js', testName: 'All declared sim and AR flags default to false' }],
    planned: 'T3',
    reason: 'Wave 2 item T3 (tape-fitted AR(2) motion statistics); registry tested in simflags.test.js.',
  },
  arWall: {
    registry: 'sim',
    scenarios: [],
    tests: [{ file: 'tests/simflags.test.js', testName: 'All declared sim and AR flags default to false' }],
    planned: 'M4/M7/S17',
    reason: 'AR wall mode tracker & live page (M7a raw capture in Wave 1, M4/M7b/S17 in Waves 2-3).',
  },
  arCompose: {
    registry: 'sim',
    scenarios: [],
    tests: [{ file: 'tests/simflags.test.js', testName: 'All declared sim and AR flags default to false' }],
    planned: 'M5/M6/S17',
    reason: 'Wave 2-3 items M5/M6 (AR photometry & label compositor); registry tested in simflags.test.js.',
  },
  arGyroPrior: {
    registry: 'sim',
    scenarios: [],
    tests: [{ file: 'tests/simflags.test.js', testName: 'All declared sim and AR flags default to false' }],
    planned: 'M3/M4',
    reason: 'Wave 2 items M3/M4 (gyro pre-rotation prior for AR dot tracking); registry tested in simflags.test.js.',
  },
  arRecordRaw: {
    registry: 'sim',
    scenarios: [],
    tests: [{ file: 'tests/simflags.test.js', testName: 'All declared sim and AR flags default to false' }],
    planned: 'M8/S17',
    reason: 'AR raw frame + metadata tape recording (M7a minimal / M8 Wave 3); registry tested in simflags.test.js.',
  },
  arShowDots: {
    registry: 'sim',
    scenarios: [],
    tests: [{ file: 'tests/simflags.test.js', testName: 'All declared sim and AR flags default to false' }],
    planned: 'M7',
    reason: 'Page-only AR dot/landmark debug overlay in ar.html; registry tested in simflags.test.js.',
  },
});

export const FLAG_COVERAGE_MAP = Object.freeze({
  ...PRODUCT_FLAG_COVERAGE,
  ...SIM_FLAG_COVERAGE,
});

/**
 * Validates that every product and sim/AR flag is mapped, no orphan entries remain,
 * every mapped scenario ID exists (and enables the flag), and every mapped test file/name exists.
 *
 * @param {{
 *   rootDir: string,
 *   productFlags?: readonly { name: string }[],
 *   simFlags?: readonly { name: string }[],
 *   coverageMap?: Record<string, object>,
 *   scenarios?: readonly object[],
 * }} opts
 * @returns {{ ok: boolean, errors: string[], stats: { productCount: number, simCount: number, scenarioCovered: number, testCovered: number } }}
 */
export function validateFlagCoverage(opts) {
  const rootDir = opts.rootDir;
  const productFlags = opts.productFlags || FLAG_DEFS;
  const simFlags = opts.simFlags || SIM_FLAG_DEFS;
  const coverageMap = opts.coverageMap || FLAG_COVERAGE_MAP;
  const scenarios = opts.scenarios || buildWave1Scenarios();

  const scenarioById = new Map(scenarios.map((s) => [s.id, s]));
  const fileCache = new Map();
  const readTestFile = (relPath) => {
    if (fileCache.has(relPath)) return fileCache.get(relPath);
    const full = join(rootDir, relPath);
    const content = existsSync(full) ? readFileSync(full, 'utf8') : null;
    fileCache.set(relPath, content);
    return content;
  };

  const errors = [];
  const declaredNames = new Set();
  let scenarioCovered = 0;
  let testCovered = 0;

  const checkRegistry = (defs, registryName) => {
    for (const def of defs) {
      declaredNames.add(def.name);
      const entry = coverageMap[def.name];
      if (!entry) {
        errors.push(`Unmapped ${registryName} flag: "${def.name}" has no entry in tools/gate/coverage-map.mjs`);
        continue;
      }
      if (entry.registry !== registryName) {
        errors.push(`Flag "${def.name}" mapped with registry="${entry.registry}" (expected "${registryName}")`);
      }

      const mappedScenarios = Array.isArray(entry.scenarios) ? entry.scenarios : [];
      const mappedTests = Array.isArray(entry.tests) ? entry.tests : [];
      if (mappedScenarios.length === 0 && mappedTests.length === 0 && !entry.planned) {
        errors.push(`Flag "${def.name}" has neither a scenario, an existing test, nor a planned item ID`);
      }
      if (typeof entry.reason !== 'string' || entry.reason.trim().length < 8) {
        errors.push(`Flag "${def.name}" must include a descriptive one-line reason`);
      }

      if (mappedScenarios.length > 0) scenarioCovered++;
      if (mappedTests.length > 0) testCovered++;

      for (const scId of mappedScenarios) {
        const sc = scenarioById.get(scId);
        if (!sc) {
          errors.push(`Flag "${def.name}" references vanished/unknown scenario "${scId}"`);
          continue;
        }
        // Verify at least one of the scenario's flagSets enables this flag
        const enablesFlag = (sc.flagSets || [sc.flags?.id]).some((fsId) => {
          const resolved = resolveFlagSet(fsId);
          return resolved.worker.includes(def.name) || resolved.page.includes(def.name);
        });
        if (!enablesFlag) {
          errors.push(`Flag "${def.name}" is mapped to scenario "${scId}" whose flagSets [${(sc.flagSets || []).join(',')}] do not enable it`);
        }
      }

      for (const t of mappedTests) {
        if (!t || typeof t.file !== 'string') {
          errors.push(`Flag "${def.name}" has invalid test mapping entry`);
          continue;
        }
        const src = readTestFile(t.file);
        if (src === null) {
          errors.push(`Flag "${def.name}" references vanished test file "${t.file}"`);
          continue;
        }
        if (t.testName && !src.includes(t.testName)) {
          errors.push(`Flag "${def.name}" references missing test name "${t.testName}" in "${t.file}"`);
        }
      }
    }
  };

  checkRegistry(productFlags, 'product');
  checkRegistry(simFlags, 'sim');

  // Check for orphan entries in coverageMap no longer present in registries
  for (const mappedName of Object.keys(coverageMap)) {
    if (!declaredNames.has(mappedName)) {
      errors.push(`Orphan entry "${mappedName}" in coverage-map.mjs is not declared in FLAG_DEFS or SIM_FLAG_DEFS`);
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    stats: {
      productCount: productFlags.length,
      simCount: simFlags.length,
      scenarioCovered,
      testCovered,
    },
  };
}
