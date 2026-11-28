/**
 * C6 — Rear Lens Capability Probe & Standback Profile Selector (`lensProbe` flag).
 *
 * Reuses `src/diag/cameras.js` (`probeAllCameras`) without duplicating camera probing logic.
 * Reports cleanly whether a phone exposes an optical telephoto lens (e.g. 3x tele for Part 3
 * stand-back at 30 in) or has no reachable tele (e.g. Galaxy A53 5G -> selects main 1x `camera 0`).
 */

import { probeCameras } from '../diag/cameras.js';

export const LENS_PROBE_STORAGE_KEY = 'dbc.lensProbe';

function supports30InFocus(cam) {
  const caps = cam && cam.capabilities ? cam.capabilities : {};
  const fm = Array.isArray(caps.focusMode) ? caps.focusMode : [];
  if (fm.includes('continuous') || fm.includes('single-shot')) return true;
  if (caps.focusDistance && typeof caps.focusDistance === 'object') {
    const min = caps.focusDistance.min ?? 0;
    const max = caps.focusDistance.max ?? 0;
    // 30 in ≈ 0.76 m (or diopters ~1.31)
    if (max >= 0.76 && min <= 0.76) return true;
  }
  return false;
}

/**
 * Pure selection logic over probed camera entries (from `probeAllCameras()` or D1/D2 JSON).
 * On single-main-sensor phones like Galaxy A53 5G, cleanly reports `hasTele: false` and selects
 * the main 1x rear camera (`camera 0`) with continuous AF + torch over ultrawide `camera 2`.
 */
export function selectStandbackLens(cameras) {
  const rear = (cameras || []).filter((c) => c && c.facing === 'environment' && !c.error);
  if (rear.length === 0) {
    return {
      hasTele: false,
      profile: 'blocked',
      selectedCamera: null,
      reason: 'No rear camera detected',
    };
  }

  // 1. Check for dedicated optical telephoto camera supporting 30 in focus
  const dedicatedTele = rear.find((c) => c.roleGuess === 'TELE?' && supports30InFocus(c));
  if (dedicatedTele) {
    return {
      hasTele: true,
      profile: 'standback',
      selectedCamera: dedicatedTele,
      recommendedZoom: 1,
      reason: `Dedicated telephoto lens detected (${dedicatedTele.label}) with 30 in focus support`,
    };
  }

  // 2. PP1: Only accept logical tele when backed by verified tele evidence (separate device /
  // measured magnification >= 2x at zoom=1 / known model) — NEVER a zoom-sweep jump alone.
  const logicalTele = rear.find(
    (c) =>
      ((typeof c.measuredMagnification === 'number' && c.measuredMagnification >= 2.0) ||
        (c.zoomSweep &&
          (c.zoomSweep.teleEvidence === 'separate-device' ||
            c.zoomSweep.teleEvidence === 'measured-mag' ||
            c.zoomSweep.teleEvidence === 'known-model'))) &&
      supports30InFocus(c)
  );
  if (logicalTele) {
    return {
      hasTele: true,
      profile: 'standback',
      selectedCamera: logicalTele,
      recommendedZoom: Math.min(3, logicalTele.capabilities.zoom.max),
      reason: `Logical telephoto zoom handover detected on ${logicalTele.label}`,
    };
  }

  // 3. No optical tele -> pick best main 1x rear camera (prefer MAIN?, continuous AF, torch, camera 0)
  const ranked = rear.slice().sort((a, b) => {
    const score = (c) => {
      let s = 0;
      if (c.roleGuess === 'MAIN?') s += 40;
      const caps = c.capabilities || {};
      if (Array.isArray(caps.focusMode) && caps.focusMode.includes('continuous')) s += 30;
      if (caps.torch === true) s += 20;
      if (/camera\s*0\b/i.test(c.label || '')) s += 15;
      if (caps.width && caps.width.max) s += Math.min(10, caps.width.max / 500);
      return s;
    };
    return score(b) - score(a);
  });

  const mainCam = ranked[0];
  return {
    hasTele: false,
    profile: 'wall',
    selectedCamera: mainCam,
    recommendedZoom: 1,
    reason: `No optical tele lens detected; selected main 1x rear camera (${mainCam.label}) for close-range slide or cropped 4K`,
  };
}

/**
 * Runs the live rear lens probe in a browser and persists the selected camera summary.
 */
export async function runLensProbe(previewEl, opts = {}) {
  const { cameras } = await probeCameras(previewEl, opts);
  const result = selectStandbackLens(cameras);
  if (typeof localStorage !== 'undefined' && result.selectedCamera) {
    try {
      localStorage.setItem(
        LENS_PROBE_STORAGE_KEY,
        JSON.stringify({
          hasTele: result.hasTele,
          profile: result.profile,
          label: result.selectedCamera.label,
          idHash: result.selectedCamera.idHash,
          recommendedZoom: result.recommendedZoom || 1,
          ts: Date.now(),
        })
      );
    } catch {}
  }
  return { ...result, cameras };
}
