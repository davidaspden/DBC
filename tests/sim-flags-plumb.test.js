/**
 * R2 — Worker-flag plumbing in `sim.html` (extracts and checks the message shape from the inline script text).
 *   node tests/sim-flags-plumb.test.js
 */

import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { resolveFlags, flagsToWorkerMask } from '../src/flags.js';
import {
  FLAG_VERT_FALLBACK,
  FLAG_CRIB_MATCH,
  FLAG_REQUIRE_PREFIX_STRICT,
} from '../src/worker/flagbits.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(ROOT, 'sim.html'), 'utf8').replace(/\r\n/g, '\n');

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  PASS  ${name}`);
}

function extractInlineModule(src) {
  const m = /<script type="module">([\s\S]*?)<\/script>/.exec(src);
  assert.ok(m, 'sim.html must keep one inline module script');
  return m[1];
}

/** Returns the text of the object literal passed to the first `worker.postMessage({ type: '<type>' ...` call. */
function messageLiteral(script, type) {
  const re = new RegExp(`worker\\.postMessage\\(\\s*\\{\\s*type:\\s*'${type}'`);
  const m = re.exec(script);
  assert.ok(m, `no worker.postMessage for type '${type}'`);
  const start = script.indexOf('{', m.index);
  let depth = 0;
  for (let i = start; i < script.length; i++) {
    const ch = script[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return script.slice(start, i + 1);
    }
  }
  throw new Error('unterminated message literal');
}

console.log('Running R2 sim.html worker-flag plumbing tests...');

const script = extractInlineModule(html);

test('inline script imports resolveFlags-backed toWorkerMask() from src/flags.js', () => {
  assert.match(script, /import\s*\{[^}]*toWorkerMask[^}]*\}\s*from\s*'\.\/src\/flags\.js'/);
});

test('init message posts flags: toWorkerMask()', () => {
  const lit = messageLiteral(script, 'init');
  assert.match(lit, /flags:\s*toWorkerMask\(\)/);
  assert.match(lit, /width:\s*w/);
  assert.match(lit, /height:\s*h/);
});

test('every frame message posts flags: toWorkerMask() and tFrameMs', () => {
  const frames = script.match(/worker\.postMessage\(\s*\{\s*type:\s*'frame'/g) || [];
  assert.equal(frames.length, 1, 'expected exactly one frame post site');
  const lit = messageLiteral(script, 'frame');
  assert.match(lit, /flags:\s*toWorkerMask\(\)/);
  assert.match(lit, /tFrameMs:/);
  // pre-existing fields are unchanged
  for (const field of ['frameId', 'width', 'height', 'byteOffset', 'tCaptureMs', 'multi', 'debug', 'buffer']) {
    assert.match(lit, new RegExp(`\\b${field}\\b`), `frame message lost field ${field}`);
  }
});

test('HUD shows the active flag list and mask', () => {
  assert.match(html, /id="m-flags"/);
  assert.match(script, /getElementById\('m-flags'\)/);
  assert.match(script, /refreshFlagsHud\(\)/);
});

test('default (no ?flags=) resolves to mask 0 so flags-off behaviour is unchanged', () => {
  assert.equal(flagsToWorkerMask(resolveFlags({ search: '' })), 0);
  assert.equal(flagsToWorkerMask(resolveFlags({ search: '?flags=none' })), 0);
});

test('?flags=vertFallback,cribMatch yields the matching worker mask', () => {
  const mask = flagsToWorkerMask(resolveFlags({ search: '?flags=vertFallback,cribMatch' }));
  assert.equal(mask, FLAG_VERT_FALLBACK | FLAG_CRIB_MATCH);
});

test('?flags=all excludes requirePrefixStrict (H1), allStrict includes it', () => {
  const all = flagsToWorkerMask(resolveFlags({ search: '?flags=all' }));
  assert.equal(all & FLAG_REQUIRE_PREFIX_STRICT, 0);
  const strict = flagsToWorkerMask(resolveFlags({ search: '?flags=allStrict' }));
  assert.notEqual(strict & FLAG_REQUIRE_PREFIX_STRICT, 0);
});

test('sim.html inline module script still parses (node --check)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dbc-simhtml-'));
  try {
    const file = join(dir, 'inline.mjs');
    writeFileSync(file, script);
    const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    assert.equal(r.status, 0, `syntax error in sim.html inline script:\n${r.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

console.log(`All ${passed} R2 sim-flags-plumb tests passed.`);
