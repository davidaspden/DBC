/**
 * Maps a collected device diagnostics report to a concrete scanning mode recommendation:
 *  - 'part3-tele'   : reachable 3x telephoto + 30 in focus + gyro
 *  - 'part2-slide'  : default when no usable tele (e.g. Galaxy A53 5G) — 8 in slide with main 1x + gyro
 *  - 'digital-zoom' : no tele & slide blocked/secondary, or single far-label helper at 18–24 in
 *  - 'limited'      : camera works, but sensors missing/denied or no suitable main rear camera
 *  - 'blocked'      : not HTTPS / camera permission denied / no camera
 */

function hasResAtLeast(cam, minLong) {
  if (!cam) return false;
  const res = cam.resolutions || {};
  for (const key of ['1080p', '4K', '720p']) {
    const r = res[key];
    if (r && r.ok && Math.max(r.width || 0, r.height || 0) >= minLong) return true;
  }
  const s = cam.settings;
  if (s && Math.max(s.width || 0, s.height || 0) >= minLong) return true;
  const wMax = cam.capabilities && cam.capabilities.width && cam.capabilities.width.max;
  return typeof wMax === 'number' && wMax >= minLong;
}

function canFocusAt30In(cam, label30) {
  if (label30 && !label30.skipped && typeof label30.medianPpm === 'number') {
    return label30.medianPpm >= 2.0 && label30.decodeRate >= 0.4;
  }
  const fd = cam && cam.capabilities ? cam.capabilities.focusDistance : null;
  if (fd && typeof fd === 'object') {
    // 30 in ≈ 0.76 m; check focusDistance covers ~0.75 m when reported in metres (min <= 1.0 && max >= 0.75)
    if (typeof fd.min === 'number' && typeof fd.max === 'number' && fd.max > 0) {
      return fd.min <= 0.85 && (fd.max >= 0.75 || fd.max >= fd.min);
    }
  }
  // If focusDistance capability is not exposed, assume AF can focus at 30 in when continuous/single-shot AF exists
  const fm = cam && cam.capabilities && Array.isArray(cam.capabilities.focusMode) ? cam.capabilities.focusMode : [];
  return fm.includes('continuous') || fm.includes('single-shot') || fm.length === 0;
}

function canFocusAt8In(cam, label8) {
  if (label8 && !label8.skipped && typeof label8.decodeRate === 'number') {
    return label8.decodeRate >= 0.4;
  }
  const fd = cam && cam.capabilities ? cam.capabilities.focusDistance : null;
  if (fd && typeof fd === 'object' && typeof fd.min === 'number' && fd.min > 0.30) {
    return false;
  }
  return true;
}

function looksLikeRealTele(cam) {
  if (!cam || cam.facing !== 'environment' || cam.error) return false;
  if (cam.roleGuess === 'TELE?') return true;
  const zCap = cam.capabilities && typeof cam.capabilities.zoom === 'object' ? cam.capabilities.zoom : null;
  const sweep = cam.zoomSweep;
  // Require either an actual capability change on handover or a strong optical framing jump (>45 MAE)
  if (zCap && zCap.max >= 3 && sweep && sweep.logicalZoomLikely) {
    const strongJump = Array.isArray(sweep.steps) && sweep.steps.some((s) => (s.frameDiff || 0) > 45);
    if (sweep.capsChangedDetected || strongJump) return true;
  }
  return false;
}

/**
 * Evaluates `report` and returns `{ mode, confidence, reason, blurb, secondaryOption, recommendedCameraHash }`.
 * @param {object} report
 */
export function recommend(report) {
  const env = report.env || {};
  const camPerm = report.cameraPermission || {};
  const cameras = Array.isArray(report.cameras) ? report.cameras : [];
  const sensors = report.sensors || {};
  const labelTests = report.labelTests || {};
  const label8 = labelTests.in8 || null;
  const label30 = labelTests.in30 || null;

  // 1. Blocked: not HTTPS or camera permission denied / unavailable
  if (env.isSecureContext === false) {
    return {
      mode: 'blocked',
      confidence: 'high',
      reason: 'insecure-context',
      blurb: 'Blocked: this page is not running in a secure context (HTTPS or localhost). Open diag.html over HTTPS (GitHub Pages works) so Chrome allows camera and motion sensor access.',
      secondaryOption: null,
      recommendedCameraHash: null,
    };
  }

  if (camPerm.granted === false || cameras.length === 0) {
    return {
      mode: 'blocked',
      confidence: 'high',
      reason: camPerm.error || 'no-camera-access',
      blurb: 'Blocked: camera access was denied or no cameras were found. Grant camera permission and tap Start check again to evaluate lenses.',
      secondaryOption: null,
      recommendedCameraHash: null,
    };
  }

  const rear = cameras.filter((c) => c.facing === 'environment' && !c.error);
  const usableRear = rear.filter((c) => c.suitable !== false && hasResAtLeast(c, 1280));
  const mainCam = usableRear.find((c) => c.roleGuess === 'MAIN?') || usableRear[0] || null;
  const teleCam = usableRear.find((c) => looksLikeRealTele(c)) || null;
  const hasGyro = Boolean(sensors.gyroAvailable);

  // Desktop / front-only webcam check
  if (rear.length === 0) {
    const anyCam = cameras.find((c) => !c.error);
    return {
      mode: 'limited',
      confidence: 'high',
      reason: 'no-rear-camera',
      blurb: 'Limited: no rear-facing camera detected (desktop webcam or front camera only). Single-barcode decoding works, but wall-mapping modes require a phone with a rear camera and gyro.',
      secondaryOption: null,
      recommendedCameraHash: anyCam ? anyCam.idHash : null,
    };
  }

  // Only ultrawide / macro / low-res reachable
  if (!mainCam) {
    return {
      mode: 'limited',
      confidence: 'high',
      reason: 'no-suitable-main-rear',
      blurb: 'Limited: only low-resolution or non-autofocus rear cameras were reachable in Chrome. Check camera permissions or try another browser/device.',
      secondaryOption: null,
      recommendedCameraHash: rear[0].idHash,
    };
  }

  // Missing motion sensors
  if (!hasGyro) {
    return {
      mode: 'limited',
      confidence: 'high',
      reason: 'no-gyro-or-motion',
      blurb: `Limited: rear camera (${mainCam.label}) works at ${hasResAtLeast(mainCam, 1920) ? '1080p' : '720p'}, but gyroscope/motion sensors are unavailable or denied. Single-label scanning works; automated 4x4 wall mapping needs gyro access (manual tap-to-cell checklist still works).`,
      secondaryOption: null,
      recommendedCameraHash: mainCam.idHash,
    };
  }

  const has1080p = hasResAtLeast(mainCam, 1920);
  const has4K = hasResAtLeast(mainCam, 3840);
  const mainZoomMax = mainCam.capabilities && typeof mainCam.capabilities.zoom === 'object'
    ? mainCam.capabilities.zoom.max
    : 1;
  const hasDigitalCrop = mainZoomMax >= 2 || has4K;
  const hasManualExp = Boolean(
    mainCam.capabilities &&
    Array.isArray(mainCam.capabilities.exposureMode) &&
    mainCam.capabilities.exposureMode.includes('manual') &&
    mainCam.capabilities.exposureTime !== 'n/a'
  );
  const gyroStillBad = Boolean(sensors.atRest && sensors.atRest.movedDuringTest);

  // 2. Part 3 (telephoto stand-back pan) — highest priority when a real ~3x tele is reachable
  if (teleCam && canFocusAt30In(teleCam, label30)) {
    const expNote = hasManualExp
      ? 'Manual exposure is available for crisp 1/250–1/500 s pan shots.'
      : 'Manual exposure was not reported; use bright overhead lighting and keep pitch shake low.';
    const gyroNote = gyroStillBad
      ? ' Re-run the 2 s stationary gyro check holding steady before calibrating.'
      : '';
    return {
      mode: 'part3-tele',
      confidence: label30 && !label30.skipped ? 'high' : 'medium',
      reason: 'reachable-tele-with-gyro',
      blurb: `Use Part 3 (stand-back pan at ~30 in): a telephoto-capable rear lens (${teleCam.label}) and gyro (${sensors.gyroHz || '?'} Hz) were detected with 30 in focus support. ${expNote}${gyroNote}`,
      secondaryOption: 'part2-slide',
      recommendedCameraHash: teleCam.idHash,
    };
  }

  // 3. Part 2 (8 in slide with main 1x + gyro) — default when no tele is reachable (e.g., Galaxy A53 5G)
  if (canFocusAt8In(mainCam, label8)) {
    const resLabel = has1080p ? '1080p' : '720p';
    const digitalNote = hasDigitalCrop
      ? ' Digital zoom (2x–3x) is a secondary helper for single far labels at 18–24 in, not the 4x4 wall.'
      : '';
    const torchNote = mainCam.capabilities && mainCam.capabilities.torch === true
      ? ' Torch is available for fast shutter indoors.'
      : '';
    return {
      mode: 'part2-slide',
      confidence: 'high',
      reason: 'no-tele-main-and-gyro-ok',
      blurb: `No telephoto lens found; main rear camera (${resLabel}) and gyro (${sensors.gyroHz || '?'} Hz) are available, so use the 8 in slide (Part 2).${torchNote}${digitalNote}`,
      secondaryOption: hasDigitalCrop ? 'digital-zoom' : null,
      recommendedCameraHash: mainCam.idHash,
    };
  }

  // 4. Digital zoom fallback if 8 in focus failed but 2x–3x crop works at 18–24 in
  if (hasDigitalCrop) {
    return {
      mode: 'digital-zoom',
      confidence: 'medium',
      reason: 'digital-crop-fallback',
      blurb: 'No telephoto lens and close 8 in focus was weak; use 2x–3x digital zoom on the main camera from 18–24 in for single labels or inner cells (outer corners at 30 in will be marginal).',
      secondaryOption: 'part2-slide',
      recommendedCameraHash: mainCam.idHash,
    };
  }

  return {
    mode: 'limited',
    confidence: 'medium',
    reason: 'insufficient-focus-or-zoom',
    blurb: 'Limited: main camera and gyro exist, but close focus and zoom capabilities look constrained. Run the optional 8 in live label test to confirm.',
    secondaryOption: null,
    recommendedCameraHash: mainCam.idHash,
  };
}
