/**
 * K9 — browser hook for `sim.html` (`src/sim/camera-profile-hook.js`).
 *
 * `sim.html` calls three pass-through functions. With the `ideal` profile (the default) each returns its
 * input untouched, so the page behaves exactly as before. With another profile:
 *  - `intervalMs(defaultMs)`  the camera's frame period (an AE exposure of 100 ms gives 100 ms = 10 fps);
 *  - `shutterSec(defaultSec)` the AE/locked exposure used for the sub-pose shutter blur;
 *  - `apply(luma, w, h, pose, hfovDeg)`  steps the exposure model one frame and runs glare -> optics ->
 *    sensor noise -> JPEG on the read-back luma in place.
 *
 * Limits: the GL path has no rolling-shutter bands (one pose per frame) and the real worker decides frame
 * drops; the headless gate (`tools/gate`) is the place for both. Zero allocation per frame after `setProfile`.
 */

import { createProfileSession, isKnownCameraProfile } from './camera-model/profiles.js';

export function createCameraProfileHook() {
  let profileId = 'ideal';
  let session = null;
  let sessW = 0;
  let sessH = 0;
  let nextIntervalMs = 0;
  let nextShutterSec = 0;

  function ensure(w, h, hfovDeg) {
    if (profileId === 'ideal') { session = null; return null; }
    if (!session || sessW !== w || sessH !== h) {
      session = createProfileSession(profileId, { width: w, height: h, seed: 1, hfovDeg });
      sessW = w;
      sessH = h;
      nextIntervalMs = session.lastDurSec * 1000;
      nextShutterSec = session.profile.exposure.initialExposureMs * 1e-3;
    }
    return session;
  }

  return {
    get profileId() { return profileId; },
    setProfile(id) {
      if (!isKnownCameraProfile(id)) throw new Error(`Unknown camera profile: ${id}`);
      profileId = id;
      session = null; // rebuilt on the next frame with the page's size
    },
    isActive() { return profileId !== 'ideal'; },
    intervalMs(defaultMs) {
      return profileId === 'ideal' || !session ? defaultMs : nextIntervalMs;
    },
    shutterSec(defaultSec) {
      return profileId === 'ideal' || !session ? defaultSec : nextShutterSec;
    },
    apply(luma, w, h, pose, hfovDeg) {
      if (!luma) return luma;
      const s = ensure(w | 0, h | 0, hfovDeg);
      if (!s) return luma;
      const fr = s.nextFrame(0); // the real worker decides drops in the browser
      nextIntervalMs = fr.durationSec * 1000;
      nextShutterSec = fr.exposureSec;
      return s.postProcess(luma, pose);
    },
    summary() { return session ? session.summary(0) : null; },
  };
}
