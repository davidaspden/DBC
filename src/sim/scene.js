/**
 * R4 — Canonical Sim & AR World Scene Model + Plugin Registry (`src/sim/scene.js`).
 *
 * Describes a tote wall world identically for WebGL rendering (`webgl-wall.js`),
 * headless CPU rendering (`cpu-render.js`), AR compositing (`src/ar/compose.js`),
 * and the offline verification gate (`tools/simgate.mjs`).
 *
 * Defaults equal today's baseline 4x4 grid (14x16 in totes, 56x64 in wall,
 * 2x6 in vertical Code 128B ladder labels with 231 modules).
 */

import {
  TOTE_WIDTH_IN,
  TOTE_HEIGHT_IN,
  GRID_COLS,
  GRID_ROWS,
  createWallCells,
} from './paths.js';
import { normalizeLabelSpec } from './label.js';

const simPlugins = [];

/**
 * Registers a stream plugin hook so Wave 2/3 streams (K9 profiles, Labs extensions, etc.)
 * can attach to `sim.html` without further edits to the HTML shell.
 */
export function registerSimPlugin(plugin) {
  if (!plugin || typeof plugin !== 'object') {
    throw new TypeError('Sim plugin must be a non-null object');
  }
  simPlugins.push(plugin);
  return plugin;
}

export function getSimPlugins() {
  return simPlugins.slice();
}

export function clearSimPlugins() {
  simPlugins.length = 0;
}

export const TOTE_ORIENTATIONS = Object.freeze({
  '14Wx16H': Object.freeze({ widthIn: 14, heightIn: 16 }),
  '16Wx14H': Object.freeze({ widthIn: 16, heightIn: 14 }),
  custom: null,
});

/**
 * Resolves tote orientation profile (`'14Wx16H'`, `'16Wx14H'`, or `'custom'`) to outer tote dimensions.
 */
export function resolveToteOrientation(orientation, toteOverrides = {}) {
  if (orientation === '16Wx14H') {
    return {
      toteOrientation: '16Wx14H',
      widthIn: toteOverrides.widthIn ?? 16,
      heightIn: toteOverrides.heightIn ?? 14,
    };
  }
  if (orientation === 'custom') {
    return {
      toteOrientation: 'custom',
      widthIn: toteOverrides.widthIn ?? TOTE_WIDTH_IN,
      heightIn: toteOverrides.heightIn ?? TOTE_HEIGHT_IN,
    };
  }
  return {
    toteOrientation: '14Wx16H',
    widthIn: toteOverrides.widthIn ?? TOTE_WIDTH_IN,
    heightIn: toteOverrides.heightIn ?? TOTE_HEIGHT_IN,
  };
}

/**
 * Builds a complete, immutable-friendly scene description with legacy defaults preserved.
 */
export function createScene(overrides = {}) {
  const fcMode = Boolean(overrides.fcMode);
  const cols = (overrides.cols > 0) ? (overrides.cols | 0) : GRID_COLS;
  const rows = (overrides.rows > 0) ? (overrides.rows | 0) : GRID_ROWS;
  const resolvedTote = resolveToteOrientation(overrides.toteOrientation, {
    widthIn: overrides.tote?.widthIn ?? overrides.toteWidthIn,
    heightIn: overrides.tote?.heightIn ?? overrides.toteHeightIn,
  });
  const toteOrientation = resolvedTote.toteOrientation;
  const toteWidthIn = resolvedTote.widthIn;
  const toteHeightIn = resolvedTote.heightIn;
  const pitchXIn = overrides.pitchXIn ?? overrides.pitchX ?? toteWidthIn;
  const pitchYIn = overrides.pitchYIn ?? overrides.pitchY ?? toteHeightIn;
  const wallWidthIn = cols * pitchXIn;
  const wallHeightIn = rows * pitchYIn;
  const label = normalizeLabelSpec(overrides.label || {}, fcMode);

  const labelOffset = {
    meanXIn: overrides.labelOffset?.meanXIn ?? 0,
    meanYIn: overrides.labelOffset?.meanYIn ?? 0,
    sigmaXIn: overrides.labelOffset?.sigmaXIn ?? 0,
    sigmaYIn: overrides.labelOffset?.sigmaYIn ?? 0,
    ...(overrides.labelOffset?.seed !== undefined ? { seed: overrides.labelOffset.seed } : {}),
  };

  const cells = Array.isArray(overrides.cells)
    ? overrides.cells
    : createWallCells({ fcMode, cols, rows, pitchXIn, pitchYIn, label, labelOffset, seed: overrides.seed });

  return {
    cols,
    rows,
    pitchXIn,
    pitchYIn,
    toteOrientation,
    tote: { widthIn: toteWidthIn, heightIn: toteHeightIn },
    wallWidthIn,
    wallHeightIn,
    fcMode,
    label,
    labelOffset,
    lips: overrides.lips ?? null,
    negatives: overrides.negatives ?? null,
    defects: overrides.defects ?? null,
    wallTexture: overrides.wallTexture ?? null,
    shadowStrength: overrides.shadowStrength ?? 0.35,
    noiseStrength: overrides.noiseStrength ?? 0.015,
    glareStrength: overrides.glareStrength ?? 0.16,
    cells,
  };
}
