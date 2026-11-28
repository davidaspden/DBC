/**
 * B2 — Exact Camera-to-HUD View Mapping Transform (`src/array/viewmap.js`).
 *
 * Eliminates box/guide drift when a 16:9 or 9:16 camera stream is rendered inside a
 * container of a different aspect ratio (supports both `contain` and `cover` modes).
 */

/**
 * Computes `{ scale, offX, offY, drawW, drawH }` mapping source frame pixels
 * `(frameW x frameH)` into CSS viewport pixels `(cssW x cssH)`.
 *
 * @param {number} frameW
 * @param {number} frameH
 * @param {number} cssW
 * @param {number} cssH
 * @param {'contain' | 'cover'} [fit='contain']
 */
export function computeViewTransform(frameW, frameH, cssW, cssH, fit = 'contain') {
  if (frameW <= 0 || frameH <= 0 || cssW <= 0 || cssH <= 0) {
    return { scale: 1, offX: 0, offY: 0, drawW: cssW, drawH: cssH };
  }
  const scale = fit === 'cover'
    ? Math.max(cssW / frameW, cssH / frameH)
    : Math.min(cssW / frameW, cssH / frameH);
  const drawW = frameW * scale;
  const drawH = frameH * scale;
  const offX = (cssW - drawW) * 0.5;
  const offY = (cssH - drawH) * 0.5;
  return { scale, offX, offY, drawW, drawH };
}

/**
 * Maps a source frame rectangle `{ x, y, w, h }` into HUD CSS coordinates.
 */
export function mapRectToHud(rect, xform) {
  return {
    x: xform.offX + rect.x * xform.scale,
    y: xform.offY + rect.y * xform.scale,
    w: rect.w * xform.scale,
    h: rect.h * xform.scale,
  };
}
