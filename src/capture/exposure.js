/**
 * C4 — Exposure & Motion-Blur Speed Budget Helpers (`src/capture/exposure.js`).
 */

/**
 * Computes the maximum safe motion speed along the barcode scan axis (in/s)
 * before shutter blur exceeds `blurModulesLimit` modules.
 *
 * @param {{
 *   exposureSec: number,
 *   labelLenIn?: number,
 *   modules?: number,
 *   blurModulesLimit?: number
 * }} params
 */
export function computeMaxSafeSpeedInPerSec({
  exposureSec,
  labelLenIn = 3.5,
  modules = 187,
  blurModulesLimit = 0.8,
}) {
  if (!exposureSec || exposureSec <= 0 || !modules || modules <= 0) return Infinity;
  const moduleIn = labelLenIn / modules;
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
