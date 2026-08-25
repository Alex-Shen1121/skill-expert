import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const releaseWorkflowPath = path.join(repositoryRoot, '.github/workflows/release.yml');
const testWorkflowPath = path.join(repositoryRoot, '.github/workflows/test.yml');

test('旧发布入口不能读取生产 Updater Secret', () => {
  const workflow = fs.readFileSync(releaseWorkflowPath, 'utf8');

  assert.doesNotMatch(workflow, /^\s+environment:\s*release\s*$/m);
  assert.doesNotMatch(workflow, /secrets\.TAURI_SIGNING_PRIVATE_KEY/);
  assert.doesNotMatch(workflow, /secrets\.TAURI_SIGNING_PRIVATE_KEY_PASSWORD/);
  assert.match(workflow, /run: npm run updater:check:production/);
});

test('软件包脚本和拉取请求 CI 暴露 Updater 信任契约', () => {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'),
  );
  const testWorkflow = fs.readFileSync(testWorkflowPath, 'utf8');

  assert.equal(
    packageJson.scripts['test:updater'],
    'node --test scripts/check-updater-trust.test.mjs scripts/verify-updater-signature.test.mjs scripts/verify-updater-metadata.test.mjs scripts/updater-key-recovery.test.mjs scripts/provision-updater.test.mjs scripts/updater-workflow.test.mjs scripts/updater-docs.test.mjs',
  );
  assert.equal(
    packageJson.scripts['updater:check'],
    'node scripts/check-updater-trust.mjs',
  );
  assert.equal(
    packageJson.scripts['updater:check:production'],
    'node scripts/check-updater-trust.mjs --require-production',
  );
  assert.equal(
    packageJson.scripts['updater:provision'],
    'node scripts/provision-updater.mjs',
  );
  assert.match(testWorkflow, /run: npm run test:updater/);
  assert.match(testWorkflow, /run: npm run updater:check/);
  assert.match(
    testWorkflow,
    /if: github\.event_name == 'pull_request' && github\.head_ref == 'main' && github\.base_ref == 'release'[\s\S]*run: npm run updater:check:production/,
  );
});
