import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const guidePath = path.join(repositoryRoot, 'docs/updater-trust-root.md');

test('updater trust guide documents secret boundaries, recovery, and two-stage rotation', () => {
  const guide = fs.readFileSync(guidePath, 'utf8');

  assert.match(guide, /`?release`? Environment/i);
  assert.match(guide, /TAURI_SIGNING_PRIVATE_KEY/);
  assert.match(guide, /TAURI_SIGNING_PRIVATE_KEY_PASSWORD/);
  assert.match(guide, /updater-key-recovery\.mjs create/);
  assert.match(guide, /updater-key-recovery\.mjs restore/);
  assert.match(guide, /verify-updater-metadata\.mjs/);
  assert.match(guide, /chmod 600/);
  assert.match(guide, /separate physical location|separate medium/i);
  assert.match(guide, /Phase 1[\s\S]*old private key[\s\S]*new public key/i);
  assert.match(guide, /Phase 2[\s\S]*new private key/i);
  assert.match(guide, /manual reinstall/i);
  assert.match(guide, /candidate[\s\S]*ephemeral/i);
  assert.doesNotMatch(guide, /disable Gatekeeper/i);
});
