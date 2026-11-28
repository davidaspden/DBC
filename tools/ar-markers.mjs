#!/usr/bin/env node
/**
 * M1 — Printable 1:1 Scale AR Wall Marker Generator (`tools/ar-markers.mjs`).
 *
 * Generates:
 *  - Exact 1:1 scale SVG tile pages (`width="...mm" height="...mm" viewBox="0 0 W H"`)
 *    for A4 (210x297 mm) or Letter (215.9x279.4 mm) with configurable overlap (default 10 mm),
 *    crop/registration marks, tile index, scale verification bar, and printed dot coordinates.
 *  - Hand-draw coordinate sheet (`hand-draw-sheet.txt` + `hand-draw-sheet.svg`) with a ruler
 *    marking table (inches & mm) and blank measured-override columns for Tier A walls.
 *  - Optional one-page tiling overview (`overview.svg`) showing tile layout and taping map.
 *  - Serialised M0 layout JSON (`layout.json`) ready to import into `ar.html`.
 *
 * Pure string output; Node.js built-ins only; zero external dependencies.
 *
 * Usage:
 *   node tools/ar-markers.mjs --pitchX 16 --pitchY 14 --cols 4 --rows 4 --tier B --paper A4 [--out dir]
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createArLayout, serializeArLayout } from '../src/ar/layout.js';

export const MM_PER_INCH = 25.4;

export const PAPER_SIZES_MM = Object.freeze({
  A4: Object.freeze({ name: 'A4', widthMm: 210.0, heightMm: 297.0 }),
  Letter: Object.freeze({ name: 'Letter', widthMm: 215.9, heightMm: 279.4 }),
});

function roundMm(v) {
  return Math.round(v * 10000) / 10000;
}

function fmtMm(v) {
  return Number(roundMm(v)).toFixed(4).replace(/\.?0+$/, '') || '0';
}

function fmtIn(v) {
  return Number(v).toFixed(2);
}

function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Resolves paper dimensions in mm for `'A4'` or `'Letter'` and `'portrait'` or `'landscape'`.
 */
export function resolvePaper(paperName = 'A4', orientation = 'portrait') {
  const key = String(paperName || 'A4').trim().toLowerCase() === 'letter' ? 'Letter' : 'A4';
  const base = PAPER_SIZES_MM[key];
  const isLandscape = String(orientation || 'portrait').trim().toLowerCase() === 'landscape';
  return {
    name: base.name,
    orientation: isLandscape ? 'landscape' : 'portrait',
    widthMm: isLandscape ? base.heightMm : base.widthMm,
    heightMm: isLandscape ? base.widthMm : base.heightMm,
  };
}

/**
 * Computes the exact tile grid plan covering the full wall (plus dot-radius bleed padding)
 * so every dot—including the 2x origin dot at (0,0)—prints unclipped and tiles stitch
 * seamlessly across `overlapMm`.
 */
export function generateTilePlan(layout, opts = {}) {
  const paper = resolvePaper(opts.paper || 'A4', opts.orientation || 'portrait');
  const marginMm = typeof opts.marginMm === 'number' && opts.marginMm >= 0 ? opts.marginMm : 10.0;
  const overlapMm = typeof opts.overlapMm === 'number' && opts.overlapMm >= 0 ? opts.overlapMm : 10.0;

  const contentWmm = roundMm(paper.widthMm - 2 * marginMm);
  const contentHmm = roundMm(paper.heightMm - 2 * marginMm);
  if (contentWmm <= overlapMm || contentHmm <= overlapMm) {
    throw new Error('Printable content area must exceed overlapMm on both axes');
  }
  const stepXmm = roundMm(contentWmm - overlapMm);
  const stepYmm = roundMm(contentHmm - overlapMm);

  let maxRadiusMm = 0;
  for (let i = 0; i < layout.dots.length; i++) {
    const rMm = (layout.dots[i].diameterIn * MM_PER_INCH) * 0.5;
    if (rMm > maxRadiusMm) maxRadiusMm = rMm;
  }
  const bleedMm = Math.ceil(maxRadiusMm + 4);

  let minXmm = 0;
  let minYmm = 0;
  let maxXmm = layout.wallWidthIn * MM_PER_INCH;
  let maxYmm = layout.wallHeightIn * MM_PER_INCH;
  for (let i = 0; i < layout.dots.length; i++) {
    const xMm = layout.dots[i].x * MM_PER_INCH;
    const yMm = layout.dots[i].y * MM_PER_INCH;
    if (xMm < minXmm) minXmm = xMm;
    if (yMm < minYmm) minYmm = yMm;
    if (xMm > maxXmm) maxXmm = xMm;
    if (yMm > maxYmm) maxYmm = yMm;
  }

  const wallMinXmm = roundMm(minXmm - bleedMm);
  const wallMinYmm = roundMm(minYmm - bleedMm);
  const wallMaxXmm = roundMm(maxXmm + bleedMm);
  const wallMaxYmm = roundMm(maxYmm + bleedMm);

  const spanWmm = wallMaxXmm - wallMinXmm;
  const spanHmm = wallMaxYmm - wallMinYmm;

  const tileCols = spanWmm <= contentWmm + 1e-6
    ? 1
    : 1 + Math.ceil((spanWmm - contentWmm - 1e-6) / stepXmm);
  const tileRows = spanHmm <= contentHmm + 1e-6
    ? 1
    : 1 + Math.ceil((spanHmm - contentHmm - 1e-6) / stepYmm);

  const tiles = [];
  const totalTiles = tileRows * tileCols;

  for (let tr = 0; tr < tileRows; tr++) {
    for (let tc = 0; tc < tileCols; tc++) {
      const originXmm = roundMm(wallMinXmm + tc * stepXmm);
      const originYmm = roundMm(wallMinYmm + tr * stepYmm);
      const endXmm = roundMm(originXmm + contentWmm);
      const endYmm = roundMm(originYmm + contentHmm);

      const tileDots = [];
      for (let i = 0; i < layout.dots.length; i++) {
        const d = layout.dots[i];
        const xMm = d.x * MM_PER_INCH;
        const yMm = d.y * MM_PER_INCH;
        const rMm = (d.diameterIn * MM_PER_INCH) * 0.5;

        const intersects = (
          xMm + rMm >= originXmm - 1e-6 &&
          xMm - rMm <= endXmm + 1e-6 &&
          yMm + rMm >= originYmm - 1e-6 &&
          yMm - rMm <= endYmm + 1e-6
        );
        if (!intersects) continue;

        const centerInTile = (
          xMm >= originXmm - 1e-6 &&
          xMm <= endXmm + 1e-6 &&
          yMm >= originYmm - 1e-6 &&
          yMm <= endYmm + 1e-6
        );

        tileDots.push({
          dot: d,
          svgXmm: roundMm(marginMm + (xMm - originXmm)),
          svgYmm: roundMm(marginMm + (yMm - originYmm)),
          svgRmm: roundMm(rMm),
          centerInTile,
        });
      }

      const index = tr * tileCols + tc + 1;
      const label = `R${tr + 1}C${tc + 1}`;
      tiles.push({
        row: tr,
        col: tc,
        index,
        totalTiles,
        label,
        filename: `tile-${label}.svg`,
        originXmm,
        originYmm,
        endXmm,
        endYmm,
        dots: tileDots,
        hasLeftNeighbor: tc > 0,
        hasRightNeighbor: tc < tileCols - 1,
        hasTopNeighbor: tr > 0,
        hasBottomNeighbor: tr < tileRows - 1,
      });
    }
  }

  return {
    paper,
    marginMm,
    overlapMm,
    contentWmm,
    contentHmm,
    stepXmm,
    stepYmm,
    bleedMm,
    wallMinXmm,
    wallMinYmm,
    wallMaxXmm,
    wallMaxYmm,
    tileRows,
    tileCols,
    totalTiles,
    tiles,
  };
}

function renderRegistrationMark(x, y, size = 3.5) {
  const s = fmtMm(size);
  const cx = fmtMm(x);
  const cy = fmtMm(y);
  const x1 = fmtMm(x - size);
  const x2 = fmtMm(x + size);
  const y1 = fmtMm(y - size);
  const y2 = fmtMm(y + size);
  const r = fmtMm(size * 0.45);
  return (
    `    <g class="reg-mark" stroke="#444444" stroke-width="0.25" fill="none">\n` +
    `      <line x1="${x1}" y1="${cy}" x2="${x2}" y2="${cy}"/>\n` +
    `      <line x1="${cx}" y1="${y1}" x2="${cx}" y2="${y2}"/>\n` +
    `      <circle cx="${cx}" cy="${cy}" r="${r}"/>\n` +
    `    </g>\n`
  );
}

/**
 * Renders one tile as an exact 1:1 physical-scale SVG string (`mm` units).
 */
export function renderTileSvg(tile, layout, plan) {
  const { paper, marginMm, overlapMm, contentWmm, contentHmm, stepXmm, stepYmm } = plan;
  const isLightOnDark = layout.config.polarity === 'light-on-dark';
  const bgColor = isLightOnDark ? '#111111' : '#ffffff';
  const dotFill = isLightOnDark ? '#ffffff' : '#000000';
  const coordColor = isLightOnDark ? '#888888' : '#777777';
  const gridColor = isLightOnDark ? '#2e2e2e' : '#dcdcdc';

  const leftX = marginMm;
  const topY = marginMm;
  const rightX = roundMm(marginMm + contentWmm);
  const bottomY = roundMm(marginMm + contentHmm);

  const lines = [];
  lines.push(`<?xml version="1.0" encoding="UTF-8"?>`);
  lines.push(
    `<svg xmlns="http://www.w3.org/2000/svg"` +
    ` width="${fmtMm(paper.widthMm)}mm"` +
    ` height="${fmtMm(paper.heightMm)}mm"` +
    ` viewBox="0 0 ${fmtMm(paper.widthMm)} ${fmtMm(paper.heightMm)}"` +
    ` data-layout-id="${escapeXml(layout.layoutId)}"` +
    ` data-tier="${escapeXml(layout.config.tier)}"` +
    ` data-paper="${escapeXml(paper.name)}"` +
    ` data-tile-label="${escapeXml(tile.label)}"` +
    ` data-tile-row="${tile.row}"` +
    ` data-tile-col="${tile.col}"` +
    ` data-tile-index="${tile.index}"` +
    ` data-tile-total="${tile.totalTiles}"` +
    ` data-origin-x-mm="${fmtMm(tile.originXmm)}"` +
    ` data-origin-y-mm="${fmtMm(tile.originYmm)}"` +
    ` data-margin-mm="${fmtMm(marginMm)}"` +
    ` data-overlap-mm="${fmtMm(overlapMm)}"` +
    ` data-step-x-mm="${fmtMm(stepXmm)}"` +
    ` data-step-y-mm="${fmtMm(stepYmm)}">`
  );

  lines.push(`  <title>DBC AR Wall Tile ${escapeXml(tile.label)} (${tile.index}/${tile.totalTiles}) — 1:1 Scale</title>`);
  lines.push(`  <defs>`);
  lines.push(`    <clipPath id="tile-content-clip">`);
  lines.push(`      <rect x="${fmtMm(leftX)}" y="${fmtMm(topY)}" width="${fmtMm(contentWmm)}" height="${fmtMm(contentHmm)}"/>`);
  lines.push(`    </clipPath>`);
  lines.push(`  </defs>`);

  // Page & printable background
  lines.push(`  <rect x="0" y="0" width="${fmtMm(paper.widthMm)}" height="${fmtMm(paper.heightMm)}" fill="#ffffff"/>`);
  lines.push(`  <rect x="${fmtMm(leftX)}" y="${fmtMm(topY)}" width="${fmtMm(contentWmm)}" height="${fmtMm(contentHmm)}" fill="${bgColor}" stroke="#888888" stroke-width="0.2"/>`);

  // Clipped wall-space content (tote reference lines + marker dots + coordinate annotations)
  lines.push(`  <g clip-path="url(#tile-content-clip)">`);

  // Faint tote grid reference lines
  lines.push(`    <g class="tote-grid" stroke="${gridColor}" stroke-width="0.2" stroke-dasharray="2 2">`);
  const wallY0svg = roundMm(marginMm + (0 - tile.originYmm));
  const wallY1svg = roundMm(marginMm + (layout.wallHeightIn * MM_PER_INCH - tile.originYmm));
  const wallX0svg = roundMm(marginMm + (0 - tile.originXmm));
  const wallX1svg = roundMm(marginMm + (layout.wallWidthIn * MM_PER_INCH - tile.originXmm));

  for (let c = 0; c < layout.toteNominalXs.length; c++) {
    const xMm = layout.toteNominalXs[c] * MM_PER_INCH;
    if (xMm >= tile.originXmm - 1 && xMm <= tile.endXmm + 1) {
      const sx = fmtMm(marginMm + (xMm - tile.originXmm));
      lines.push(`      <line x1="${sx}" y1="${fmtMm(wallY0svg)}" x2="${sx}" y2="${fmtMm(wallY1svg)}"/>`);
    }
  }
  for (let r = 0; r < layout.toteNominalYs.length; r++) {
    const yMm = layout.toteNominalYs[r] * MM_PER_INCH;
    if (yMm >= tile.originYmm - 1 && yMm <= tile.endYmm + 1) {
      const sy = fmtMm(marginMm + (yMm - tile.originYmm));
      lines.push(`      <line x1="${fmtMm(wallX0svg)}" y1="${sy}" x2="${fmtMm(wallX1svg)}" y2="${sy}"/>`);
    }
  }
  lines.push(`    </g>`);

  // Solid marker dots
  lines.push(`    <g class="ar-dots">`);
  for (let i = 0; i < tile.dots.length; i++) {
    const td = tile.dots[i];
    const d = td.dot;
    const lm = d.landmark || 'none';
    lines.push(
      `      <circle` +
      ` cx="${fmtMm(td.svgXmm)}"` +
      ` cy="${fmtMm(td.svgYmm)}"` +
      ` r="${fmtMm(td.svgRmm)}"` +
      ` fill="${dotFill}"` +
      ` data-dot-id="${escapeXml(d.id)}"` +
      ` data-role="${escapeXml(d.role)}"` +
      ` data-landmark="${escapeXml(lm)}"` +
      ` data-wall-x-in="${fmtIn(d.x)}"` +
      ` data-wall-y-in="${fmtIn(d.y)}"` +
      ` data-diameter-in="${fmtIn(d.diameterIn)}"` +
      ` data-center-in-tile="${td.centerInTile ? 'true' : 'false'}"/>`
    );
  }
  lines.push(`    </g>`);

  // Printed wall coordinates beside each dot whose centre lies on this tile
  lines.push(`    <g class="dot-labels" font-family="monospace" font-size="2.4" fill="${coordColor}">`);
  for (let i = 0; i < tile.dots.length; i++) {
    const td = tile.dots[i];
    if (!td.centerInTile) continue;
    const d = td.dot;
    const tx = fmtMm(td.svgXmm + td.svgRmm + 1.5);
    const ty = fmtMm(td.svgYmm + 0.8);
    const tag = d.landmark ? ` [${d.landmark.toUpperCase()}]` : '';
    const text = `(${fmtIn(d.x)}", ${fmtIn(d.y)}")${tag}`;
    lines.push(`      <text x="${tx}" y="${ty}">${escapeXml(text)}</text>`);
  }
  lines.push(`    </g>`);
  lines.push(`  </g>`);

  // Overlap trim lines & registration marks
  lines.push(`  <g class="overlap-guides" stroke="#999999" stroke-width="0.2" stroke-dasharray="1.5 1.5" fill="none">`);
  if (tile.hasLeftNeighbor) {
    const gx = fmtMm(leftX + overlapMm);
    lines.push(`    <line x1="${gx}" y1="${fmtMm(topY)}" x2="${gx}" y2="${fmtMm(bottomY)}"/>`);
  }
  if (tile.hasRightNeighbor) {
    const gx = fmtMm(rightX - overlapMm);
    lines.push(`    <line x1="${gx}" y1="${fmtMm(topY)}" x2="${gx}" y2="${fmtMm(bottomY)}"/>`);
  }
  if (tile.hasTopNeighbor) {
    const gy = fmtMm(topY + overlapMm);
    lines.push(`    <line x1="${fmtMm(leftX)}" y1="${gy}" x2="${fmtMm(rightX)}" y2="${gy}"/>`);
  }
  if (tile.hasBottomNeighbor) {
    const gy = fmtMm(bottomY - overlapMm);
    lines.push(`    <line x1="${fmtMm(leftX)}" y1="${gy}" x2="${fmtMm(rightX)}" y2="${gy}"/>`);
  }
  lines.push(`  </g>`);

  // Crop & registration crosshairs at all 4 content corners (plus overlap intersections)
  lines.push(`  <g class="registration-marks">`);
  lines.push(renderRegistrationMark(leftX, topY).trimEnd());
  lines.push(renderRegistrationMark(rightX, topY).trimEnd());
  lines.push(renderRegistrationMark(leftX, bottomY).trimEnd());
  lines.push(renderRegistrationMark(rightX, bottomY).trimEnd());
  if (tile.hasRightNeighbor) {
    lines.push(renderRegistrationMark(rightX - overlapMm, topY, 2.5).trimEnd());
    lines.push(renderRegistrationMark(rightX - overlapMm, bottomY, 2.5).trimEnd());
  }
  if (tile.hasLeftNeighbor) {
    lines.push(renderRegistrationMark(leftX + overlapMm, topY, 2.5).trimEnd());
    lines.push(renderRegistrationMark(leftX + overlapMm, bottomY, 2.5).trimEnd());
  }
  if (tile.hasBottomNeighbor) {
    lines.push(renderRegistrationMark(leftX, bottomY - overlapMm, 2.5).trimEnd());
    lines.push(renderRegistrationMark(rightX, bottomY - overlapMm, 2.5).trimEnd());
  }
  if (tile.hasTopNeighbor) {
    lines.push(renderRegistrationMark(leftX, topY + overlapMm, 2.5).trimEnd());
    lines.push(renderRegistrationMark(rightX, topY + overlapMm, 2.5).trimEnd());
  }
  lines.push(`  </g>`);

  // Header & Footer metadata inside page margins
  const headerText =
    `Tile ${tile.label} (${tile.index}/${tile.totalTiles}) | ${layout.layoutId} | ` +
    `${paper.name} 1:1 (PRINT AT 100%) | Overlap ${fmtMm(overlapMm)}mm`;
  lines.push(
    `  <text x="${fmtMm(leftX)}" y="${fmtMm(Math.max(4.5, topY - 3))}" font-family="monospace" font-size="3" fill="#222222">` +
    `${escapeXml(headerText)}</text>`
  );

  const rangeText =
    `Wall X: ${fmtIn(tile.originXmm / MM_PER_INCH)}"..${fmtIn(tile.endXmm / MM_PER_INCH)}"  ` +
    `Y: ${fmtIn(tile.originYmm / MM_PER_INCH)}"..${fmtIn(tile.endYmm / MM_PER_INCH)}"  ` +
    `Dots: ${tile.dots.filter((d) => d.centerInTile).length}`;
  const footerY = roundMm(Math.min(paper.heightMm - 3.2, bottomY + 5.5));
  lines.push(
    `  <text x="${fmtMm(leftX)}" y="${fmtMm(footerY)}" font-family="monospace" font-size="2.8" fill="#333333">` +
    `${escapeXml(rangeText)}</text>`
  );

  // 50 mm scale check bar on right side of bottom margin
  const barLen = 50;
  const barX2 = rightX;
  const barX1 = roundMm(barX2 - barLen);
  const barY = roundMm(bottomY + 4.5);
  lines.push(`  <g class="scale-bar" stroke="#000000" stroke-width="0.4">`);
  lines.push(`    <line x1="${fmtMm(barX1)}" y1="${fmtMm(barY)}" x2="${fmtMm(barX2)}" y2="${fmtMm(barY)}"/>`);
  lines.push(`    <line x1="${fmtMm(barX1)}" y1="${fmtMm(barY - 1.5)}" x2="${fmtMm(barX1)}" y2="${fmtMm(barY + 1.5)}"/>`);
  lines.push(`    <line x1="${fmtMm(barX2)}" y1="${fmtMm(barY - 1.5)}" x2="${fmtMm(barX2)}" y2="${fmtMm(barY + 1.5)}"/>`);
  lines.push(`    <text x="${fmtMm(barX1 - 2)}" y="${fmtMm(barY + 1)}" text-anchor="end" font-family="monospace" font-size="2.6" stroke="none" fill="#000000">50mm check</text>`);
  lines.push(`  </g>`);

  lines.push(`</svg>`);
  return lines.join('\n') + '\n';
}

/**
 * Renders a one-page scaled tiling overview SVG for assembling tiles on the wall.
 */
export function renderOverviewSvg(layout, plan) {
  const { paper, tiles, wallMinXmm, wallMinYmm, wallMaxXmm, wallMaxYmm } = plan;
  const pageW = paper.widthMm;
  const pageH = paper.heightMm;
  const padX = 14;
  const padTop = 28;
  const padBottom = 22;

  // Bounding box of all tile rectangles
  let minX = wallMinXmm;
  let minY = wallMinYmm;
  let maxX = wallMaxXmm;
  let maxY = wallMaxYmm;
  for (let i = 0; i < tiles.length; i++) {
    if (tiles[i].endXmm > maxX) maxX = tiles[i].endXmm;
    if (tiles[i].endYmm > maxY) maxY = tiles[i].endYmm;
  }

  const spanX = Math.max(1, maxX - minX);
  const spanY = Math.max(1, maxY - minY);
  const availW = pageW - 2 * padX;
  const availH = pageH - padTop - padBottom;
  const scale = Math.min(availW / spanX, availH / spanY);

  const ox = padX + (availW - spanX * scale) * 0.5;
  const oy = padTop + (availH - spanY * scale) * 0.5;
  const tx = (xMm) => roundMm(ox + (xMm - minX) * scale);
  const ty = (yMm) => roundMm(oy + (yMm - minY) * scale);

  const lines = [];
  lines.push(`<?xml version="1.0" encoding="UTF-8"?>`);
  lines.push(
    `<svg xmlns="http://www.w3.org/2000/svg"` +
    ` width="${fmtMm(pageW)}mm" height="${fmtMm(pageH)}mm"` +
    ` viewBox="0 0 ${fmtMm(pageW)} ${fmtMm(pageH)}"` +
    ` data-overview="true" data-layout-id="${escapeXml(layout.layoutId)}">`
  );
  lines.push(`  <rect x="0" y="0" width="${fmtMm(pageW)}" height="${fmtMm(pageH)}" fill="#ffffff"/>`);
  lines.push(`  <text x="${fmtMm(padX)}" y="11" font-family="sans-serif" font-size="5" font-weight="bold" fill="#111111">DBC AR Wall Tiling Overview — NOT TO SCALE</text>`);
  lines.push(
    `  <text x="${fmtMm(padX)}" y="17.5" font-family="monospace" font-size="3" fill="#444444">` +
    `${escapeXml(layout.layoutId)} | Wall ${fmtIn(layout.wallWidthIn)}" x ${fmtIn(layout.wallHeightIn)}" | ` +
    `${plan.tileRows}x${plan.tileCols} = ${plan.totalTiles} ${paper.name} tiles (overlap ${fmtMm(plan.overlapMm)}mm)</text>`
  );

  // Wall outer border & tote grid
  const wx0 = tx(0);
  const wy0 = ty(0);
  const ww = roundMm(layout.wallWidthIn * MM_PER_INCH * scale);
  const wh = roundMm(layout.wallHeightIn * MM_PER_INCH * scale);
  lines.push(`  <rect x="${fmtMm(wx0)}" y="${fmtMm(wy0)}" width="${fmtMm(ww)}" height="${fmtMm(wh)}" fill="#f8fafc" stroke="#1e293b" stroke-width="0.4"/>`);

  lines.push(`  <g stroke="#94a3b8" stroke-width="0.2">`);
  for (let c = 1; c < layout.toteNominalXs.length - 1; c++) {
    const x = fmtMm(tx(layout.toteNominalXs[c] * MM_PER_INCH));
    lines.push(`    <line x1="${x}" y1="${fmtMm(wy0)}" x2="${x}" y2="${fmtMm(wy0 + wh)}"/>`);
  }
  for (let r = 1; r < layout.toteNominalYs.length - 1; r++) {
    const y = fmtMm(ty(layout.toteNominalYs[r] * MM_PER_INCH));
    lines.push(`    <line x1="${fmtMm(wx0)}" y1="${y}" x2="${fmtMm(wx0 + ww)}" y2="${y}"/>`);
  }
  lines.push(`  </g>`);

  // Tile outlines & labels
  lines.push(`  <g class="overview-tiles">`);
  for (let i = 0; i < tiles.length; i++) {
    const t = tiles[i];
    const x = tx(t.originXmm);
    const y = ty(t.originYmm);
    const w = roundMm((t.endXmm - t.originXmm) * scale);
    const h = roundMm((t.endYmm - t.originYmm) * scale);
    lines.push(
      `    <rect x="${fmtMm(x)}" y="${fmtMm(y)}" width="${fmtMm(w)}" height="${fmtMm(h)}"` +
      ` fill="none" stroke="#2563eb" stroke-width="0.3" stroke-dasharray="1.5 1" data-tile-label="${escapeXml(t.label)}"/>`
    );
    lines.push(
      `    <text x="${fmtMm(x + 1.5)}" y="${fmtMm(y + 4)}" font-family="monospace" font-size="2.8" fill="#1d4ed8">${escapeXml(t.label)}</text>`
    );
  }
  lines.push(`  </g>`);

  // Dots
  lines.push(`  <g class="overview-dots">`);
  for (let i = 0; i < layout.dots.length; i++) {
    const d = layout.dots[i];
    const cx = tx(d.x * MM_PER_INCH);
    const cy = ty(d.y * MM_PER_INCH);
    const r = Math.max(0.6, roundMm((d.diameterIn * MM_PER_INCH * 0.5) * scale));
    const fill = d.landmark === 'origin'
      ? '#dc2626'
      : (d.landmark === 'axis' ? '#d97706' : (d.landmark === 'corner' ? '#0f766e' : '#111111'));
    lines.push(`    <circle cx="${fmtMm(cx)}" cy="${fmtMm(cy)}" r="${fmtMm(r)}" fill="${fill}"/>`);
  }
  lines.push(`  </g>`);

  // Legend
  const ly = pageH - 12;
  lines.push(
    `  <text x="${fmtMm(padX)}" y="${fmtMm(ly)}" font-family="monospace" font-size="2.8" fill="#333333">` +
    `Legend: RED=Origin(2x)  AMBER=Axis(1.5x)  TEAL=Tier-B Corner(1.25x)  BLACK=Standard(1x)  BLUE DASH=Tile bounds</text>`
  );
  lines.push(`</svg>`);
  return lines.join('\n') + '\n';
}

/**
 * Renders a plain-text hand-draw coordinate table (for marking Tier A or any layout with a ruler).
 */
export function renderHandDrawSheet(layout) {
  const c = layout.config;
  const out = [];
  out.push(`DBC AR WALL — HAND-DRAW RULER COORDINATE SHEET`);
  out.push(`==============================================`);
  out.push(`Layout ID : ${layout.layoutId}`);
  out.push(`Tier      : ${c.tier}   Grid: ${c.cols} cols x ${c.rows} rows   Pitch: ${c.pitchX}" x ${c.pitchY}" (${c.provenance})`);
  out.push(`Wall Size : ${fmtIn(layout.wallWidthIn)}" x ${fmtIn(layout.wallHeightIn)}" (${fmtMm(layout.wallWidthIn * MM_PER_INCH)} mm x ${fmtMm(layout.wallHeightIn * MM_PER_INCH)} mm)`);
  out.push(`Polarity  : ${c.polarity}   Nominal Dot Diameter: ${fmtIn(c.dotDiameterIn)}" (${fmtMm(c.dotDiameterIn * MM_PER_INCH)} mm)`);
  out.push(`Frame     : Origin (0, 0) at top-left outer corner; +X right, +Y down.`);
  out.push(`Landmarks : ORIGIN = x2.0 (${fmtIn(c.dotDiameterIn * 2)}"), AXIS = x1.5 (${fmtIn(c.dotDiameterIn * 1.5)}"), Tier-B CORNER = x1.25 (${fmtIn(c.dotDiameterIn * 1.25)}").`);
  out.push(``);
  out.push(`ID                 Role          Landmark  Dia(in)  Dia(mm)    X(in)    X(mm)    Y(in)    Y(mm)  Meas X    Meas Y`);
  out.push(`-----------------  ------------  --------  -------  -------  -------  -------  -------  -------  --------  --------`);

  for (let i = 0; i < layout.dots.length; i++) {
    const d = layout.dots[i];
    const row = [
      d.id.padEnd(17),
      d.role.padEnd(12),
      (d.landmark || '-').padEnd(8),
      fmtIn(d.diameterIn).padStart(7),
      (d.diameterIn * MM_PER_INCH).toFixed(1).padStart(7),
      fmtIn(d.x).padStart(7),
      (d.x * MM_PER_INCH).toFixed(1).padStart(7),
      fmtIn(d.y).padStart(7),
      (d.y * MM_PER_INCH).toFixed(1).padStart(7),
      '________',
      '________',
    ].join('  ');
    out.push(row);
  }
  out.push(``);
  out.push(`Total dots: ${layout.dots.length} (corners=${layout.counts.corners}, label-offset=${layout.counts.labelOffsets}, grid=${layout.counts.gridDots})`);
  out.push(`After marking, measure actual column Xs and row Ys with a tape measure and enter them in ar.html Layout Editor.`);
  return out.join('\n') + '\n';
}

/**
 * Renders a printable SVG hand-draw coordinate table.
 */
export function renderHandDrawSheetSvg(layout, paperOpt = 'A4') {
  const paper = resolvePaper(paperOpt, 'portrait');
  const rowsPerPage = 52;
  const showDots = layout.dots.slice(0, rowsPerPage);
  const lines = [];
  lines.push(`<?xml version="1.0" encoding="UTF-8"?>`);
  lines.push(
    `<svg xmlns="http://www.w3.org/2000/svg"` +
    ` width="${fmtMm(paper.widthMm)}mm" height="${fmtMm(paper.heightMm)}mm"` +
    ` viewBox="0 0 ${fmtMm(paper.widthMm)} ${fmtMm(paper.heightMm)}"` +
    ` data-hand-draw-sheet="true" data-layout-id="${escapeXml(layout.layoutId)}">`
  );
  lines.push(`  <rect x="0" y="0" width="${fmtMm(paper.widthMm)}" height="${fmtMm(paper.heightMm)}" fill="#ffffff"/>`);
  lines.push(`  <text x="12" y="14" font-family="sans-serif" font-size="5" font-weight="bold" fill="#111111">DBC AR Wall — Hand-Draw Ruler Coordinate Table</text>`);
  lines.push(
    `  <text x="12" y="20" font-family="monospace" font-size="3" fill="#444444">` +
    `${escapeXml(layout.layoutId)} | Origin (0,0) top-left, +X right, +Y down | Polarity: ${escapeXml(layout.config.polarity)}</text>`
  );

  let y = 28;
  lines.push(`  <g font-family="monospace" font-size="2.7" fill="#111111">`);
  lines.push(`    <text x="12" y="${fmtMm(y)}" font-weight="bold">ID                Role          Landmark  Dia(in)   X(in)    Y(in)    X(mm)    Y(mm)   Meas X    Meas Y</text>`);
  y += 2;
  lines.push(`    <line x1="12" y1="${fmtMm(y)}" x2="${fmtMm(paper.widthMm - 12)}" y2="${fmtMm(y)}" stroke="#444444" stroke-width="0.3"/>`);
  y += 4.2;

  for (let i = 0; i < showDots.length; i++) {
    const d = showDots[i];
    const rowStr =
      `${d.id.padEnd(17)} ${d.role.padEnd(13)} ${(d.landmark || '-').padEnd(9)} ` +
      `${fmtIn(d.diameterIn).padStart(6)}"  ${fmtIn(d.x).padStart(6)}"  ${fmtIn(d.y).padStart(6)}"  ` +
      `${(d.x * MM_PER_INCH).toFixed(1).padStart(6)}   ${(d.y * MM_PER_INCH).toFixed(1).padStart(6)}   ______    ______`;
    lines.push(`    <text x="12" y="${fmtMm(y)}">${escapeXml(rowStr)}</text>`);
    y += 4.6;
  }

  if (layout.dots.length > showDots.length) {
    lines.push(
      `    <text x="12" y="${fmtMm(y + 2)}" fill="#555555">` +
      `Showing first ${showDots.length} of ${layout.dots.length} dots; see hand-draw-sheet.txt for the full table.</text>`
    );
  }
  lines.push(`  </g>`);
  lines.push(`</svg>`);
  return lines.join('\n') + '\n';
}

/**
 * Generates all marker artifacts in memory (pure, deterministic, zero disk I/O).
 */
export function generateMarkerArtifacts(opts = {}) {
  const layout = opts.layout || createArLayout({
    cols: opts.cols,
    rows: opts.rows,
    pitchX: opts.pitchX,
    pitchY: opts.pitchY,
    tier: opts.tier || 'B',
    spacingIn: opts.spacingIn ?? opts.s ?? null,
    dotDiameterIn: opts.dotDiameterIn,
    polarity: opts.polarity,
    measured: opts.measured,
  });

  const plan = generateTilePlan(layout, {
    paper: opts.paper || 'A4',
    orientation: opts.orientation || 'portrait',
    marginMm: opts.marginMm,
    overlapMm: opts.overlapMm,
  });

  const files = [];

  if (opts.includeTiles !== false) {
    for (let i = 0; i < plan.tiles.length; i++) {
      const tile = plan.tiles[i];
      files.push({
        name: tile.filename,
        kind: 'tile',
        tile,
        content: renderTileSvg(tile, layout, plan),
      });
    }
  }

  if (opts.includeOverview !== false) {
    files.push({
      name: 'overview.svg',
      kind: 'overview',
      content: renderOverviewSvg(layout, plan),
    });
  }

  if (opts.includeHandDraw !== false) {
    files.push({
      name: 'hand-draw-sheet.txt',
      kind: 'hand-draw-txt',
      content: renderHandDrawSheet(layout),
    });
    files.push({
      name: 'hand-draw-sheet.svg',
      kind: 'hand-draw-svg',
      content: renderHandDrawSheetSvg(layout, plan.paper.name),
    });
  }

  files.push({
    name: 'layout.json',
    kind: 'layout-json',
    content: JSON.stringify(serializeArLayout(layout), null, 2) + '\n',
  });

  return { layout, plan, files };
}

/**
 * Parses CLI flags into options for `generateMarkerArtifacts`.
 */
export function parseCliArgs(argv) {
  const opts = {
    pitchX: 16,
    pitchY: 14,
    cols: 4,
    rows: 4,
    tier: 'B',
    paper: 'A4',
    orientation: 'portrait',
    spacingIn: null,
    dotDiameterIn: 1.0,
    polarity: 'dark-on-light',
    overlapMm: 10,
    marginMm: 10,
    outDir: 'out/ar-markers',
    includeOverview: true,
    includeTiles: true,
    includeHandDraw: true,
    help: false,
  };

  const nextVal = (i) => {
    const arg = argv[i];
    const eq = arg.indexOf('=');
    if (eq >= 0) return { val: arg.slice(eq + 1), step: 0 };
    return { val: argv[i + 1], step: 1 };
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') {
      opts.help = true;
    } else if (a === '--no-overview') {
      opts.includeOverview = false;
    } else if (a === '--overview') {
      opts.includeOverview = true;
    } else if (a === '--no-tiles') {
      opts.includeTiles = false;
    } else if (a === '--no-hand-draw') {
      opts.includeHandDraw = false;
    } else if (a === '--hand-draw') {
      opts.includeHandDraw = true;
    } else if (a === '--pitchX' || a.startsWith('--pitchX=')) {
      const { val, step } = nextVal(i); i += step;
      opts.pitchX = Number(val);
    } else if (a === '--pitchY' || a.startsWith('--pitchY=')) {
      const { val, step } = nextVal(i); i += step;
      opts.pitchY = Number(val);
    } else if (a === '--cols' || a.startsWith('--cols=')) {
      const { val, step } = nextVal(i); i += step;
      opts.cols = Number.parseInt(val, 10);
    } else if (a === '--rows' || a.startsWith('--rows=')) {
      const { val, step } = nextVal(i); i += step;
      opts.rows = Number.parseInt(val, 10);
    } else if (a === '--tier' || a.startsWith('--tier=')) {
      const { val, step } = nextVal(i); i += step;
      opts.tier = String(val || 'B').toUpperCase();
    } else if (a === '--paper' || a.startsWith('--paper=')) {
      const { val, step } = nextVal(i); i += step;
      opts.paper = String(val || 'A4');
    } else if (a === '--orientation' || a.startsWith('--orientation=')) {
      const { val, step } = nextVal(i); i += step;
      opts.orientation = String(val || 'portrait');
    } else if (a === '--s' || a.startsWith('--s=') || a === '--spacing' || a.startsWith('--spacing=')) {
      const { val, step } = nextVal(i); i += step;
      opts.spacingIn = Number(val);
    } else if (a === '--dotDiameter' || a.startsWith('--dotDiameter=')) {
      const { val, step } = nextVal(i); i += step;
      opts.dotDiameterIn = Number(val);
    } else if (a === '--polarity' || a.startsWith('--polarity=')) {
      const { val, step } = nextVal(i); i += step;
      opts.polarity = String(val || 'dark-on-light');
    } else if (a === '--overlapMm' || a.startsWith('--overlapMm=')) {
      const { val, step } = nextVal(i); i += step;
      opts.overlapMm = Number(val);
    } else if (a === '--marginMm' || a.startsWith('--marginMm=')) {
      const { val, step } = nextVal(i); i += step;
      opts.marginMm = Number(val);
    } else if (a === '--out' || a.startsWith('--out=')) {
      const { val, step } = nextVal(i); i += step;
      opts.outDir = String(val || 'out/ar-markers');
    }
  }
  return opts;
}

/**
 * Writes generated marker SVGs, hand-draw sheets, overview, and layout JSON to `outDir`.
 */
export function writeMarkerArtifacts(opts = {}) {
  const outDir = resolve(opts.outDir || 'out/ar-markers');
  const artifacts = generateMarkerArtifacts(opts);
  mkdirSync(outDir, { recursive: true });
  for (let i = 0; i < artifacts.files.length; i++) {
    const f = artifacts.files[i];
    writeFileSync(join(outDir, f.name), f.content, 'utf8');
  }
  return { outDir, ...artifacts };
}

function main() {
  const cli = parseCliArgs(process.argv.slice(2));
  if (cli.help) {
    console.log(
      'Usage: node tools/ar-markers.mjs [--pitchX 16] [--pitchY 14] [--cols 4] [--rows 4]\n' +
      '       [--tier A|B] [--paper A4|Letter] [--orientation portrait|landscape]\n' +
      '       [--s <in>] [--dotDiameter 1.0] [--polarity dark-on-light|light-on-dark]\n' +
      '       [--overlapMm 10] [--marginMm 10] [--out out/ar-markers] [--no-overview]'
    );
    return;
  }
  const res = writeMarkerArtifacts(cli);
  console.log(
    `Generated ${res.files.length} files in ${res.outDir} ` +
    `(${res.layout.layoutId}, ${res.plan.tileRows}x${res.plan.tileCols} ${res.plan.paper.name} tiles, ` +
    `${res.layout.dots.length} dots).`
  );
}

const isDirectRun = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isDirectRun) {
  main();
}
