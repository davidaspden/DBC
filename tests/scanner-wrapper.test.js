/**
 * H7 — Unit tests for the public `Code128Scanner` wrapper (`src/scanner.js`) worker flags.
 *
 * No browser: a fake `Worker` class and a fake `OffscreenCanvas` are installed on `globalThis`
 * so the wrapper's real `scanImage()` and live `_pumpVideoFrame()` paths post to a recorder.
 * Asserts: default posts mask 0, `flags` names/numeric mask are posted on `init` and on EVERY
 * `frame` message, `tFrameMs` is posted, unknown names throw, results still resolve as before.
 */
import assert from 'node:assert/strict';
import { WORKER_FLAG_BITS } from '../src/worker/flagbits.js';

class FakeWorker {
  constructor(url, opts) {
    this.url = url;
    this.opts = opts;
    this.messages = [];
    this.terminated = false;
    this.onmessage = null;
    this.onerror = null;
    FakeWorker.last = this;
  }
  postMessage(msg) { this.messages.push(msg); }
  terminate() { this.terminated = true; }
}

class FakeOffscreenCanvas {
  constructor(w, h) { this.width = w; this.height = h; }
  getContext() {
    const canvas = this;
    return {
      drawImage() {},
      getImageData(x, y, w, h) {
        const data = new Uint8ClampedArray(w * h * 4);
        for (let i = 0; i < data.length; i += 4) { data[i] = 120; data[i + 1] = 120; data[i + 2] = 120; data[i + 3] = 255; }
        return { data, width: canvas.width, height: canvas.height };
      },
    };
  }
}

globalThis.Worker = FakeWorker;
globalThis.OffscreenCanvas = FakeOffscreenCanvas;

const { Code128Scanner, resolveWorkerFlagMask } = await import('../src/scanner.js');

let passed = 0;
async function test(name, fn) {
  await fn();
  console.log(`  PASS  ${name}`);
  passed++;
}

const IMG = { width: 16, height: 8 };

function resultMsg(frameId) {
  return { type: 'result', frameId, detected: 0, detections: [], tTotalMs: 1, tCaptureMs: 0 };
}

async function scanOnce(scanner) {
  const p = scanner.scanImage(IMG);
  const worker = FakeWorker.last;
  const frame = worker.messages.find((m) => m.type === 'frame');
  worker.onmessage({ data: resultMsg(frame.frameId) });
  const out = await p;
  return { worker, out };
}

await test('resolveWorkerFlagMask: none/empty -> 0, names OR bits, numeric passes through, unknown throws', () => {
  assert.equal(resolveWorkerFlagMask(undefined), 0);
  assert.equal(resolveWorkerFlagMask(null), 0);
  assert.equal(resolveWorkerFlagMask([]), 0);
  assert.equal(resolveWorkerFlagMask(['cribMatch']), WORKER_FLAG_BITS.cribMatch);
  const expected = WORKER_FLAG_BITS.verticalMode | WORKER_FLAG_BITS.cribMatch | WORKER_FLAG_BITS.requirePrefix;
  assert.equal(resolveWorkerFlagMask(['verticalMode', 'cribMatch', 'requirePrefix']), expected);
  assert.equal(resolveWorkerFlagMask(['cribMatch', 'cribMatch']), WORKER_FLAG_BITS.cribMatch);
  assert.equal(resolveWorkerFlagMask(expected), expected);
  assert.throws(() => resolveWorkerFlagMask(['cribMatsh']), RangeError);
  assert.throws(() => resolveWorkerFlagMask(['toString']), RangeError);
  assert.throws(() => resolveWorkerFlagMask('cribMatch'), TypeError);
});

await test('default scanner (no options) posts flags=0 on init and frame, with tFrameMs', async () => {
  const scanner = new Code128Scanner();
  assert.equal(scanner.flagsMask, 0);
  const { worker } = await scanOnce(scanner);
  const init = worker.messages.find((m) => m.type === 'init');
  const frame = worker.messages.find((m) => m.type === 'frame');
  assert.equal(init.flags, 0);
  assert.equal(init.width, IMG.width);
  assert.equal(frame.flags, 0);
  assert.equal(typeof frame.tFrameMs, 'number');
  assert.ok(Number.isFinite(frame.tFrameMs));
  // Existing message fields are unchanged.
  assert.equal(frame.multi, true);
  assert.equal(frame.debug, false);
  assert.equal(frame.byteOffset, 0);
  assert.equal(frame.buffer.byteLength, IMG.width * IMG.height);
  scanner.destroy();
});

await test('flags names array is posted as the mask on init and frame', async () => {
  const names = ['verticalMode', 'cribMatch', 'requirePrefix'];
  const mask = WORKER_FLAG_BITS.verticalMode | WORKER_FLAG_BITS.cribMatch | WORKER_FLAG_BITS.requirePrefix;
  const scanner = new Code128Scanner({ flags: names });
  assert.equal(scanner.flagsMask, mask);
  const { worker } = await scanOnce(scanner);
  assert.equal(worker.messages.find((m) => m.type === 'init').flags, mask);
  assert.equal(worker.messages.find((m) => m.type === 'frame').flags, mask);
  scanner.destroy();
});

await test('numeric mask and custom tFrameMs (function / constant) are honoured', async () => {
  let clock = 1000;
  const scanner = new Code128Scanner({ flags: WORKER_FLAG_BITS.vertFallback, tFrameMs: () => (clock += 5) });
  const a = await scanOnce(scanner);
  const f1 = a.worker.messages.filter((m) => m.type === 'frame').pop();
  assert.equal(f1.flags, WORKER_FLAG_BITS.vertFallback);
  assert.equal(f1.tFrameMs, 1005);
  scanner.destroy();

  const s2 = new Code128Scanner({ tFrameMs: 42 });
  const b = await scanOnce(s2);
  assert.equal(b.worker.messages.find((m) => m.type === 'frame').tFrameMs, 42);
  s2.destroy();
});

await test('live pump path posts flags + tFrameMs on every frame; setFlags applies from next frame', async () => {
  const scanner = new Code128Scanner({ flags: ['cribMatch'] });
  scanner._ensureWorker();
  const worker = FakeWorker.last;
  scanner._useWebCodecs = false;
  scanner._running = true;
  const cb = { n: 0 };
  scanner.video = {
    readyState: 4,
    videoWidth: 32,
    videoHeight: 16,
    requestVideoFrameCallback() { cb.n++; return cb.n; },
    cancelVideoFrameCallback() {},
  };

  await scanner._pumpVideoFrame();
  let frames = worker.messages.filter((m) => m.type === 'frame');
  assert.equal(frames.length, 1);
  assert.equal(frames[0].flags, WORKER_FLAG_BITS.cribMatch);
  assert.equal(typeof frames[0].tFrameMs, 'number');
  assert.equal(frames[0].width, 32);
  assert.equal(frames[0].height, 16);
  worker.onmessage({ data: resultMsg(frames[0].frameId) });

  scanner.setFlags(['requirePrefix', 'cribMatch']);
  await scanner._pumpVideoFrame();
  frames = worker.messages.filter((m) => m.type === 'frame');
  assert.equal(frames.length, 2);
  assert.equal(frames[1].flags, WORKER_FLAG_BITS.requirePrefix | WORKER_FLAG_BITS.cribMatch);
  worker.onmessage({ data: resultMsg(frames[1].frameId) });

  scanner.setFlags(null);
  await scanner._pumpVideoFrame();
  frames = worker.messages.filter((m) => m.type === 'frame');
  assert.equal(frames[2].flags, 0);

  scanner._running = false;
  scanner.destroy();
});

await test('scanImage result handling is unchanged (detections synthesised from legacy fields)', async () => {
  const scanner = new Code128Scanner();
  const p = scanner.scanImage(IMG);
  const worker = FakeWorker.last;
  const frame = worker.messages.find((m) => m.type === 'frame');
  worker.onmessage({
    data: { type: 'result', frameId: frame.frameId, detected: 1, payload: 'tsX07wz7py1', payloadHex: '00', tTotalMs: 2, tCaptureMs: 1 },
  });
  const { detections, telemetry } = await p;
  assert.equal(detections.length, 1);
  assert.equal(detections[0].payload, 'tsX07wz7py1');
  assert.equal(detections[0].symbology, 'CODE_128');
  assert.equal(telemetry.tWorkerMs, 2);
  scanner.destroy();
});

console.log(`All ${passed} scanner wrapper tests passed.`);
