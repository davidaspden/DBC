/**
 * A1 — Optical Pixels-Per-Module (PPM) Calculator & Status Classifier (`src/array/optics.js`).
 */

const DEG_TO_RAD = Math.PI / 180;

export function estimateModules(payloadChars = 12) {
  const c = payloadChars > 0 ? payloadChars : 12;
  return 11 * c + 35 + 20;
}

/**
 * Computes pixels-per-module for a Code 128 label of physical scan length `labelLenIn`
 * at standoff `distanceIn` with long-axis HFOV `hfovDeg` and optical/digital `zoom`.
 */
export function pxPerModule({
  distanceIn,
  hfovDeg = 70.7,
  zoom = 1,
  widthPx = 1920,
  heightPx = 1080,
  labelLenIn = 3.5,
  modules = 187,
}) {
  const longPx = Math.max(widthPx, heightPx);
  const visibleLongIn = (2 * distanceIn * Math.tan((hfovDeg * 0.5) * DEG_TO_RAD)) / Math.max(0.5, zoom);
  const pxPerIn = longPx / visibleLongIn;
  const labelPx = labelLenIn * pxPerIn;
  return labelPx / Math.max(1, modules);
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
