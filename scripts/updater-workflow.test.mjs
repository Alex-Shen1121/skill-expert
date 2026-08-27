import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const releaseWorkflowPath = path.join(repositoryRoot, '.github/workflows/release.yml');
const testWorkflowPath = path.join(repositoryRoot, '.github/workflows/test.yml');

function job(workflow, jobId) {
  const match = workflow.match(new RegExp(`^  ${jobId}:\\n([\\s\\S]*?)(?=^  [a-z][a-z0-9-]+:|\\Z)`, 'm'));
  assert.ok(match, `缺少 job：${jobId}`);
  return match[0];
}

test('只有正式四平台构建通过 release Environment 读取生产 Updater Secret', () => {
  const workflow = fs.readFileSync(releaseWorkflowPath, 'utf8');
  const productionBuild = job(workflow, 'build-release');
  const workflowWithoutProductionBuild = workflow.replace(productionBuild, '');

  assert.equal((workflow.match(/^\s+environment:\s*release\s*$/gm) ?? []).length, 1);
  assert.match(productionBuild, /secrets\.TAURI_SIGNING_PRIVATE_KEY\s*\}\}/);
  assert.match(productionBuild, /secrets\.TAURI_SIGNING_PRIVATE_KEY_PASSWORD\s*\}\}/);
  assert.match(productionBuild, /run: npm run updater:check:production/);
  assert.doesNotMatch(workflowWithoutProductionBuild, /secrets\.TAURI_SIGNING_PRIVATE_KEY(?:_PASSWORD)?\s*\}\}/);
});

test('软件包脚本保留 Updater 契约但轻量 PR 不运行它', () => {
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
  assert.doesNotMatch(testWorkflow, /run: npm run test:updater/);
  assert.doesNotMatch(testWorkflow, /run: npm run updater:check/);
  assert.doesNotMatch(testWorkflow, /run: npm run updater:check:production/);
  assert.match(
    fs.readFileSync(releaseWorkflowPath, 'utf8'),
    /build-release:[\s\S]*?environment:\s*release[\s\S]*?npm run updater:check:production/,
  );
});
