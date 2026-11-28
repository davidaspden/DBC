/**
 * GR1 — Central Feature-Flag Registry & Worker Bitmask Plumbing.
 *
 * Resolution priority: defaults (all false) < localStorage['dbc.flags'] < URL ?flags=...
 * Supports:
 *  - ?flags=overlayDim,tallGuide     (enable named flags)
 *  - ?flags=all                      (enable all non-exclusive flags for QA; excludes requirePrefixStrict)
 *  - ?flags=allStrict                (enable every flag including exclusive gates like requirePrefixStrict)
 *  - ?flags=none                     (force all flags off, overriding localStorage)
 *  - ?flags=-flagName                (explicitly disable a flag enabled in localStorage)
 *
 * Worker-side flags map to 32-bit integer bitmasks (`WORKER_FLAG_BITS`) so the worker
 * hot loop checks `(state.flags & BIT) !== 0` with strictly zero allocations.
 */

import { WORKER_FLAG_BITS } from './worker/flagbits.js';
export { WORKER_FLAG_BITS };

export const STORAGE_KEY = 'dbc.flags';

export const FLAG_DEFS = Object.freeze([
  // Platform
  { name: 'tapeRecord',          bit: null,                                  default: false, item: 'GR3',  desc: 'Record raw Y-plane + sensor tapes (.dbct) for Node replay' },

  // Stream W — Worker / Decoder
  { name: 'vertFallback',        bit: WORKER_FLAG_BITS.vertFallback,         default: false, item: 'W1',   desc: 'Full-width vertical fallback scanlines (S3)' },
  { name: 'extraLines',          bit: WORKER_FLAG_BITS.extraLines,           default: false, item: 'W2',   desc: 'Use 13 scanlines instead of 11 on ROI path' },
  { name: 'cribMatch',           bit: WORKER_FLAG_BITS.cribMatch,            default: false, item: 'W3',   desc: 'Match tsX Code 128B prefix crib for scale and alignment' },
  { name: 'requirePrefix',       bit: WORKER_FLAG_BITS.requirePrefix,        default: false, item: 'W4',   desc: 'Prefix bonus with mandatory plain-decode fallback' },
  { name: 'requirePrefixStrict', bit: WORKER_FLAG_BITS.requirePrefixStrict,  default: false, exclusive: true, item: 'W4',   desc: 'Strict tsX prefix gate (FC array page only)' },
  { name: 'prefixStack',         bit: WORKER_FLAG_BITS.prefixStack,          default: false, item: 'W5',   desc: 'Prefix-aligned scanline profile stacking' },
  { name: 'illumNorm',           bit: WORKER_FLAG_BITS.illumNorm,            default: false, item: 'W6',   desc: 'Per-scanline running-mean illumination normalisation' },
  { name: 'subpixEdges',         bit: WORKER_FLAG_BITS.subpixEdges,          default: false, item: 'W7',   desc: 'Sub-pixel mid-crossing edge default at low px/module' },
  { name: 'scanSmooth',          bit: WORKER_FLAG_BITS.scanSmooth,           default: false, item: 'W8',   desc: '1D smoothing along bars and light sharpening across' },
  { name: 'roiSmallCodes',       bit: WORKER_FLAG_BITS.roiSmallCodes,        default: false, item: 'W9',   desc: 'Adaptive 2x ROI pass for small/far barcodes (S5)' },
  { name: 'verticalMode',        bit: WORKER_FLAG_BITS.verticalMode,         default: false, item: 'W10',  desc: 'Fast vertical scanline pass before ROI (S4 worker)' },
  { name: 'deblur1d',            bit: WORKER_FLAG_BITS.deblur1d,             default: false, item: 'W12',  desc: 'Optional 1D along-scan deblur kernel' },
  { name: 'flowOn',              bit: WORKER_FLAG_BITS.flowOn,               default: false, item: 'W13',  desc: 'Downsampled block-matching optical flow stage' },
  { name: 'decodeAnchor',        bit: WORKER_FLAG_BITS.decodeAnchor,         default: false, item: 'B8',   desc: 'Anchor reported label centre/overlay to the decoded start-stop span on the winning scanlines (fixes ROI-centre offset along the scan axis)' },
  { name: 'stopGuard',           bit: WORKER_FLAG_BITS.stopGuard,            default: false, item: 'F1',   desc: 'Stop width, trailing quiet-zone, span and tail-quality guard against oblique-tail false Code 128 decodes' },
  { name: 'moduleEst',           bit: WORKER_FLAG_BITS.moduleEst,            default: false, item: 'BL1',  desc: 'Crib-first / autocorrelation module-width estimation & derived-range early reject' },
  { name: 'blurEdges',           bit: WORKER_FLAG_BITS.blurEdges,            default: false, item: 'BL2',  desc: 'Fallback blur-resilient 2nd-derivative / LoG edge fusion in Q8' },
  { name: 'matchFilter',         bit: WORKER_FLAG_BITS.matchFilter,          default: false, item: 'BL3',  desc: 'Pre-allocated Start B / Stop / tsX matched filter extending cribMatch & stopGuard' },
  { name: 'roiMultiscale',       bit: WORKER_FLAG_BITS.roiMultiscale,        default: false, item: 'BL4',  desc: 'Energy-scored & conditional coarse multi-scale RoI Structure Tensor pass' },
  { name: 'softDecode',          bit: WORKER_FLAG_BITS.softDecode,           default: false, item: 'BL5',  desc: 'Guarded fixed-point Viterbi/DP soft run decoder (requires stopGuard)' },

  // Stream C — Camera / Capture
  { name: 'camProfiles',         bit: null,                                  default: false, item: 'C2',   desc: 'Named camera profiles (far/wall), zoom & 4K presets (S1)' },
  { name: 'focusCtl',            bit: null,                                  default: false, item: 'C3',   desc: 'Tap-to-focus, lens menu & close-focus helper (S2)' },
  { name: 'fastShutter',         bit: null,                                  default: false, item: 'C4',   desc: 'Manual 1/500s exposure setter & exposure HUD readout (S6)' },
  { name: 'lock30fps',           bit: null,                                  default: false, item: 'PP2',  desc: 'Request frameRate min 30 & lock fast shutter + compensated ISO when supported' },
  { name: 'cropAtSource',        bit: null,                                  default: false, item: 'C5',   desc: 'VideoFrame copyTo rect crop to framing guide (S4 main)' },
  { name: 'lensProbe',           bit: null,                                  default: false, item: 'C6',   desc: 'Rear lens capability probe & standback profile (Q0)' },
  { name: 'predictCrop',         bit: null,                                  default: false, item: 'C7',   desc: 'Predicted lattice-node crop from 4K frames (Q4)' },

  // Stream U — Main-Page UI / HUD
  { name: 'hudStats',            bit: null,                                  default: false, item: 'U1',   desc: 'Telemetry p95, time-to-lock, ppm, zoom & exposure HUD (S0)' },
  { name: 'overlayDim',          bit: null,                                  default: false, item: 'U2',   desc: 'Dimmable Normal/Dim/Min overlay & auto-fade on index.html' },
  { name: 'tallGuide',           bit: null,                                  default: false, item: 'U3',   desc: 'Tall 1:1.75 centered framing guide on index.html (S4 UI)' },
  { name: 'pauseCtl',            bit: null,                                  default: false, item: 'U4',   desc: 'Hold-to-pause & face-down gravity pause' },

  // Stream A — Array Logic
  { name: 'fcLabelDefaults',     bit: null,                                  default: false, item: 'A1',   desc: 'FC 2x3.5 in label, optics PPM check & tote orientation config' },
  { name: 'conflictHysteresis',  bit: null,                                  default: false, item: 'A2',   desc: 'Voting hysteresis & decay before flagging CONFLICT' },
  { name: 'dupCheck',            bit: null,                                  default: false, item: 'A3',   desc: 'Cross-cell duplicate payload detection' },
  { name: 'nudgeDamp',           bit: null,                                  default: false, item: 'A4',   desc: 'Damped stance-nudge gain with rate cap' },
  { name: 'driftFromLabel',      bit: null,                                  default: false, item: 'A5',   desc: 'Anchor stance from decoded label pixel ray' },
  { name: 'autoZeroFromLabel',   bit: null,                                  default: false, item: 'A6',   desc: 'Auto-zero array from first square centred label' },
  { name: 'orientGravityZero',   bit: null,                                  default: false, item: 'A7',   desc: 'Gravity-levelled pitch/roll with yaw-only zero & device frame' },
  { name: 'axisRemapAuto',       bit: null,                                  default: false, item: 'A7',   desc: 'Automatic 8-way camera-to-sensor axis remap solver' },
  { name: 'panKalman',           bit: null,                                  default: false, item: 'A8',   desc: '2-read f/D Gauss-Newton solve & 3-state Kalman residual filter' },
  { name: 'allocCleanup',        bit: null,                                  default: false, item: 'A9',   desc: 'Zero-allocation scratch views on array UI path' },
  { name: 'slideMap',            bit: null,                                  default: false, item: 'A10',  desc: 'Close-range slide wall mapper (Part 2)' },

  // Stream B — Array Page UI
  { name: 'blurGateV2',          bit: null,                                  default: false, item: 'B1',   desc: 'Scan-angle-aware blur gate with real/assumed exposure & 3.5 in constants' },
  { name: 'camAlign',            bit: null,                                  default: false, item: 'B2',   desc: 'Exact aspect-matched contain transform for array camera HUD boxes' },
  { name: 'overlayAlign',        bit: null,                                  default: false, item: 'B2/U3',desc: 'Unified mapFrameToScreen(x,y) DPR-sized overlay alignment for live camera & uploaded images' },
  { name: 'arrayDim',            bit: null,                                  default: false, item: 'B3',   desc: 'Dimmable overlay modes on array.html' },
  { name: 'arrayFullBleed',      bit: null,                                  default: false, item: 'B3',   desc: 'Full-bleed camera with 120px picture-in-picture array inset' },
  { name: 'orientPreflight',     bit: null,                                  default: false, item: 'B4',   desc: 'Hold-attitude preflight banner & mis-zero recovery UI' },
  { name: 'orientLock',          bit: null,                                  default: false, item: 'B4',   desc: 'Best-effort fullscreen portrait orientation lock on Start' },
  { name: 'rowGuide',            bit: null,                                  default: false, item: 'B5',   desc: 'Sideways row-sweep arrow & fast-shutter button on array.html' },
]);

const FLAG_MAP = new Map(FLAG_DEFS.map((f) => [f.name, f]));

/**
 * Resolves flag values from defaults < storedObj < searchStr.
 * Pure function suitable for both browser and Node unit tests.
 *
 * @param {{ search?: string, stored?: Record<string, boolean> | null }} [opts]
 * @returns {Record<string, boolean>}
 */
export function resolveFlags(opts = {}) {
  const out = {};
  for (let i = 0; i < FLAG_DEFS.length; i++) {
    out[FLAG_DEFS[i].name] = Boolean(FLAG_DEFS[i].default);
  }

  // 1. Apply persisted localStorage values
  const stored = opts.stored;
  if (stored && typeof stored === 'object') {
    for (const k of Object.keys(stored)) {
      if (FLAG_MAP.has(k)) {
        out[k] = Boolean(stored[k]);
      }
    }
  }

  // 2. Apply URL query string (?flags=a,b or ?flags=all or ?flags=none or ?tape=1)
  const search = typeof opts.search === 'string' ? opts.search : '';
  if (search) {
    const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
    if (params.get('tape') === '1') {
      out.tapeRecord = true;
    }
    const raw = params.get('flags');
    if (raw !== null) {
      const tokens = raw.split(',').map((s) => s.trim()).filter(Boolean);
      for (const tok of tokens) {
        if (tok === 'all') {
          for (let i = 0; i < FLAG_DEFS.length; i++) {
            if (!FLAG_DEFS[i].exclusive) out[FLAG_DEFS[i].name] = true;
          }
        } else if (tok === 'allStrict') {
          for (let i = 0; i < FLAG_DEFS.length; i++) out[FLAG_DEFS[i].name] = true;
        } else if (tok === 'none') {
          for (let i = 0; i < FLAG_DEFS.length; i++) out[FLAG_DEFS[i].name] = false;
        } else if (tok.startsWith('-')) {
          const name = tok.slice(1);
          if (FLAG_MAP.has(name)) out[name] = false;
        } else if (FLAG_MAP.has(tok)) {
          out[tok] = true;
        }
      }
    }
  }

  return out;
}

/**
 * Converts a resolved flag object into a 32-bit integer bitmask for worker messages.
 * @param {Record<string, boolean>} resolved
 * @returns {number}
 */
export function flagsToWorkerMask(resolved) {
  let mask = 0;
  for (let i = 0; i < FLAG_DEFS.length; i++) {
    const def = FLAG_DEFS[i];
    if (def.bit !== null && resolved && resolved[def.name]) {
      mask |= def.bit;
    }
  }
  return mask | 0;
}

function readStoredBrowserFlags() {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

let activeFlags = resolveFlags({
  search: typeof location !== 'undefined' ? location.search : '',
  stored: readStoredBrowserFlags(),
});

export function refreshFlags() {
  activeFlags = resolveFlags({
    search: typeof location !== 'undefined' ? location.search : '',
    stored: readStoredBrowserFlags(),
  });
  return activeFlags;
}

export function isOn(name) {
  return Boolean(activeFlags[name]);
}

export function setFlag(name, value, persist = true) {
  if (!FLAG_MAP.has(name)) return false;
  activeFlags[name] = Boolean(value);
  if (persist && typeof localStorage !== 'undefined') {
    try {
      const stored = readStoredBrowserFlags() || {};
      stored[name] = Boolean(value);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
    } catch {}
  }
  return true;
}

export function toWorkerMask() {
  return flagsToWorkerMask(activeFlags);
}

export function describe() {
  return FLAG_DEFS.map((def) => ({
    name: def.name,
    item: def.item,
    enabled: Boolean(activeFlags[def.name]),
    default: def.default,
    exclusive: Boolean(def.exclusive),
    bit: def.bit,
    desc: def.desc,
  }));
}
