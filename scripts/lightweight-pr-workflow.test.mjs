import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workflow = readFileSync(
  path.join(repositoryRoot, '.github/workflows/test.yml'),
  'utf8',
);

function jobIds(content) {
  const jobs = content.slice(content.indexOf('\njobs:\n') + '\njobs:\n'.length);
  return [...jobs.matchAll(/^  ([a-z][a-z0-9-]+):\s*$/gm)].map((match) => match[1]);
}

test('main PR 只运行三组轻量必需检查', () => {
  assert.deepEqual(jobIds(workflow), ['frontend', 'workflow-lint', 'rust-quality']);
  assert.match(workflow, /pull_request:\n\s+branches:\s*\[main\]/);
  assert.match(workflow, /name: Frontend and version contract/);
  assert.match(workflow, /name: GitHub Actions syntax/);
  assert.match(workflow, /name: Rust quality and Linux check/);
});

test('普通 PR 和 main push 不执行跨平台测试或安装包构建', () => {
  assert.doesNotMatch(workflow, /rust-tests:/);
  assert.doesNotMatch(workflow, /candidate-package:/);
  assert.doesNotMatch(workflow, /candidate-pr:/);
  assert.doesNotMatch(workflow, /main-version-policy:/);
  assert.doesNotMatch(workflow, /tauri\s+--\s+build|tauri\s+build/);
  assert.doesNotMatch(workflow, /node scripts\/version-policy\.mjs/);
  assert.doesNotMatch(workflow, /refs\/heads\/release|origin\/release/);
  for (const command of [
    'test:release',
    'test:test-package',
    'test:upstream-tracking',
    'test:worktree-baseline',
    'test:updater',
    'updater:check',
    'repository:identity:check',
    'desktop:identity:check',
    'cli:identity:check',
  ]) {
    assert.doesNotMatch(workflow, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('轻量检查仍覆盖前端、稳定版本和 Linux Rust 质量', () => {
  for (const command of [
    'npm run version:check',
    'stable-version-policy.mjs verify-main-pr',
    'npm run test:frontend',
    'npm run lint',
    'npm run typecheck',
    'npm run build',
    'cargo fmt',
    'cargo clippy',
    'cargo check',
  ]) {
    assert.match(workflow, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});
