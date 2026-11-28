/**
 * K8 — Mock MediaStreamTrack & getUserMedia Constraint Solver (A53 cc0f88 Capabilities).
 *
 * Pure Vanilla ES Module (zero dependencies, zero Math.random, runs in Node & browsers).
 * Driven by either the built-in Galaxy A53 5G (`cc0f88`) capability table or any
 * external diagnostics JSON report (e.g. `tests/fixtures-sim/diag-cc0f88.json`) or
 * custom camera capability object.
 *
 * Implements Chrome Android Camera2 constraint semantics:
 *  - Range clamping & step quantization (`zoom`, `focusDistance`, `exposureTime`, `iso`,
 *    `exposureCompensation`, `width`, `height`, `frameRate`)
 *  - `ideal` / `min` / `max` / `exact` validation (`OverconstrainedError` for impossible constraints)
 *  - `advanced` constraint sets (Chrome single-set rejection + W3C multi-set fallback)
 *  - `focusMode` & `exposureMode` enum validation, `torch` capability gating
 *  - Portrait resolution delivery for `ideal` 16:9 requests on portrait-locked Android phones
 *  - W3C Image Capture 100-microsecond units for `exposureTime` (0.42–1000 = 42 us – 100 ms)
 */

/**
 * Built-in Samsung Galaxy A53 5G (`SM-A536B`, diag report `cc0f88`) capability table.
 * Preserves Chrome's real enumeration order (`camera 2` listed BEFORE `camera 0`).
 */
export const A53_CC0F88_DIAG = Object.freeze({
  version: 1,
  reportId: 'cc0f88',
  device: 'Samsung Galaxy A53 5G (SM-A536B)',
  portrait: true,
  cameras: [
    {
      index: 0,
      label: 'camera 2, facing back',
      deviceId: 'a53-camera-2-rear-aux',
      groupId: 'a53-group-rear',
      idHash: 'c20000000002',
      groupHash: 'a53000000001',
      facing: 'environment',
      roleGuess: 'REAR-AUX?',
      portrait: true,
      capabilities: {
        width: { min: 160, max: 4000 },
        height: { min: 120, max: 3000 },
        frameRate: { min: 1, max: 30 },
        aspectRatio: { min: 0.053, max: 33.333 },
        facingMode: ['environment'],
        zoom: 'n/a',
        focusMode: ['manual'],
        focusDistance: { min: 0, max: 3.6, step: 0.01 },
        exposureMode: ['continuous'],
        exposureTime: 'n/a',
        exposureCompensation: { min: -2, max: 2, step: 0.1 },
        iso: 'n/a',
        torch: false,
        whiteBalanceMode: ['continuous'],
        pointsOfInterest: 'n/a',
      },
      settings: {
        width: 1080,
        height: 1920,
        frameRate: 30,
        facingMode: 'environment',
        focusMode: 'manual',
        focusDistance: 0,
        exposureMode: 'continuous',
        exposureCompensation: 0,
        whiteBalanceMode: 'continuous',
      },
      resolutions: {
        '720p': { ok: true, width: 720, height: 1280, frameRate: 30 },
        '1080p': { ok: true, width: 1080, height: 1920, frameRate: 30 },
        '4K': { ok: true, width: 2160, height: 3840, frameRate: 30 },
      },
    },
    {
      index: 1,
      label: 'camera 0, facing back',
      deviceId: 'a53-camera-0-rear-main',
      groupId: 'a53-group-rear',
      idHash: 'c00000000000',
      groupHash: 'a53000000001',
      facing: 'environment',
      roleGuess: 'MAIN?',
      portrait: true,
      capabilities: {
        width: { min: 160, max: 4624 },
        height: { min: 120, max: 3468 },
        frameRate: { min: 1, max: 30 },
        aspectRatio: { min: 0.046, max: 38.533 },
        facingMode: ['environment'],
        zoom: { min: 1, max: 8, step: 0.1 },
        focusMode: ['manual', 'single-shot', 'continuous'],
        focusDistance: { min: 0.1, max: 3.6, step: 0.01 },
        exposureMode: ['continuous', 'manual'],
        exposureTime: { min: 0.42, max: 1000, step: 0.1 },
        exposureCompensation: { min: -2, max: 2, step: 0.1 },
        iso: { min: 50, max: 3200, step: 1 },
        torch: true,
        whiteBalanceMode: ['continuous', 'manual'],
        pointsOfInterest: 'n/a',
      },
      settings: {
        width: 1080,
        height: 1920,
        frameRate: 30,
        facingMode: 'environment',
        zoom: 1,
        focusMode: 'continuous',
        focusDistance: 0.5,
        exposureMode: 'continuous',
        exposureTime: 333.3,
        exposureCompensation: 0,
        iso: 200,
        torch: false,
        whiteBalanceMode: 'continuous',
      },
      resolutions: {
        '720p': { ok: true, width: 720, height: 1280, frameRate: 30 },
        '1080p': { ok: true, width: 1080, height: 1920, frameRate: 30 },
        '4K': { ok: true, width: 2160, height: 3840, frameRate: 30 },
      },
    },
    {
      index: 2,
      label: 'camera 1, facing front',
      deviceId: 'a53-camera-1-front-main',
      groupId: 'a53-group-front',
      idHash: 'c10000000001',
      groupHash: 'a53000000002',
      facing: 'user',
      roleGuess: 'FRONT',
      portrait: true,
      capabilities: {
        width: { min: 160, max: 3264 },
        height: { min: 120, max: 2448 },
        frameRate: { min: 1, max: 30 },
        aspectRatio: { min: 0.065, max: 27.2 },
        facingMode: ['user'],
        zoom: 'n/a',
        focusMode: ['manual'],
        focusDistance: { min: 0, max: 3.6, step: 0.01 },
        exposureMode: ['continuous'],
        exposureTime: 'n/a',
        exposureCompensation: { min: -2, max: 2, step: 0.1 },
        iso: 'n/a',
        torch: false,
        whiteBalanceMode: ['continuous'],
        pointsOfInterest: 'n/a',
      },
      settings: {
        width: 720,
        height: 1280,
        frameRate: 30,
        facingMode: 'user',
        focusMode: 'manual',
        focusDistance: 0,
        exposureMode: 'continuous',
        exposureCompensation: 0,
        whiteBalanceMode: 'continuous',
      },
      resolutions: {
        '720p': { ok: true, width: 720, height: 1280, frameRate: 30 },
        '1080p': { ok: true, width: 1080, height: 1920, frameRate: 30 },
      },
    },
    {
      index: 3,
      label: 'camera 3, facing front',
      deviceId: 'a53-camera-3-front-aux',
      groupId: 'a53-group-front',
      idHash: 'c30000000003',
      groupHash: 'a53000000002',
      facing: 'user',
      roleGuess: 'FRONT',
      portrait: true,
      capabilities: {
        width: { min: 160, max: 2576 },
        height: { min: 120, max: 1932 },
        frameRate: { min: 1, max: 30 },
        aspectRatio: { min: 0.083, max: 21.467 },
        facingMode: ['user'],
        zoom: 'n/a',
        focusMode: ['manual'],
        focusDistance: 'n/a',
        exposureMode: ['continuous'],
        exposureTime: 'n/a',
        exposureCompensation: { min: -2, max: 2, step: 0.1 },
        iso: 'n/a',
        torch: false,
        whiteBalanceMode: ['continuous'],
        pointsOfInterest: 'n/a',
      },
      settings: {
        width: 720,
        height: 1280,
        frameRate: 30,
        facingMode: 'user',
        focusMode: 'manual',
        exposureMode: 'continuous',
        exposureCompensation: 0,
        whiteBalanceMode: 'continuous',
      },
      resolutions: {
        '720p': { ok: true, width: 720, height: 1280, frameRate: 30 },
      },
    },
  ],
});

const RANGE_KEYS = new Set([
  'width',
  'height',
  'frameRate',
  'aspectRatio',
  'zoom',
  'focusDistance',
  'exposureTime',
  'exposureCompensation',
  'iso',
]);

const IMAGE_CAPTURE_RANGE_KEYS = new Set([
  'zoom',
  'focusDistance',
  'exposureTime',
  'exposureCompensation',
  'iso',
]);

const ENUM_KEYS = new Set([
  'focusMode',
  'exposureMode',
  'whiteBalanceMode',
  'facingMode',
]);

const EPS = 1e-9;

export class MockOverconstrainedError extends Error {
  constructor(constraint, message) {
    super(message || `Constraint "${constraint}" cannot be satisfied`);
    this.name = 'OverconstrainedError';
    this.constraint = constraint || '';
  }
}

export class MockDOMError extends Error {
  constructor(name, message) {
    super(message || name);
    this.name = name;
  }
}

function deepClone(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(deepClone);
  const out = {};
  for (const k of Object.keys(obj)) {
    out[k] = deepClone(obj[k]);
  }
  return out;
}

function countDecimals(num) {
  if (typeof num !== 'number' || !Number.isFinite(num)) return 0;
  const s = String(num);
  if (s.includes('e-')) {
    const parts = s.split('e-');
    const frac = parts[0].includes('.') ? parts[0].split('.')[1].length : 0;
    return frac + Number(parts[1]);
  }
  const idx = s.indexOf('.');
  return idx >= 0 ? s.length - idx - 1 : 0;
}

function roundToDecimals(val, decimals) {
  const factor = Math.pow(10, Math.min(8, Math.max(0, decimals)));
  return Math.round(val * factor) / factor;
}

/**
 * Clamps and quantizes a numeric value to a capability `{ min, max, step }` range.
 */
export function clampToCapability(value, cap) {
  if (!cap || typeof cap !== 'object') return value;
  const min = typeof cap.min === 'number' ? cap.min : -Infinity;
  const max = typeof cap.max === 'number' ? cap.max : Infinity;
  const step = typeof cap.step === 'number' && cap.step > 0 ? cap.step : 0;

  let v = value;
  if (step > 0 && Number.isFinite(min)) {
    const n = Math.round((v - min) / step);
    v = min + n * step;
  }
  if (v < min) v = min;
  if (v > max) v = max;

  if (step > 0) {
    const dec = Math.max(countDecimals(min), countDecimals(step), countDecimals(max));
    v = roundToDecimals(v, dec);
    if (v < min) v = min;
    if (v > max) v = max;
  }
  return v;
}

function isRangeCap(cap) {
  return Boolean(cap && typeof cap === 'object' && !Array.isArray(cap) && (typeof cap.min === 'number' || typeof cap.max === 'number'));
}

function sanitizeCapabilities(rawCaps) {
  const clean = {};
  if (!rawCaps || typeof rawCaps !== 'object') return clean;
  for (const key of Object.keys(rawCaps)) {
    const val = rawCaps[key];
    if (val === undefined || val === null || val === 'n/a') continue;
    if (Array.isArray(val)) {
      clean[key] = val.slice();
    } else if (typeof val === 'object') {
      clean[key] = deepClone(val);
    } else {
      clean[key] = val;
    }
  }
  return clean;
}

function inferPortrait(cam, reportPortrait) {
  if (typeof cam.portrait === 'boolean') return cam.portrait;
  if (typeof reportPortrait === 'boolean') return reportPortrait;
  if (cam.settings && typeof cam.settings.width === 'number' && typeof cam.settings.height === 'number') {
    if (cam.settings.height > cam.settings.width) return true;
  }
  if (cam.resolutions && typeof cam.resolutions === 'object') {
    for (const k of Object.keys(cam.resolutions)) {
      const r = cam.resolutions[k];
      if (r && r.ok && typeof r.width === 'number' && typeof r.height === 'number' && r.height > r.width) {
        return true;
      }
    }
  }
  return false;
}

function inferFacing(cam, caps) {
  if (typeof cam.facing === 'string' && cam.facing && cam.facing !== 'unknown') return cam.facing;
  if (cam.settings && typeof cam.settings.facingMode === 'string' && cam.settings.facingMode !== 'n/a') {
    return cam.settings.facingMode;
  }
  if (caps && Array.isArray(caps.facingMode) && caps.facingMode.length > 0) {
    return caps.facingMode[0];
  }
  const low = String(cam.label || '').toLowerCase();
  if (low.includes('back') || low.includes('rear') || low.includes('environment')) return 'environment';
  if (low.includes('front') || low.includes('user') || low.includes('selfie')) return 'user';
  return 'unknown';
}

function buildInitialSettings(cam, caps, deviceId, groupId, facing) {
  const raw = cam.settings && typeof cam.settings === 'object' ? cam.settings : {};
  const settings = {
    deviceId,
    groupId,
  };

  if (facing !== 'unknown') settings.facingMode = facing;

  const portrait = inferPortrait(cam, false);
  const wMax = isRangeCap(caps.width) && typeof caps.width.max === 'number' ? caps.width.max : 1920;
  const hMax = isRangeCap(caps.height) && typeof caps.height.max === 'number' ? caps.height.max : 1080;

  settings.width = typeof raw.width === 'number' && raw.width > 0
    ? raw.width
    : (portrait ? Math.min(1080, hMax) : Math.min(1920, wMax));
  settings.height = typeof raw.height === 'number' && raw.height > 0
    ? raw.height
    : (portrait ? Math.min(1920, wMax) : Math.min(1080, hMax));
  settings.aspectRatio = settings.height > 0
    ? roundToDecimals(settings.width / settings.height, 4)
    : 1;

  const frMax = isRangeCap(caps.frameRate) && typeof caps.frameRate.max === 'number' ? caps.frameRate.max : 30;
  settings.frameRate = typeof raw.frameRate === 'number' && raw.frameRate > 0
    ? Math.min(raw.frameRate, frMax)
    : Math.min(30, frMax);

  if (isRangeCap(caps.zoom)) {
    const zInit = typeof raw.zoom === 'number' ? raw.zoom : caps.zoom.min;
    settings.zoom = clampToCapability(zInit, caps.zoom);
  }
  if (Array.isArray(caps.focusMode) && caps.focusMode.length > 0) {
    if (typeof raw.focusMode === 'string' && caps.focusMode.includes(raw.focusMode)) {
      settings.focusMode = raw.focusMode;
    } else if (caps.focusMode.includes('continuous')) {
      settings.focusMode = 'continuous';
    } else {
      settings.focusMode = caps.focusMode[0];
    }
  }
  if (isRangeCap(caps.focusDistance)) {
    const fdInit = typeof raw.focusDistance === 'number' ? raw.focusDistance : caps.focusDistance.min;
    settings.focusDistance = clampToCapability(fdInit, caps.focusDistance);
  }
  if (Array.isArray(caps.exposureMode) && caps.exposureMode.length > 0) {
    if (typeof raw.exposureMode === 'string' && caps.exposureMode.includes(raw.exposureMode)) {
      settings.exposureMode = raw.exposureMode;
    } else if (caps.exposureMode.includes('continuous')) {
      settings.exposureMode = 'continuous';
    } else {
      settings.exposureMode = caps.exposureMode[0];
    }
  }
  if (isRangeCap(caps.exposureTime)) {
    const expInit = typeof raw.exposureTime === 'number'
      ? raw.exposureTime
      : Math.min(caps.exposureTime.max, Math.max(caps.exposureTime.min, 333.3));
    settings.exposureTime = clampToCapability(expInit, caps.exposureTime);
  }
  if (isRangeCap(caps.iso)) {
    const isoInit = typeof raw.iso === 'number'
      ? raw.iso
      : Math.min(caps.iso.max, Math.max(caps.iso.min, 200));
    settings.iso = clampToCapability(isoInit, caps.iso);
  }
  if (isRangeCap(caps.exposureCompensation)) {
    const compInit = typeof raw.exposureCompensation === 'number' ? raw.exposureCompensation : 0;
    settings.exposureCompensation = clampToCapability(compInit, caps.exposureCompensation);
  }
  if (caps.torch === true) {
    settings.torch = Boolean(raw.torch);
  }
  if (Array.isArray(caps.whiteBalanceMode) && caps.whiteBalanceMode.length > 0) {
    settings.whiteBalanceMode = typeof raw.whiteBalanceMode === 'string' && caps.whiteBalanceMode.includes(raw.whiteBalanceMode)
      ? raw.whiteBalanceMode
      : caps.whiteBalanceMode[0];
  }

  return settings;
}

/**
 * Normalizes a full diag JSON report, camera list, or single camera/capabilities object
 * into an ordered array of canonical camera definitions.
 */
export function normalizeCameraProfiles(source) {
  const src = source || A53_CC0F88_DIAG;
  let reportPortrait;
  let rawList;

  if (Array.isArray(src)) {
    rawList = src;
  } else if (src && Array.isArray(src.cameras)) {
    reportPortrait = typeof src.portrait === 'boolean' ? src.portrait : undefined;
    rawList = src.cameras;
  } else if (src && typeof src === 'object') {
    if (src.capabilities && typeof src.capabilities === 'object') {
      rawList = [src];
    } else {
      // Bare capabilities object passed directly
      rawList = [{ label: src.label || 'mock camera 0, facing back', capabilities: src }];
    }
  } else {
    rawList = A53_CC0F88_DIAG.cameras;
    reportPortrait = A53_CC0F88_DIAG.portrait;
  }

  return rawList
    .filter((cam) => cam && !cam.error)
    .map((cam, idx) => {
      const caps = sanitizeCapabilities(cam.capabilities || {});
      const facing = inferFacing(cam, caps);
      if (!caps.facingMode && facing !== 'unknown') {
        caps.facingMode = [facing];
      }
      const deviceId = cam.deviceId || cam.idHash || `mock-device-${idx}`;
      const groupId = cam.groupId || cam.groupHash || `mock-group-${facing}`;
      const portrait = inferPortrait(cam, reportPortrait);
      const settings = buildInitialSettings(cam, caps, deviceId, groupId, facing);
      return {
        index: typeof cam.index === 'number' ? cam.index : idx,
        label: cam.label || `camera ${idx}${facing === 'environment' ? ', facing back' : facing === 'user' ? ', facing front' : ''}`,
        deviceId,
        groupId,
        idHash: cam.idHash || null,
        facing,
        roleGuess: cam.roleGuess || null,
        portrait,
        capabilities: caps,
        initialSettings: settings,
        resolutions: cam.resolutions ? deepClone(cam.resolutions) : null,
      };
    });
}

function parseNumericConstraint(raw) {
  if (typeof raw === 'number') {
    return { bare: true, ideal: raw };
  }
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return {
      bare: false,
      exact: typeof raw.exact === 'number' ? raw.exact : undefined,
      min: typeof raw.min === 'number' ? raw.min : undefined,
      max: typeof raw.max === 'number' ? raw.max : undefined,
      ideal: typeof raw.ideal === 'number' ? raw.ideal : undefined,
    };
  }
  return null;
}

function parseEnumConstraint(raw) {
  if (typeof raw === 'string') {
    return { bare: true, exact: [raw] };
  }
  if (Array.isArray(raw)) {
    return { bare: true, exact: raw.slice() };
  }
  if (raw && typeof raw === 'object') {
    const exact = raw.exact !== undefined ? (Array.isArray(raw.exact) ? raw.exact : [raw.exact]) : undefined;
    const ideal = raw.ideal !== undefined ? (Array.isArray(raw.ideal) ? raw.ideal : [raw.ideal]) : undefined;
    return { bare: false, exact, ideal };
  }
  return null;
}

function parseBoolConstraint(raw) {
  if (typeof raw === 'boolean') return { bare: true, exact: raw };
  if (raw && typeof raw === 'object') {
    return {
      bare: false,
      exact: typeof raw.exact === 'boolean' ? raw.exact : undefined,
      ideal: typeof raw.ideal === 'boolean' ? raw.ideal : undefined,
    };
  }
  return null;
}

function solveRangeConstraint(key, rawConstraint, cap, currentVal) {
  const parsed = parseNumericConstraint(rawConstraint);
  if (!parsed) {
    throw new MockOverconstrainedError(key, `Invalid numeric constraint for "${key}"`);
  }

  const capMin = typeof cap.min === 'number' ? cap.min : -Infinity;
  const capMax = typeof cap.max === 'number' ? cap.max : Infinity;

  if (parsed.exact !== undefined) {
    if (!Number.isFinite(parsed.exact) || parsed.exact < capMin - EPS || parsed.exact > capMax + EPS) {
      throw new MockOverconstrainedError(
        key,
        `${key}.exact=${parsed.exact} outside capability [${capMin}, ${capMax}]`
      );
    }
    if (parsed.min !== undefined && parsed.exact < parsed.min - EPS) {
      throw new MockOverconstrainedError(key, `${key}.exact < ${key}.min`);
    }
    if (parsed.max !== undefined && parsed.exact > parsed.max + EPS) {
      throw new MockOverconstrainedError(key, `${key}.exact > ${key}.max`);
    }
    return clampToCapability(parsed.exact, cap);
  }

  const reqMin = parsed.min !== undefined ? parsed.min : -Infinity;
  const reqMax = parsed.max !== undefined ? parsed.max : Infinity;

  if (reqMin > reqMax + EPS) {
    throw new MockOverconstrainedError(key, `${key}.min (${reqMin}) > ${key}.max (${reqMax})`);
  }
  if (reqMin > capMax + EPS) {
    throw new MockOverconstrainedError(key, `${key}.min (${reqMin}) exceeds max capability (${capMax})`);
  }
  if (reqMax < capMin - EPS) {
    throw new MockOverconstrainedError(key, `${key}.max (${reqMax}) below min capability (${capMin})`);
  }

  const effMin = Math.max(capMin, reqMin);
  const effMax = Math.min(capMax, reqMax);

  let target = parsed.ideal !== undefined ? parsed.ideal : (typeof currentVal === 'number' ? currentVal : effMin);
  if (!Number.isFinite(target)) {
    throw new MockOverconstrainedError(key, `Non-finite value for "${key}"`);
  }
  if (target < effMin) target = effMin;
  if (target > effMax) target = effMax;

  const snapped = clampToCapability(target, { min: capMin, max: capMax, step: cap.step });
  // Ensure step snapping stays inside requested [effMin, effMax] if possible
  if (snapped < effMin - EPS) {
    if (cap.step > 0) {
      const up = clampToCapability(effMin + cap.step * 0.5, cap);
      if (up >= effMin - EPS && up <= effMax + EPS) return up;
    }
    return effMin;
  }
  if (snapped > effMax + EPS) {
    if (cap.step > 0) {
      const down = clampToCapability(effMax - cap.step * 0.5, cap);
      if (down >= effMin - EPS && down <= effMax + EPS) return down;
    }
    return effMax;
  }
  return snapped;
}

/**
 * Solves width/height together so portrait Android devices can orient landscape
 * `ideal` requests (e.g. 1280x720 -> 720x1280, 1920x1080 -> 1080x1920, 3840x2160 -> 2160x3840)
 * while still strictly enforcing `exact`, `min`, and `max`.
 */
function solveDimensions(constraintObj, caps, profile, nextSettings) {
  const hasW = 'width' in constraintObj && constraintObj.width !== undefined;
  const hasH = 'height' in constraintObj && constraintObj.height !== undefined;
  if (!hasW && !hasH) return;

  const wCap = isRangeCap(caps.width) ? caps.width : { min: 160, max: 4096 };
  const hCap = isRangeCap(caps.height) ? caps.height : { min: 120, max: 4096 };

  const wParsed = hasW ? parseNumericConstraint(constraintObj.width) : null;
  const hParsed = hasH ? parseNumericConstraint(constraintObj.height) : null;
  if ((hasW && !wParsed) || (hasH && !hParsed)) {
    throw new MockOverconstrainedError(hasW && !wParsed ? 'width' : 'height', 'Invalid dimension constraint');
  }

  const sensorLongMax = Math.max(wCap.max, hCap.max);
  const sensorShortMax = Math.min(wCap.max, hCap.max);
  const sensorShortMin = Math.min(wCap.min, hCap.min);

  const portraitAutoRotate =
    profile.portrait &&
    !(wParsed && (wParsed.exact !== undefined || wParsed.min !== undefined || wParsed.max !== undefined)) &&
    !(hParsed && (hParsed.exact !== undefined || hParsed.min !== undefined || hParsed.max !== undefined));

  if (portraitAutoRotate && wParsed && hParsed && wParsed.ideal !== undefined && hParsed.ideal !== undefined) {
    const reqLong = Math.max(wParsed.ideal, hParsed.ideal);
    const reqShort = Math.min(wParsed.ideal, hParsed.ideal);
    const shortDim = Math.round(Math.min(sensorShortMax, Math.max(sensorShortMin, reqShort)));
    const longDim = Math.round(Math.min(sensorLongMax, Math.max(sensorShortMin, reqLong)));
    nextSettings.width = shortDim;
    nextSettings.height = longDim;
  } else {
    // Allow rotated portrait axis limits on portrait devices (e.g. 2160x3840 on 4624x3468 sensor)
    const effWCap = profile.portrait ? { min: sensorShortMin, max: sensorLongMax, step: wCap.step } : wCap;
    const effHCap = profile.portrait ? { min: sensorShortMin, max: sensorLongMax, step: hCap.step } : hCap;
    if (hasW) {
      nextSettings.width = Math.round(solveRangeConstraint('width', constraintObj.width, effWCap, nextSettings.width));
    }
    if (hasH) {
      nextSettings.height = Math.round(solveRangeConstraint('height', constraintObj.height, effHCap, nextSettings.height));
    }
    // Verify combined sensor footprint isn't exceeding both axes simultaneously
    if (Math.min(nextSettings.width, nextSettings.height) > sensorShortMax + EPS) {
      throw new MockOverconstrainedError(
        hasW ? 'width' : 'height',
        `Requested ${nextSettings.width}x${nextSettings.height} exceeds sensor short-axis limit ${sensorShortMax}`
      );
    }
  }

  if (nextSettings.height > 0) {
    nextSettings.aspectRatio = roundToDecimals(nextSettings.width / nextSettings.height, 4);
  }
}

function applyConstraintSet(constraintObj, caps, profile, baseSettings, opts = {}) {
  const { allowPermissionZoomBool = false } = opts;
  const next = deepClone(baseSettings);

  // Solve width/height pair first
  solveDimensions(constraintObj, caps, profile, next);

  // Apply mode constraints before dependent numeric constraints (e.g. exposureMode before exposureTime)
  const keys = Object.keys(constraintObj).filter((k) => k !== 'width' && k !== 'height' && k !== 'advanced');
  keys.sort((a, b) => {
    const aMode = a.endsWith('Mode') ? 0 : 1;
    const bMode = b.endsWith('Mode') ? 0 : 1;
    return aMode - bMode;
  });

  for (const key of keys) {
    const val = constraintObj[key];
    if (val === undefined) continue;
    if (key === 'deviceId' || key === 'groupId') continue;

    // Chrome PTZ permission request (`getUserMedia({ video: { zoom: true } })`)
    if (key === 'zoom' && typeof val === 'boolean' && allowPermissionZoomBool) {
      continue;
    }

    if (key === 'torch') {
      const parsed = parseBoolConstraint(val);
      if (!parsed) throw new MockOverconstrainedError('torch', 'Invalid torch constraint');
      const supported = caps.torch === true;
      if (parsed.exact === true && !supported) {
        throw new MockOverconstrainedError('torch', 'Torch is not supported on this camera');
      }
      if (supported) {
        if (parsed.exact !== undefined) next.torch = parsed.exact;
        else if (parsed.ideal !== undefined) next.torch = parsed.ideal;
      }
      continue;
    }

    if (key === 'pointsOfInterest') {
      if (!caps.pointsOfInterest) {
        throw new MockOverconstrainedError('pointsOfInterest', 'pointsOfInterest is not supported on this camera');
      }
      const pts = Array.isArray(val) ? val : (val && typeof val === 'object' ? [val] : null);
      if (!pts || pts.length === 0) {
        throw new MockOverconstrainedError('pointsOfInterest', 'Invalid pointsOfInterest value');
      }
      next.pointsOfInterest = pts.map((p) => ({
        x: Math.max(0, Math.min(1, Number(p.x) || 0)),
        y: Math.max(0, Math.min(1, Number(p.y) || 0)),
      }));
      continue;
    }

    if (ENUM_KEYS.has(key)) {
      const allowed = Array.isArray(caps[key]) ? caps[key] : [];
      const parsed = parseEnumConstraint(val);
      if (!parsed) throw new MockOverconstrainedError(key, `Invalid constraint for "${key}"`);

      if (parsed.exact) {
        const match = parsed.exact.find((m) => allowed.includes(m));
        if (!match) {
          throw new MockOverconstrainedError(
            key,
            `${key} "${parsed.exact.join('|')}" not in supported [${allowed.join(', ')}]`
          );
        }
        next[key] = match;
      } else if (parsed.ideal) {
        const match = parsed.ideal.find((m) => allowed.includes(m));
        if (match) next[key] = match;
      }
      continue;
    }

    if (RANGE_KEYS.has(key)) {
      const cap = caps[key];
      if (!isRangeCap(cap)) {
        // Unsupported numeric capability: reject exact/min/max or explicit ImageCapture request
        const parsed = parseNumericConstraint(val);
        if (!parsed || parsed.exact !== undefined || parsed.min !== undefined || parsed.max !== undefined || IMAGE_CAPTURE_RANGE_KEYS.has(key)) {
          throw new MockOverconstrainedError(key, `"${key}" is not supported on this camera`);
        }
        continue;
      }
      next[key] = solveRangeConstraint(key, val, cap, next[key]);
      continue;
    }
  }

  return next;
}

/**
 * Mock MediaStreamTrack backed by a camera capability profile.
 */
export class MockMediaStreamTrack {
  constructor(profile, opts = {}) {
    this._profile = profile;
    this._capabilities = deepClone(profile.capabilities);
    this._settings = deepClone(profile.initialSettings);
    this._constraints = {};
    this._history = [];
    this._onStop = typeof opts.onStop === 'function' ? opts.onStop : null;

    this.kind = 'video';
    this.id = opts.trackId || `mock-track-${profile.deviceId}`;
    this.label = profile.label;
    this.readyState = 'live';
    this.enabled = true;
    this.muted = false;
  }

  getCapabilities() {
    return deepClone(this._capabilities);
  }

  getSettings() {
    return deepClone(this._settings);
  }

  getConstraints() {
    return deepClone(this._constraints);
  }

  getHistory() {
    return deepClone(this._history);
  }

  async applyConstraints(constraints = {}) {
    if (this.readyState === 'ended') {
      const err = new MockDOMError('InvalidStateError', 'Cannot applyConstraints to an ended track');
      this._history.push({ constraints: deepClone(constraints), ok: false, error: err.name });
      throw err;
    }
    const c = constraints && typeof constraints === 'object' ? constraints : {};

    try {
      // 1. Apply top-level constraints
      let next = applyConstraintSet(c, this._capabilities, this._profile, this._settings);

      // 2. Apply `advanced` constraint sets in order
      if (Array.isArray(c.advanced) && c.advanced.length > 0) {
        if (c.advanced.length === 1) {
          // Single-set Chrome ImageCapture semantics: reject with OverconstrainedError if unsatisfiable
          const set0 = c.advanced[0];
          if (set0 && typeof set0 === 'object') {
            next = applyConstraintSet(set0, this._capabilities, this._profile, next);
          }
        } else {
          // Multi-set W3C fallback semantics: apply every satisfiable set in order, skip unsatisfiable ones
          for (const advSet of c.advanced) {
            if (!advSet || typeof advSet !== 'object') continue;
            try {
              next = applyConstraintSet(advSet, this._capabilities, this._profile, next);
            } catch (advErr) {
              if (!(advErr instanceof MockOverconstrainedError)) throw advErr;
            }
          }
        }
      }

      this._settings = next;
      this._constraints = deepClone(c);
      this._history.push({
        constraints: deepClone(c),
        settings: deepClone(next),
        ok: true,
        error: null,
      });
    } catch (err) {
      this._history.push({
        constraints: deepClone(c),
        settings: deepClone(this._settings),
        ok: false,
        error: err && err.name ? err.name : String(err),
      });
      throw err;
    }
  }

  stop() {
    if (this.readyState === 'ended') return;
    this.readyState = 'ended';
    if (this._onStop) this._onStop(this);
  }

  clone() {
    const copy = new MockMediaStreamTrack(this._profile);
    copy._settings = deepClone(this._settings);
    copy._constraints = deepClone(this._constraints);
    return copy;
  }
}

/**
 * Mock MediaStream containing one or more MockMediaStreamTrack instances.
 */
export class MockMediaStream {
  constructor(tracks = [], id = 'mock-stream-1') {
    this.id = id;
    this._tracks = tracks.slice();
  }

  get active() {
    return this._tracks.some((t) => t.readyState === 'live');
  }

  getTracks() {
    return this._tracks.slice();
  }

  getVideoTracks() {
    return this._tracks.filter((t) => t.kind === 'video');
  }

  getAudioTracks() {
    return this._tracks.filter((t) => t.kind === 'audio');
  }
}

/**
 * Creates a standalone MockMediaStreamTrack for a camera capability object,
 * or selects one camera from a diag report by predicate/index (defaults to A53 camera 0).
 *
 * @param {object} [capsOrDiag]  Full diag JSON, camera entry, or raw capabilities object.
 * @param {{ cameraLabel?: string | RegExp, deviceId?: string, index?: number }} [opts]
 */
export function createMockTrack(capsOrDiag, opts = {}) {
  const profiles = normalizeCameraProfiles(capsOrDiag);
  if (profiles.length === 0) {
    throw new Error('No camera profiles available for createMockTrack');
  }

  let selected = null;
  if (opts.deviceId) {
    selected = profiles.find((p) => p.deviceId === opts.deviceId || p.idHash === opts.deviceId);
  } else if (opts.cameraLabel instanceof RegExp) {
    selected = profiles.find((p) => opts.cameraLabel.test(p.label));
  } else if (typeof opts.cameraLabel === 'string') {
    selected = profiles.find((p) => p.label.toLowerCase().includes(opts.cameraLabel.toLowerCase()));
  } else if (typeof opts.index === 'number') {
    selected = profiles[opts.index] || null;
  } else if (profiles.length > 1) {
    // Default to main rear camera (camera 0 on A53) when given a multi-camera diag report
    selected = pickDefaultRearProfile(profiles) || profiles[0];
  } else {
    selected = profiles[0];
  }

  if (!selected) {
    throw new Error('Requested camera profile not found');
  }
  return new MockMediaStreamTrack(selected);
}

function scoreRearMain(profile) {
  let s = 0;
  if (profile.facing === 'environment') s += 100;
  if (profile.roleGuess === 'MAIN?') s += 40;
  const caps = profile.capabilities || {};
  if (Array.isArray(caps.focusMode) && caps.focusMode.includes('continuous')) s += 30;
  if (caps.torch === true) s += 20;
  if (/\bcamera2?\s*0\b/i.test(profile.label || '')) s += 15;
  if (isRangeCap(caps.width) && typeof caps.width.max === 'number') s += Math.min(10, caps.width.max / 500);
  return s;
}

function pickDefaultRearProfile(profiles) {
  const rear = profiles.filter((p) => p.facing === 'environment');
  if (rear.length === 0) return null;
  return rear.slice().sort((a, b) => scoreRearMain(b) - scoreRearMain(a))[0];
}

function extractDeviceIdConstraint(raw) {
  if (typeof raw === 'string') return { exact: raw };
  if (raw && typeof raw === 'object') {
    if (typeof raw.exact === 'string') return { exact: raw.exact };
    if (Array.isArray(raw.exact) && raw.exact.length > 0) return { exact: raw.exact[0] };
    if (typeof raw.ideal === 'string') return { ideal: raw.ideal };
  }
  return null;
}

/**
 * Creates a fake `navigator.mediaDevices` implementation backed by a diag JSON report
 * (defaults to `A53_CC0F88_DIAG`).
 */
export function createMockMediaDevices(diagOrCaps = A53_CC0F88_DIAG) {
  const profiles = normalizeCameraProfiles(diagOrCaps);
  let streamSeq = 0;
  const activeTracks = new Set();
  const calls = [];

  const supportedKeys = {
    width: true,
    height: true,
    aspectRatio: true,
    frameRate: true,
    facingMode: true,
    deviceId: true,
    groupId: true,
  };
  for (const p of profiles) {
    for (const k of Object.keys(p.capabilities)) {
      supportedKeys[k] = true;
    }
  }

  const mediaDevices = {
    calls,
    profiles,
    getActiveTracks() {
      return Array.from(activeTracks);
    },
    getSupportedConstraints() {
      return { ...supportedKeys };
    },
    async enumerateDevices() {
      return profiles.map((p) => ({
        deviceId: p.deviceId,
        groupId: p.groupId,
        kind: 'videoinput',
        label: p.label,
        toJSON() {
          return {
            deviceId: this.deviceId,
            groupId: this.groupId,
            kind: this.kind,
            label: this.label,
          };
        },
      }));
    },
    async getUserMedia(constraints = {}) {
      const record = { constraints: deepClone(constraints), ok: false, deviceId: null, error: null };
      calls.push(record);

      const video = constraints && constraints.video;
      if (video === false || video === undefined || video === null) {
        const err = new MockDOMError('TypeError', 'video constraint must be true or an object');
        record.error = err.name;
        throw err;
      }

      const vc = video === true ? {} : video;
      if (profiles.length === 0) {
        const err = new MockDOMError('NotFoundError', 'No video input devices available');
        record.error = err.name;
        throw err;
      }

      let candidate = null;

      // 1. deviceId selection
      if (vc.deviceId !== undefined) {
        const dReq = extractDeviceIdConstraint(vc.deviceId);
        if (dReq && dReq.exact) {
          candidate = profiles.find((p) => p.deviceId === dReq.exact || p.idHash === dReq.exact) || null;
          if (!candidate) {
            const err = new MockOverconstrainedError('deviceId', `No camera with deviceId "${dReq.exact}"`);
            record.error = err.name;
            throw err;
          }
        } else if (dReq && dReq.ideal) {
          candidate = profiles.find((p) => p.deviceId === dReq.ideal || p.idHash === dReq.ideal) || null;
        }
      }

      // 2. facingMode selection (when no deviceId matched)
      if (!candidate && vc.facingMode !== undefined) {
        const fReq = parseEnumConstraint(vc.facingMode);
        if (fReq && fReq.exact) {
          const matching = profiles.filter((p) => fReq.exact.includes(p.facing));
          if (matching.length === 0) {
            const err = new MockOverconstrainedError('facingMode', `No camera matches facingMode "${fReq.exact.join('|')}"`);
            record.error = err.name;
            throw err;
          }
          candidate = fReq.exact.includes('environment')
            ? (pickDefaultRearProfile(matching) || matching[0])
            : matching[0];
        } else if (fReq && fReq.ideal) {
          const matching = profiles.filter((p) => fReq.ideal.includes(p.facing));
          if (matching.length > 0) {
            candidate = fReq.ideal.includes('environment')
              ? (pickDefaultRearProfile(matching) || matching[0])
              : matching[0];
          }
        }
      }

      // 3. Default selection: prefer main rear camera if available, else first device
      if (!candidate) {
        candidate = pickDefaultRearProfile(profiles) || profiles[0];
      }

      const track = new MockMediaStreamTrack(candidate, {
        trackId: `mock-track-${++streamSeq}-${candidate.deviceId}`,
        onStop(t) {
          activeTracks.delete(t);
        },
      });

      // Apply initial getUserMedia constraints (allowing `zoom: true` PTZ permission flag)
      try {
        const next = applyConstraintSet(vc, track._capabilities, candidate, track._settings, {
          allowPermissionZoomBool: true,
        });
        if (Array.isArray(vc.advanced) && vc.advanced.length > 0) {
          let advNext = next;
          for (const advSet of vc.advanced) {
            if (!advSet || typeof advSet !== 'object') continue;
            try {
              advNext = applyConstraintSet(advSet, track._capabilities, candidate, advNext, {
                allowPermissionZoomBool: true,
              });
            } catch (advErr) {
              if (vc.advanced.length === 1 || !(advErr instanceof MockOverconstrainedError)) {
                throw advErr;
              }
            }
          }
          track._settings = advNext;
        } else {
          track._settings = next;
        }
        track._constraints = deepClone(vc);
      } catch (err) {
        record.error = err && err.name ? err.name : String(err);
        throw err;
      }

      activeTracks.add(track);
      record.ok = true;
      record.deviceId = candidate.deviceId;
      return new MockMediaStream([track], `mock-stream-${streamSeq}`);
    },
  };

  return mediaDevices;
}

/**
 * Creates a minimal HTMLVideoElement mock for Node tests of `startCamera` and `probeCameras`.
 */
export function createMockVideoElement() {
  let _srcObject = null;
  const listeners = new Map();

  const videoEl = {
    playsInline: false,
    muted: false,
    videoWidth: 0,
    videoHeight: 0,
    readyState: 0,
    get srcObject() {
      return _srcObject;
    },
    set srcObject(stream) {
      _srcObject = stream;
      if (stream && typeof stream.getVideoTracks === 'function') {
        const t = stream.getVideoTracks()[0];
        if (t && typeof t.getSettings === 'function') {
          const s = t.getSettings();
          this.videoWidth = s.width || 0;
          this.videoHeight = s.height || 0;
          this.readyState = 4;
          return;
        }
      }
      this.videoWidth = 0;
      this.videoHeight = 0;
      this.readyState = 0;
    },
    async play() {
      return undefined;
    },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      if (listeners.has(type)) listeners.get(type).delete(fn);
    },
  };
  return videoEl;
}

function createMockCanvasElement() {
  let w = 24;
  let h = 16;
  return {
    get width() { return w; },
    set width(v) { w = v | 0; },
    get height() { return h; },
    set height(v) { h = v | 0; },
    getContext() {
      return {
        drawImage() {},
        getImageData(_x, _y, cw, ch) {
          const data = new Uint8ClampedArray(cw * ch * 4);
          // Deterministic mid-grey frame so zoomSweep MAE is 0 (no false framing jump)
          for (let i = 0; i < data.length; i += 4) {
            data[i] = 128;
            data[i + 1] = 128;
            data[i + 2] = 128;
            data[i + 3] = 255;
          }
          return { data, width: cw, height: ch };
        },
      };
    },
  };
}

function createMemoryStorage() {
  const map = new Map();
  return {
    getItem(k) { return map.has(k) ? map.get(k) : null; },
    setItem(k, v) { map.set(String(k), String(v)); },
    removeItem(k) { map.delete(k); },
    clear() { map.clear(); },
  };
}

/**
 * Installs a mock `navigator.mediaDevices` (plus optional minimal `document` & `localStorage`)
 * on `globalThis` safely (works on Node 21+ where `globalThis.navigator` is getter-only).
 * Returns a `restore()` function that restores every descriptor to its prior state.
 */
export function installMockBrowserEnv(mediaDevices, opts = {}) {
  const { withDocument = false, withLocalStorage = false } = opts;
  const saved = [];

  function overrideGlobal(prop, value) {
    const hadOwn = Object.prototype.hasOwnProperty.call(globalThis, prop);
    const desc = hadOwn ? Object.getOwnPropertyDescriptor(globalThis, prop) : null;
    saved.push({ prop, hadOwn, desc });
    Object.defineProperty(globalThis, prop, {
      value,
      configurable: true,
      writable: true,
      enumerable: true,
    });
  }

  const prevNav = globalThis.navigator;
  const mockNav = Object.create(prevNav && typeof prevNav === 'object' ? prevNav : Object.prototype);
  Object.defineProperty(mockNav, 'mediaDevices', {
    value: mediaDevices,
    configurable: true,
    writable: true,
    enumerable: true,
  });
  overrideGlobal('navigator', mockNav);

  if (withDocument) {
    overrideGlobal('document', {
      createElement(tag) {
        if (String(tag).toLowerCase() === 'canvas') return createMockCanvasElement();
        return {};
      },
    });
  }

  let storage = null;
  if (withLocalStorage) {
    storage = createMemoryStorage();
    overrideGlobal('localStorage', storage);
  }

  return {
    storage,
    restore() {
      for (let i = saved.length - 1; i >= 0; i--) {
        const { prop, hadOwn, desc } = saved[i];
        if (hadOwn && desc) {
          Object.defineProperty(globalThis, prop, desc);
        } else {
          delete globalThis[prop];
        }
      }
    },
  };
}
