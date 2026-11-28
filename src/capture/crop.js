/**
 * C5 — Crop-at-Source Geometry & Even-Aligned VideoFrame Rect Helper (`src/capture/crop.js`).
 *
 * Aligns crop rectangles to even coordinates (4:2:0 YUV chroma subsampling requirement)
 * and clamps cleanly to frame bounds so 4K frames (`2160x3840` on Galaxy A53 5G) can be
 * cropped natively in `VideoFrame.copyTo({ rect })` without exceeding the 25 ms worker budget.
 */

/**
 * Computes an even-aligned `{ x, y, width, height }` crop rect centered on `(cxFrac, cyFrac)`.
 * Guarantees `width % 4 === 0` and `height % 2 === 0` for clean 4x downscale and YUV alignment.
 */
export function computeEvenCropRect(frameW, frameH, { widthFrac = 0.55, heightFrac = 0.65, cxFrac = 0.5, cyFrac = 0.5 } = {}) {
  const fw = frameW | 0;
  const fh = frameH | 0;
  let w = Math.max(128, Math.min(fw, Math.round(fw * widthFrac)));
  let h = Math.max(128, Math.min(fh, Math.round(fh * heightFrac)));
  w = w & ~3; // multiple of 4
  h = h & ~1; // even
  let x = Math.round(fw * cxFrac - w * 0.5) & ~1;
  let y = Math.round(fh * cyFrac - h * 0.5) & ~1;
  if (x < 0) x = 0;
  if (y < 0) y = 0;
  if (x + w > fw) x = Math.max(0, (fw - w) & ~1);
  if (y + h > fh) y = Math.max(0, (fh - h) & ~1);
  return { x, y, width: w, height: h };
}

/**
 * Translates worker detection coordinates from cropped space back to full-frame pixel space.
 */
export function offsetDetectionByCrop(det, cropX, cropY) {
  if (!det || (cropX === 0 && cropY === 0)) return det;
  return {
    ...det,
    roiX: (det.roiX || 0) + cropX,
    roiY: (det.roiY || 0) + cropY,
    roiCenterX: (det.roiCenterX || 0) + cropX,
    roiCenterY: (det.roiCenterY || 0) + cropY,
    x0: det.x0 !== undefined ? det.x0 + cropX : undefined,
    y0: det.y0 !== undefined ? det.y0 + cropY : undefined,
    x1: det.x1 !== undefined ? det.x1 + cropX : undefined,
    y1: det.y1 !== undefined ? det.y1 + cropY : undefined,
  };
}
