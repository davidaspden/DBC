/**
 * R1 — Sim & AR Wall Mode Feature-Flag Registry (`src/sim/simflags.js`).
 *
 * Resolution priority: defaults (all false) < localStorage['dbc.simflags'] < URL ?sim=...
 * Supports:
 *  - ?sim=simCamera,simGlare        (enable named sim/AR flags)
 *  - ?sim=all                       (enable every sim/AR flag)
 *  - ?sim=none                      (force all sim/AR flags off, overriding localStorage)
 *  - ?sim=-simGlare                 (explicitly disable a flag enabled in localStorage)
 *
 * Strictly separate from product flags (`src/flags.js`) and always defaults OFF.
 */

export const SIM_STORAGE_KEY = 'dbc.simflags';

export const SIM_FLAG_DEFS = Object.freeze([
  // Stream L — Labels, totes, walls
  { name: 'simFcLabel',        default: false, item: 'L2',     desc: 'Use FC 2x3.5 in ladder tsX 11-char labels (pattern tsX07wz7py1)' },
  { name: 'simLips',           default: false, item: 'L4',     desc: 'Model recessed tote panels, lips, shadow band & parallax occlusion' },
  { name: 'simPhotoWall',      default: false, item: 'L5',     desc: 'Texture tote wall faces from normalized real photo patches' },
  { name: 'simDefects',        default: false, item: 'L7',     desc: 'Seeded label tilt, offset, peel warp, thermal streaks & scuffs' },

  // Stream K — Camera pipeline realism
  { name: 'simCamera',         default: false, item: 'K1-K3',  desc: 'Camera frame scheduler, A53 auto-exposure/ISO, shot/read noise & tone curve' },
  { name: 'simRolling',        default: false, item: 'K4',     desc: 'Rolling shutter per-row band pose interpolation (20-30 ms readout)' },
  { name: 'simOptics',         default: false, item: 'K5',     desc: 'Defocus/AF hunting, radial vignette, barrel distortion & ISP sharpening' },
  { name: 'simCompress',       default: false, item: 'K6',     desc: '8x8 DCT JPEG-style quantization compression artifacts' },
  { name: 'simGlare',          default: false, item: 'K7',     desc: 'Moving specular glare & torch hotspot on matte/semi-gloss labels' },

  // Stream T — Tape-driven motion
  { name: 'simTapePose',       default: false, item: 'T1',     desc: 'Replay orientation/stance pose path integrated from a .dbct tape' },
  { name: 'simMeasuredMotion', default: false, item: 'T3',     desc: 'Replace synthetic jitter slider with tape-fitted AR(2) angular motion' },

  // Stream M — AR wall mode
  { name: 'arWall',            default: false, item: 'M4/M7',  desc: 'Enable AR dotted-wall marker tracker and ar.html workflow' },
  { name: 'arCompose',         default: false, item: 'M5/M6',  desc: 'Composite photometry-matched synthetic labels onto live AR frames' },
  { name: 'arGyroPrior',       default: false, item: 'M3/M4',  desc: 'Pre-rotate predicted AR dot positions using gyro delta between frames' },
  { name: 'arRecordRaw',       default: false, item: 'M8',     desc: 'Record raw uncomposited frames + tracker metadata into .dbct AR tapes' },
  { name: 'arShowDots',        default: false, item: 'M7',     desc: 'Draw detected dots, landmarks & homography reprojection overlay in ar.html' },
]);

const SIM_FLAG_MAP = new Map(SIM_FLAG_DEFS.map((f) => [f.name, f]));

/**
 * Resolves sim/AR flag values from defaults < storedObj < searchStr (`?sim=...`).
 * Pure function suitable for both browser and Node unit tests.
 *
 * @param {{ search?: string, stored?: Record<string, boolean> | null }} [opts]
 * @returns {Record<string, boolean>}
 */
export function resolveSimFlags(opts = {}) {
  const out = {};
  for (let i = 0; i < SIM_FLAG_DEFS.length; i++) {
    out[SIM_FLAG_DEFS[i].name] = Boolean(SIM_FLAG_DEFS[i].default);
  }

  const stored = opts.stored;
  if (stored && typeof stored === 'object') {
    for (const k of Object.keys(stored)) {
      if (SIM_FLAG_MAP.has(k)) {
        out[k] = Boolean(stored[k]);
      }
    }
  }

  const search = typeof opts.search === 'string' ? opts.search : '';
  if (search) {
    const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
    const raw = params.get('sim');
    if (raw !== null) {
      const tokens = raw.split(',').map((s) => s.trim()).filter(Boolean);
      for (const tok of tokens) {
        if (tok === 'all') {
          for (let i = 0; i < SIM_FLAG_DEFS.length; i++) out[SIM_FLAG_DEFS[i].name] = true;
        } else if (tok === 'none') {
          for (let i = 0; i < SIM_FLAG_DEFS.length; i++) out[SIM_FLAG_DEFS[i].name] = false;
        } else if (tok.startsWith('-')) {
          const name = tok.slice(1);
          if (SIM_FLAG_MAP.has(name)) out[name] = false;
        } else if (SIM_FLAG_MAP.has(tok)) {
          out[tok] = true;
        }
      }
    }
  }

  return out;
}

function readStoredBrowserSimFlags() {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(SIM_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

let activeSimFlags = resolveSimFlags({
  search: typeof location !== 'undefined' ? location.search : '',
  stored: readStoredBrowserSimFlags(),
});

export function refreshSimFlags() {
  activeSimFlags = resolveSimFlags({
    search: typeof location !== 'undefined' ? location.search : '',
    stored: readStoredBrowserSimFlags(),
  });
  return activeSimFlags;
}

export function isSimOn(name) {
  return Boolean(activeSimFlags[name]);
}

export function setSimFlag(name, value, persist = true) {
  if (!SIM_FLAG_MAP.has(name)) return false;
  activeSimFlags[name] = Boolean(value);
  if (persist && typeof localStorage !== 'undefined') {
    try {
      const stored = readStoredBrowserSimFlags() || {};
      stored[name] = Boolean(value);
      localStorage.setItem(SIM_STORAGE_KEY, JSON.stringify(stored));
    } catch {}
  }
  return true;
}

export function describeSimFlags() {
  return SIM_FLAG_DEFS.map((def) => ({
    name: def.name,
    item: def.item,
    enabled: Boolean(activeSimFlags[def.name]),
    default: def.default,
    desc: def.desc,
  }));
}
