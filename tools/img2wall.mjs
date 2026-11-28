#!/usr/bin/env node
/**
 * L5 — photo to tote-wall texture (`tools/img2wall.mjs`).
 *
 * Takes a binary PGM (convert a photo once with any tool, e.g. `magick photo.jpg -colorspace Gray photo.pgm`)
 * plus the four corners of ONE tote face in the photo and writes a normalised luma texture and the measured
 * stats next to it:
 *   <out>.pgm.gz   the normalised texture (default 448 x 512 = 32 texels/in on the 14 x 16 in tote)
 *   <out>.json     `dbc-photo-wall` metadata: size, tote size in inches, corners, measured stats
 *                  (tote albedo, local contrast, label paper albedo, bar black level)
 * The label region you give (`--label`) is measured and then filled from its surroundings; the sim redraws the
 * barcode there with the measured paper/ink albedos.
 *
 * Usage:
 *   node tools/img2wall.mjs --in photo.pgm[.gz] --corners TLx,TLy,TRx,TRy,BRx,BRy,BLx,BLy --out tests/fixtures-sim/walls/name
 *        [--label u0,v0,u1,v1]      label rectangle in 0..1 texture coordinates (default: none)
 *        [--size 448x512] [--tote 14x16] [--name text]
 *
 * Use it in the sim: `loadWallFile('tests/fixtures-sim/walls/name')` -> `applySimPhotoWall(scene, { simPhotoWall: true, wall })`.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import {
  parsePgm, encodePgm, buildWallTexture, wallFromParts, wallMeta,
} from '../src/sim/photo-wall.js';

export function readMaybeGz(path) {
  const buf = readFileSync(path);
  return path.endsWith('.gz') ? gunzipSync(buf) : buf;
}

/** Writes `<base>.pgm.gz` and `<base>.json`. Returns the two paths. */
export function writeWallFiles(base, wall) {
  mkdirSync(dirname(resolve(base)), { recursive: true });
  const pgmPath = `${base}.pgm.gz`;
  const jsonPath = `${base}.json`;
  writeFileSync(pgmPath, gzipSync(Buffer.from(encodePgm(wall.width, wall.height, wall.data)), { level: 9, mtime: 0 }));
  writeFileSync(jsonPath, JSON.stringify(wallMeta(wall), null, 2) + '\n', 'utf8');
  return { pgmPath, jsonPath };
}

/** Loads a wall written by `writeWallFiles` (pass the path without extension). */
export function loadWallFile(base) {
  const meta = JSON.parse(readFileSync(`${base}.json`, 'utf8'));
  return wallFromParts(meta, new Uint8Array(readMaybeGz(`${base}.pgm.gz`)));
}

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq > 0) o[a.slice(2, eq)] = a.slice(eq + 1);
    else o[a.slice(2)] = argv[++i];
  }
  return o;
}

export function cornersFromString(s) {
  const n = String(s).split(',').map(Number);
  if (n.length !== 8 || n.some((v) => !Number.isFinite(v))) throw new Error('--corners needs 8 numbers: TLx,TLy,TRx,TRy,BRx,BRy,BLx,BLy');
  return [[n[0], n[1]], [n[2], n[3]], [n[4], n[5]], [n[6], n[7]]];
}

export function main(argv) {
  const o = parseArgs(argv);
  if (!o.in || !o.corners || !o.out) {
    console.error('usage: node tools/img2wall.mjs --in photo.pgm[.gz] --corners TLx,TLy,TRx,TRy,BRx,BRy,BLx,BLy --out <base> [--label u0,v0,u1,v1] [--size WxH] [--tote WxH] [--name text]');
    return 2;
  }
  const pgm = parsePgm(new Uint8Array(readMaybeGz(o.in)));
  const [outWidth, outHeight] = o.size ? o.size.split('x').map(Number) : [undefined, undefined];
  const [toteWidthIn, toteHeightIn] = o.tote ? o.tote.split('x').map(Number) : [undefined, undefined];
  let labelRect = null;
  if (o.label) {
    const [u0, v0, u1, v1] = o.label.split(',').map(Number);
    labelRect = { u0, v0, u1, v1 };
  }
  const wall = buildWallTexture({
    pgm, corners: cornersFromString(o.corners), outWidth, outHeight, toteWidthIn, toteHeightIn, labelRect,
    name: o.name || o.out.split('/').pop(), source: o.in.split('/').pop(),
  });
  const { pgmPath, jsonPath } = writeWallFiles(o.out, wall);
  console.log(`wrote ${pgmPath} and ${jsonPath}`);
  console.log(JSON.stringify(wall.stats));
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exit(main(process.argv.slice(2)));
}
