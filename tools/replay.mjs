#!/usr/bin/env node
/**
 * GR3 — Node.js `.dbct` Frame & Sensor Tape Replay Runner (`tools/replay.mjs`).
 *
 * Loads a `.dbct` v1 tape, decompresses every Y-plane frame, feeds it through the real
 * DBC worker pipeline (`processFrameMulti`), diffs decoded payloads against golden
 * recorded payloads, and exits non-zero if any golden payload regresses.
 *
 * Usage:
 *   node tools/replay.mjs path/to/tape.dbct [--flags=vertFallback,cribMatch] [--vertical]
 *   (flag-set scoring over tapes/*.dbct with the superset rule: tools/gate/tape-score.mjs)
 */

import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import {
  createPipelineState,
  createPipelineResult,
  processFrameMulti,
  extractMultiDetections,
} from '../src/worker/scanner.worker.js';
import { resolveFlags, flagsToWorkerMask } from '../src/flags.js';

/**
 * Parses a `.dbct` v1 Uint8Array into `{ header, frames }`.
 */
export function parseTapeBytes(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (u8.byteLength < 12) throw new Error('Tape too short');
  const magic = String.fromCharCode(u8[0], u8[1], u8[2], u8[3]);
  if (magic !== 'DBCT') throw new Error(`Invalid tape magic: ${magic}`);

  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const version = dv.getUint32(4, true);
  if (version !== 1) throw new Error(`Unsupported tape version: ${version}`);
  const headerLen = dv.getUint32(8, true);
  const decoder = new TextDecoder();
  const header = JSON.parse(decoder.decode(u8.subarray(12, 12 + headerLen)));

  const frames = [];
  let off = 12 + headerLen;
  while (off + 8 <= u8.byteLength) {
    const metaLen = dv.getUint32(off, true);
    const dataLen = dv.getUint32(off + 4, true);
    off += 8;
    const meta = JSON.parse(decoder.decode(u8.subarray(off, off + metaLen)));
    off += metaLen;
    const rawData = u8.subarray(off, off + dataLen);
    off += dataLen;
    const codec = meta.codec || header.codec || 'raw';
    const luma = codec === 'gzip' ? new Uint8Array(gunzipSync(rawData)) : new Uint8Array(rawData);
    frames.push({ meta, luma });
  }
  return { header, frames };
}

/**
 * Replays parsed tape frames through `processFrameMulti` and returns accuracy & timing summary.
 */
export function replayTape(parsed, workerFlagsMask = 0, opts = {}) {
  // T2: `opts.vertical` (true/false) sets the scanline stage's vertical mode like the live worker does
  // (undefined keeps the old behaviour: leave it untouched). Extra result fields are additive.
  const vertical = opts.vertical;
  const firstSeen = {};
  const payloadFrameCounts = {};
  const t0Ms = parsed.frames.length ? Number(parsed.frames[0].meta.tFrameMs) || 0 : 0;
  let state = null;
  const result = createPipelineResult();
  const times = [];
  let goldenTotal = 0;
  let goldenMatched = 0;
  let extraDecoded = 0;
  let missingPayloads = [];

  for (const frame of parsed.frames) {
    const w = frame.meta.width | 0;
    const h = frame.meta.height | 0;
    if (!state || state.width !== w || state.height !== h) {
      state = createPipelineState(w, h);
    }
    state.flags = workerFlagsMask | 0;
    if (vertical !== undefined) state.scanline.mode = vertical ? 1 : 0;
    const t0 = performance.now();
    processFrameMulti(frame.luma, w, h, state, result, true);
    times.push(performance.now() - t0);

    const dets = extractMultiDetections(state);
    const gotSet = new Set(dets.map((d) => d.payload));
    const exp = Array.isArray(frame.meta.expectedPayloads) ? frame.meta.expectedPayloads : [];
    for (const p of gotSet) {
      payloadFrameCounts[p] = (payloadFrameCounts[p] || 0) + 1;
      if (firstSeen[p] === undefined) {
        const tMs = Number(frame.meta.tFrameMs);
        firstSeen[p] = {
          frameIndex: times.length - 1,
          frameId: frame.meta.frameId,
          tSec: Number.isFinite(tMs) ? Math.round(((tMs - t0Ms) / 1000) * 1e4) / 1e4 : null,
        };
      }
    }

    for (const p of exp) {
      goldenTotal++;
      if (gotSet.has(p)) goldenMatched++;
      else missingPayloads.push({ frameId: frame.meta.frameId, payload: p });
    }
    for (const p of gotSet) {
      if (!exp.includes(p)) extraDecoded++;
    }
  }

  times.sort((a, b) => a - b);
  const p50 = times.length ? times[times.length >> 1] : 0;
  const p95 = times.length ? times[Math.min(times.length - 1, Math.floor(times.length * 0.95))] : 0;
  const pass = missingPayloads.length === 0;

  return {
    frameCount: parsed.frames.length,
    goldenTotal,
    goldenMatched,
    extraDecoded,
    missingPayloads,
    p50Ms: Math.round(p50 * 100) / 100,
    p95Ms: Math.round(p95 * 100) / 100,
    pass,
    // T2 additions
    maxMs: Math.round((times.length ? times[times.length - 1] : 0) * 100) / 100,
    decodedPayloads: Object.keys(payloadFrameCounts).sort(),
    payloadFrameCounts,
    firstSeen,
  };
}

/**
 * T2: the capture conditions a tape carries, `null` where the tape does not say (PP2 writes
 * fps/exposure/ISO into the tape; older tapes have none). Looks at the header meta, then the frame metas
 * (`camera` block from the AR recorder, `fps`), then derives fps from the frame timestamps.
 */
export function describeTapeCamera(parsed) {
  const hm = (parsed.header && parsed.header.meta) || {};
  const cam = hm.camera || (parsed.frames.length && parsed.frames[0].meta.camera) || {};
  const pick = (...vals) => {
    for (const v of vals) if (v !== undefined && v !== null && Number.isFinite(Number(v))) return Number(v);
    return null;
  };
  let derivedFps = null;
  const fr = parsed.frames;
  if (fr.length >= 2) {
    const dt = (Number(fr[fr.length - 1].meta.tFrameMs) - Number(fr[0].meta.tFrameMs)) / (fr.length - 1);
    if (Number.isFinite(dt) && dt > 0) derivedFps = Math.round((1000 / dt) * 100) / 100;
  }
  return {
    fps: pick(cam.fps, hm.fps, fr.length ? fr[0].meta.fps : null),
    derivedFps,
    exposureMs: pick(cam.exposureMs, hm.exposureMs),
    // MediaTrackSettings.exposureTime is browser-defined units (Chrome: 100 us), so it is passed through raw
    exposureTimeRaw: pick(cam.exposureTime),
    iso: pick(cam.iso, hm.iso),
    width: fr.length ? fr[0].meta.width | 0 : null,
    height: fr.length ? fr[0].meta.height | 0 : null,
  };
}

// CLI entrypoint
if (typeof process !== 'undefined' && process.argv[1] && process.argv[1].endsWith('replay.mjs')) {
  const args = process.argv.slice(2);
  const tapePath = args.find((a) => !a.startsWith('--'));
  const flagsArg = args.find((a) => a.startsWith('--flags='));
  if (!tapePath) {
    console.error('Usage: node tools/replay.mjs <file.dbct> [--flags=a,b]');
    process.exit(1);
  }
  const mask = flagsArg
    ? flagsToWorkerMask(resolveFlags({ search: `?flags=${flagsArg.slice('--flags='.length)}` }))
    : 0;
  const bytes = readFileSync(tapePath);
  const parsed = parseTapeBytes(bytes);
  const rep = replayTape(parsed, mask, args.includes('--vertical') ? { vertical: true } : {});
  console.log(
    `Replay ${tapePath}: frames=${rep.frameCount} golden=${rep.goldenMatched}/${rep.goldenTotal} ` +
    `extra=${rep.extraDecoded} p50=${rep.p50Ms}ms p95=${rep.p95Ms}ms -> ${rep.pass ? 'PASS' : 'FAIL'}`
  );
  process.exit(rep.pass ? 0 : 1);
}
