import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('手工测试包使用独立且不可晋级的复用工作流', () => {
  const builderPath = path.join(repositoryRoot, '.github/workflows/test-package-build.yml');
  assert.equal(existsSync(builderPath), true);
  assert.equal(existsSync(path.join(repositoryRoot, '.github/workflows/candidate-build.yml')), false);

  const builder = readFileSync(builderPath, 'utf8');
  assert.match(builder, /^\s{2}workflow_call:/m);
  assert.match(builder, /source_sha:/);
  assert.match(builder, /"purpose": "manual-test-package"/);
  assert.match(builder, /"promotable": false/);
  assert.doesNotMatch(builder, /formal-release-candidate/);
  assert.doesNotMatch(builder, /release-promotion|candidate-evidence|candidate-build-provenance/);
});

test('手工入口只负责选择平台并调用测试包构建器', () => {
  const manual = readFileSync(
    path.join(repositoryRoot, '.github/workflows/manual-test-package.yml'),
    'utf8',
  );
  assert.match(manual, /^\s{2}workflow_dispatch:/m);
  assert.match(manual, /uses:\s*\.\/\.github\/workflows\/test-package-build\.yml/);
  assert.match(manual, /source_sha:\s*\$\{\{ github\.sha \}\}/);
  assert.doesNotMatch(manual, /candidate-build\.yml|formal-release/);
});

test('稳定文件名重新签名复用构建阶段生成的同一临时私钥', () => {
  const builder = readFileSync(
    path.join(repositoryRoot, '.github/workflows/test-package-build.yml'),
    'utf8',
  );
  const signingStep = builder.slice(
    builder.indexOf('- name: 整理稳定测试资产名'),
    builder.indexOf('- name: 回验 Linux 测试安装包'),
  );

  assert.match(
    signingStep,
    /TAURI_SIGNING_PRIVATE_KEY:\s*\$\{\{ runner\.temp \}\}\/test-updater\.key/,
  );
  assert.match(
    builder,
    /echo "TAURI_SIGNING_PRIVATE_KEY_PASSWORD=\$TEST_KEY_PASSWORD" >> "\$GITHUB_ENV"/,
  );
});
