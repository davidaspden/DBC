/**
 * C4 — Exposure & Motion-Blur Speed Budget Helpers (`src/capture/exposure.js`).
 */

import { computeCode128Modules } from '../array/config.js';

/**
 * Computes the maximum safe motion speed along the barcode scan axis (in/s)
 * before shutter blur exceeds `blurModulesLimit` modules.
 *
 * Legacy default is 12 chars (187 modules) when `modules`, `payload`, and `payloadChars`
 * are omitted; real FC label sample `tsX07wz7py1` is 11 chars (176 modules).
 *
 * @param {{
 *   exposureSec: number,
 *   labelLenIn?: number,
 *   modules?: number,
 *   payloadChars?: number,
 *   payload?: string,
 *   quietModules?: number,
 *   blurModulesLimit?: number
 * }} params
 */
export function computeMaxSafeSpeedInPerSec({
  exposureSec,
  labelLenIn = 3.5,
  modules,
  payloadChars,
  payload,
  quietModules = 10,
  blurModulesLimit = 0.8,
}) {
  const resolvedModules = modules !== undefined
    ? modules
    : (payload !== undefined || payloadChars !== undefined
      ? computeCode128Modules(payload !== undefined ? payload : payloadChars, quietModules)
      : computeCode128Modules(12, quietModules));
  if (!exposureSec || exposureSec <= 0 || !resolvedModules || resolvedModules <= 0) return Infinity;
  const moduleIn = labelLenIn / resolvedModules;
  return (blurModulesLimit * moduleIn) / exposureSec;
}

/**
 * Formats an exposure info struct from `getExposureInfo(track)` for compact HUD display.
 */
export function formatExposureLabel(info) {
  if (!info || !info.exposureTimeSec || info.exposureTimeSec <= 0) {
    return info && info.mode === 'manual' ? 'manual' : 'auto (~1/60s)';
  }
  const denom = Math.max(1, Math.round(1 / info.exposureTimeSec));
  const isoStr = info.iso ? ` ISO ${Math.round(info.iso)}` : '';
  return `1/${denom}s${isoStr}`;
}
