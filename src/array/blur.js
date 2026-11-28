/**
 * B1 — Scan-Angle-Aware Motion-Blur Gate (`src/array/blur.js`).
 *
 * Computes expected shutter motion smear in Code 128 modules along the active barcode
 * scan axis (`thetaDeg`: 90° for ladder labels with horizontal bars, 0° for picket-fence labels).
 * Sideways motion perpendicular to the scan axis runs along the bars and does not trigger the gate.
 */

const DEG_TO_RAD = Math.PI / 180;

/**
 * Computes along-scan blur in Code 128 modules.
 *
 * @param {{
 *   wPanDps: number,
 *   wPitchDps: number,
 *   wRollDps?: number,
 *   scanAngleDeg?: number,
 *   exposureSec?: number,
 *   pxPerModule: number,
 *   focalLengthPx: number,
 *   labelRadiusPx?: number
 * }} params
 */
export function computeBlurModules({
  wPanDps = 0,
  wPitchDps = 0,
  wRollDps = 0,
  scanAngleDeg = 90,
  exposureSec = 1 / 60,
  pxPerModule = 2.5,
  focalLengthPx = 1350,
  labelRadiusPx = 0,
}) {
  if (!exposureSec || exposureSec <= 0 || !pxPerModule || pxPerModule <= 0) {
    return 0;
  }
  // Image-plane velocity (px/s): pan moves image horizontally (u), pitch moves vertically (v)
  const uPxPerS = focalLengthPx * (wPanDps * DEG_TO_RAD);
  const vPxPerS = focalLengthPx * (wPitchDps * DEG_TO_RAD);

  const rad = scanAngleDeg * DEG_TO_RAD;
  const alongScanPxPerS = Math.abs(uPxPerS * Math.cos(rad) + vPxPerS * Math.sin(rad));
  const rollPxPerS = Math.abs(wRollDps * DEG_TO_RAD) * Math.max(0, labelRadiusPx);

  return ((alongScanPxPerS + rollPxPerS) * exposureSec) / pxPerModule;
}
