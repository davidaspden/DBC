/**
 * R7 helper — loads the array mapper exactly as it was at commit d917944 (the pre-A-flag baseline)
 * from git history into a temp dir, so the loop can prove "flags off == d917944".
 * Returns `null` when the commit is not in this clone's history.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const LEGACY_COMMIT = 'd917944';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export function legacyCommitAvailable() {
  try {
    execFileSync('git', ['cat-file', '-e', `${LEGACY_COMMIT}^{commit}`], { cwd: ROOT, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export async function loadLegacyArrayModules() {
  if (!legacyCommitAvailable()) return null;
  const dir = mkdtempSync(join(tmpdir(), 'dbc-d917944-'));
  mkdirSync(join(dir, 'array'), { recursive: true });
  for (const f of ['pan-mapper.js', 'orient.js']) {
    const src = execFileSync('git', ['show', `${LEGACY_COMMIT}:src/array/${f}`], { cwd: ROOT, maxBuffer: 1 << 24 });
    writeFileSync(join(dir, 'array', f), src);
  }
  const mapper = await import(pathToFileURL(join(dir, 'array', 'pan-mapper.js')).href);
  return { createPanArrayMapper: mapper.createPanArrayMapper, dir };
}
