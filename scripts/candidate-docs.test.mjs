import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function read(relativePath) {
  return fs.readFileSync(path.join(repositoryRoot, relativePath), 'utf8');
}

test('README documents the safe macOS Open Anyway path without disabling Gatekeeper', () => {
  const readme = read('README.md');
  const readmeZh = read('README.zh-CN.md');
  const combined = `${readme}\n${readmeZh}`;

  assert.match(readme, /System Settings[^\n]+Privacy & Security[^\n]+Open Anyway/);
  assert.match(readme, /ad-hoc signed/i);
  assert.match(readme, /not notarized/i);
  assert.match(readmeZh, /系统设置[^\n]+隐私与安全性[^\n]+仍要打开/);
  assert.match(readmeZh, /ad-hoc/);
  assert.match(readmeZh, /未经公证|未公证/);
  assert.doesNotMatch(combined, /spctl\s+--(?:master|global)-disable|disable Gatekeeper|关闭 Gatekeeper/i);
});

test('候选指南记录正式候选单次构建、不可变证据和安全的 Gatekeeper 边界', () => {
  const guide = read('docs/candidate-builds.md');

  assert.match(guide, /candidate_sha/);
  assert.match(guide, /40 位/);
  assert.match(guide, /workflow_call/);
  assert.match(guide, /不会创建[^\n]+tag[^\n]+GitHub Release[^\n]+latest\.json/);
  assert.match(guide, /临时 Updater 密钥/);
  assert.match(guide, /macOS arm64[^]*macOS x64[^]*Windows x64[^]*Linux x64/);
  assert.match(guide, /candidate-manifest\.json/);
  assert.match(guide, /candidate-build-provenance\.json/);
  assert.match(guide, /run ID[^\n]+run attempt[^\n]+artifact ID[^\n]+digest/);
  assert.match(guide, /系统设置[\s\S]{0,80}隐私与安全性[\s\S]{0,80}仍要打开/);
  assert.match(guide, /不代表[^\n]+Gatekeeper[^\n]+Apple 公证/);
  assert.doesNotMatch(guide, /spctl\s+--(?:master|global)-disable|disable Gatekeeper/i);
});

test('候选指南把手工测试包与正式候选彻底隔离', () => {
  const guide = read('docs/candidate-builds.md');

  assert.match(guide, /manual-test-package\.yml/);
  assert.match(guide, /默认[^\n]+macOS arm64/);
  assert.match(guide, /manual-test-package/);
  assert.match(guide, /promotable[^\n]+false/);
  assert.match(guide, /不创建 Release PR/);
  assert.match(guide, /即使[^\n]+四个平台[^\n]+不能晋级/);
});

test('候选指南记录完成后调度晋级门禁的顺序保证', () => {
  const guide = read('docs/candidate-builds.md');

  assert.match(guide, /release-promotion-dispatch\.yml/);
  assert.match(guide, /已完成 run ID\/attempt/);
  assert.match(guide, /workflow_dispatch/);
  assert.match(guide, /in_progress/);
});

test('candidate guide is included by the repository ignore contract', () => {
  const result = spawnSync('git', ['check-ignore', 'docs/candidate-builds.md'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });

  assert.equal(result.status, 1, result.stdout || result.stderr);
});
