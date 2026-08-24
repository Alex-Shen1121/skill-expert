import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const releaseWorkflowPath = path.join(repositoryRoot, '.github/workflows/release.yml');
const testWorkflowPath = path.join(repositoryRoot, '.github/workflows/test.yml');

test('legacy release entrypoints cannot read production updater Secrets', () => {
  const workflow = fs.readFileSync(releaseWorkflowPath, 'utf8');

  assert.doesNotMatch(workflow, /^\s+environment:\s*release\s*$/m);
  assert.doesNotMatch(workflow, /secrets\.TAURI_SIGNING_PRIVATE_KEY/);
  assert.doesNotMatch(workflow, /secrets\.TAURI_SIGNING_PRIVATE_KEY_PASSWORD/);
});

test('package and pull-request CI expose the updater trust contracts', () => {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'),
  );
  const testWorkflow = fs.readFileSync(testWorkflowPath, 'utf8');

  assert.equal(
    packageJson.scripts['test:updater'],
    'node --test scripts/check-updater-trust.test.mjs scripts/verify-updater-signature.test.mjs scripts/verify-updater-metadata.test.mjs scripts/updater-key-recovery.test.mjs scripts/updater-workflow.test.mjs scripts/updater-docs.test.mjs',
  );
  assert.equal(
    packageJson.scripts['updater:check'],
    'node scripts/check-updater-trust.mjs',
  );
  assert.match(testWorkflow, /run: npm run test:updater/);
  assert.match(testWorkflow, /run: npm run updater:check/);
});
