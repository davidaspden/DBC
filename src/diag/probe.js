/**
 * Diagnostics orchestration: environment probing, permission flow, camera/capture/sensor
 * probe sequencing, visibility handling, and report assembly.
 */

import { stopCamera } from '../camera.js';
import { requestCameraAccess, probeCameras } from './cameras.js';
import { probeCapturePath } from './capture.js';
import { requestMotionAccess, probeSensors, measureGyroAtRest } from './sensors.js';
import { recommend } from './recommend.js';

function randomReportId() {
  const bytes = new Uint8Array(3);
  if (globalThis.crypto && typeof globalThis.crypto.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 3; i++) bytes[i] = (Math.random() * 256) | 0;
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function parseUaSummary(ua) {
  const s = ua || '';
  let osGuess = 'Unknown OS';
  const androidMatch = s.match(/Android\s+([\d.]+)/i);
  const iosMatch = s.match(/OS\s+([\d_]+)\s+like Mac OS X/i);
  if (androidMatch) osGuess = `Android ${androidMatch[1]}`;
  else if (iosMatch) osGuess = `iOS ${iosMatch[1].replace(/_/g, '.')}`;
  else if (/Windows NT/i.test(s)) osGuess = 'Windows';
  else if (/Mac OS X/i.test(s)) osGuess = 'macOS';
  else if (/Linux/i.test(s)) osGuess = 'Linux';

  let browserGuess = 'Unknown browser';
  const edgeMatch = s.match(/EdgA?\/([\d.]+)/);
  const chromeMatch = s.match(/Chrome\/([\d.]+)/);
  const criosMatch = s.match(/CriOS\/([\d.]+)/);
  const safariMatch = s.match(/Version\/([\d.]+).*Safari/);
  const ffMatch = s.match(/Firefox\/([\d.]+)/);
  if (edgeMatch) browserGuess = `Edge ${edgeMatch[1].split('.')[0]}`;
  else if (chromeMatch) browserGuess = `Chrome ${chromeMatch[1].split('.')[0]}`;
  else if (criosMatch) browserGuess = `Chrome iOS ${criosMatch[1].split('.')[0]}`;
  else if (safariMatch) browserGuess = `Safari ${safariMatch[1]}`;
  else if (ffMatch) browserGuess = `Firefox ${ffMatch[1].split('.')[0]}`;

  let uaModelGuess = null;
  const modelMatch = s.match(/Android\s+[\d.]+;\s*([^;)]+)\)/i);
  if (modelMatch && modelMatch[1] && modelMatch[1].trim() !== 'K') {
    uaModelGuess = modelMatch[1].trim();
  }

  return { osGuess, browserGuess, uaModelGuess };
}

/**
 * Collects browser, OS, display, secure-context, and supported MediaTrackConstraints metadata.
 */
export async function probeEnvironment() {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  const parsed = parseUaSummary(ua);

  let brands = null;
  let highEntropy = null;
  if (typeof navigator !== 'undefined' && navigator.userAgentData) {
    brands = Array.isArray(navigator.userAgentData.brands)
      ? navigator.userAgentData.brands.map((b) => ({ brand: b.brand, version: b.version }))
      : null;
    if (typeof navigator.userAgentData.getHighEntropyValues === 'function') {
      try {
        highEntropy = await navigator.userAgentData.getHighEntropyValues([
          'model',
          'platform',
          'platformVersion',
          'uaFullVersion',
          'fullVersionList',
          'bitness',
          'architecture',
        ]);
      } catch {
        highEntropy = null;
      }
    }
  }

  const supportedConstraints =
    typeof navigator !== 'undefined' &&
    navigator.mediaDevices &&
    typeof navigator.mediaDevices.getSupportedConstraints === 'function'
      ? navigator.mediaDevices.getSupportedConstraints()
      : {};

  const vv = typeof window !== 'undefined' && window.visualViewport
    ? {
      width: Math.round(window.visualViewport.width),
      height: Math.round(window.visualViewport.height),
      scale: window.visualViewport.scale,
    }
    : null;

  const screenOri = typeof screen !== 'undefined' && screen.orientation
    ? {
      type: screen.orientation.type || 'unknown',
      angle: typeof screen.orientation.angle === 'number' ? screen.orientation.angle : 0,
      lockSupported: typeof screen.orientation.lock === 'function',
    }
    : { type: 'unavailable', angle: 0, lockSupported: false };

  return {
    userAgent: ua,
    brands,
    highEntropy,
    ...parsed,
    screenWidth: typeof screen !== 'undefined' ? screen.width : 0,
    screenHeight: typeof screen !== 'undefined' ? screen.height : 0,
    innerWidth: typeof window !== 'undefined' ? window.innerWidth : 0,
    innerHeight: typeof window !== 'undefined' ? window.innerHeight : 0,
    devicePixelRatio: typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 1,
    visualViewport: vv,
    screenOrientation: screenOri,
    isSecureContext: typeof window !== 'undefined' ? Boolean(window.isSecureContext) : true,
    protocol: typeof location !== 'undefined' ? location.protocol : 'unknown:',
    supportedConstraints: {
      zoom: Boolean(supportedConstraints.zoom),
      exposureMode: Boolean(supportedConstraints.exposureMode),
      exposureTime: Boolean(supportedConstraints.exposureTime),
      iso: Boolean(supportedConstraints.iso),
      focusMode: Boolean(supportedConstraints.focusMode),
      focusDistance: Boolean(supportedConstraints.focusDistance),
      torch: Boolean(supportedConstraints.torch),
      facingMode: Boolean(supportedConstraints.facingMode),
      frameRate: Boolean(supportedConstraints.frameRate),
      pointsOfInterest: Boolean(supportedConstraints.pointsOfInterest),
      whiteBalanceMode: Boolean(supportedConstraints.whiteBalanceMode),
    },
  };
}

/**
 * Runs the complete D0 device diagnostic sequence from a single user Start gesture.
 *
 * @param {{
 *   previewEl: HTMLVideoElement,
 *   onStatus?: (msg: string) => void,
 *   onPartial?: (partial: object) => void
 * }} uiHooks
 */
export async function runFullProbe(uiHooks = {}) {
  const previewEl = uiHooks.previewEl || null;
  const setStatus = typeof uiHooks.onStatus === 'function' ? uiHooks.onStatus : () => {};
  const onPartial = typeof uiHooks.onPartial === 'function' ? uiHooks.onPartial : () => {};

  const report = {
    version: 1,
    reportId: randomReportId(),
    timestampUtc: new Date().toISOString(),
    env: null,
    cameraPermission: { granted: false, error: null },
    cameras: [],
    capture: null,
    sensors: null,
    labelTests: {},
    recommendation: null,
  };

  // Start iOS motion permission request inside the initial user gesture tick if needed
  const motionPermPromise = requestMotionAccess();

  setStatus('Probing environment…');
  report.env = await probeEnvironment();
  onPartial({ env: report.env });

  if (!report.env.isSecureContext) {
    setStatus('Need HTTPS');
    report.recommendation = recommend(report);
    onPartial({ recommendation: report.recommendation });
    return { report, deviceMap: new Map() };
  }

  // 1. Camera permission
  setStatus('Waiting for camera permission…');
  const camAccess = await requestCameraAccess();
  report.cameraPermission = { granted: camAccess.granted, error: camAccess.error };

  let deviceMap = new Map();

  if (camAccess.granted) {
    // Release initial grant stream before exclusive per-device enumeration
    if (camAccess.stream) {
      stopCamera(camAccess.stream);
    }

    // 2. Probe every videoinput exclusively
    const camResult = await probeCameras(previewEl, {
      zoomRequested: camAccess.zoomRequested,
      onProgress: (i, total, label) => {
        setStatus(`Probing cameras ${i}/${total}: ${label}`);
      },
    });
    report.cameras = camResult.cameras;
    deviceMap = camResult.deviceMap;
    onPartial({ cameras: report.cameras });

    // 3. PP2: Probe capture path on the chosen 1080p stream ONLY AFTER all camera probing is done,
    // requesting min 30 fps (fallback ideal 30) and recording exact resolution & exposure conditions.
    const prefCam =
      report.cameras.find((c) => c.roleGuess === 'MAIN?' && !c.error) ||
      report.cameras.find((c) => c.facing === 'environment' && !c.error) ||
      report.cameras.find((c) => !c.error);

    if (prefCam && previewEl) {
      setStatus('Probing 1080p capture path (rVFC / WebCodecs / Worker)…');
      let capStream = null;
      try {
        const rawId = deviceMap.get(prefCam.idHash);
        const videoConstraint = {
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          frameRate: { ideal: 30, min: 30 },
        };
        if (rawId) videoConstraint.deviceId = { exact: rawId };
        try {
          capStream = await navigator.mediaDevices.getUserMedia({ video: videoConstraint, audio: false });
        } catch {
          videoConstraint.frameRate = { ideal: 30 };
          capStream = await navigator.mediaDevices.getUserMedia({ video: videoConstraint, audio: false });
        }
        const capTrack = capStream.getVideoTracks()[0] || null;
        previewEl.srcObject = capStream;
        previewEl.playsInline = true;
        previewEl.muted = true;
        await previewEl.play().catch(() => {});
        await new Promise((r) => setTimeout(r, 350));
        report.capture = await probeCapturePath(previewEl, capTrack);
      } catch (err) {
        report.capture = {
          rVfcSupported: typeof previewEl.requestVideoFrameCallback === 'function',
          measuredFps: 0,
          frameCount: 0,
          videoFrameSupported: typeof VideoFrame !== 'undefined',
          videoFrameFormat: null,
          yuvDirectCopy: false,
          copyToOk: false,
          tCaptureMs: null,
          videoFrameError: err && err.name ? err.name : String(err),
          workerTransferOk: false,
        };
      } finally {
        if (capStream) stopCamera(capStream);
        previewEl.srcObject = null;
      }
      onPartial({ capture: report.capture });
    }
  } else {
    onPartial({ cameras: report.cameras });
  }

  // 4. Sensors (always run even if camera was denied!)
  setStatus('Probing motion sensors…');
  const motionPerm = await motionPermPromise;
  report.sensors = await probeSensors();
  report.sensors.permission = motionPerm;

  if (report.sensors.gyroAvailable) {
    setStatus('Hold the phone still for 2 seconds…');
    report.sensors.atRest = await measureGyroAtRest(2000);
  }
  onPartial({ sensors: report.sensors });

  // 5. Recommendation
  report.recommendation = recommend(report);
  onPartial({ recommendation: report.recommendation });
  setStatus('Done');

  return { report, deviceMap };
}
