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

test('candidate guide explains exact-SHA private artifacts and the safe Gatekeeper boundary', () => {
  const guide = read('docs/candidate-builds.md');

  assert.match(guide, /candidate_sha/);
  assert.match(guide, /40-character commit SHA/);
  assert.match(guide, /workflow_dispatch/);
  assert.match(guide, /workflow_call/);
  assert.match(guide, /never creates? a tag, GitHub Release, or updater metadata/i);
  assert.match(guide, /ephemeral[^\n]+updater signing key/i);
  assert.match(guide, /macOS arm64[^]*macOS x64[^]*Windows x64[^]*Linux x64/);
  assert.match(guide, /System Settings[^\n]+Privacy & Security[^\n]+Open Anyway/);
  assert.match(guide, /not a Gatekeeper acceptance or notarization claim/i);
  assert.doesNotMatch(guide, /spctl\s+--(?:master|global)-disable|disable Gatekeeper/i);
});

test('candidate guide is included by the repository ignore contract', () => {
  const result = spawnSync('git', ['check-ignore', 'docs/candidate-builds.md'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });

  assert.equal(result.status, 1, result.stdout || result.stderr);
});
