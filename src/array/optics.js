/**
 * A1 — Optical Pixels-Per-Module (PPM) Calculator & Status Classifier (`src/array/optics.js`).
 */

import { computeCode128Modules } from './config.js';

const DEG_TO_RAD = Math.PI / 180;

/**
 * Estimates total Code 128 modules (delegates to canonical `computeCode128Modules`).
 * Legacy default is 12 chars (187 modules); real FC label sample `tsX07wz7py1` is 11 chars (176 modules).
 */
export function estimateModules(payloadChars = 12, quietModules = 10) {
  const c = typeof payloadChars === 'string'
    ? (payloadChars.length > 0 ? payloadChars.length : 12)
    : (payloadChars > 0 ? payloadChars : 12);
  return computeCode128Modules(c, quietModules);
}

/**
 * Computes pixels-per-module for a Code 128 label of physical scan length `labelLenIn`
 * at standoff `distanceIn` with long-axis HFOV `hfovDeg` and optical/digital `zoom`.
 *
 * Legacy default is 12 chars (187 modules) when `modules`, `payload`, and `payloadChars`
 * are omitted; real FC label sample `tsX07wz7py1` is 11 chars (176 modules).
 */
export function pxPerModule({
  distanceIn,
  hfovDeg = 70.7,
  zoom = 1,
  widthPx = 1920,
  heightPx = 1080,
  labelLenIn = 3.5,
  modules,
  payloadChars,
  payload,
  quietModules = 10,
}) {
  const resolvedModules = modules !== undefined
    ? modules
    : (payload !== undefined || payloadChars !== undefined
      ? computeCode128Modules(payload !== undefined ? payload : payloadChars, quietModules)
      : computeCode128Modules(12, quietModules));
  const longPx = Math.max(widthPx, heightPx);
  const visibleLongIn = (2 * distanceIn * Math.tan((hfovDeg * 0.5) * DEG_TO_RAD)) / Math.max(0.5, zoom);
  const pxPerIn = longPx / visibleLongIn;
  const labelPx = labelLenIn * pxPerIn;
  return labelPx / Math.max(1, resolvedModules);
}

/**
 * Returns structured optics feasibility report (`ok >= 2.0`, `marginal 1.5–2.0`, `bad < 1.5`).
 */
export function evaluateOptics(params) {
  const ppm = pxPerModule(params);
  const status = ppm >= 2.0 ? 'ok' : (ppm >= 1.5 ? 'marginal' : 'bad');
  return {
    ppm: Math.round(ppm * 100) / 100,
    status,
    feasible: ppm >= 1.5,
  };
}
