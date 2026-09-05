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
    /TAURI_SIGNING_PRIVATE_KEY_PATH:\s*\$\{\{ runner\.temp \}\}\/test-updater\.key/,
  );
  assert.doesNotMatch(signingStep, /^\s*TAURI_SIGNING_PRIVATE_KEY:/m);
  assert.match(
    builder,
    /echo "TAURI_SIGNING_PRIVATE_KEY_PASSWORD=\$TEST_KEY_PASSWORD" >> "\$GITHUB_ENV"/,
  );
});

test('Windows 与 Linux 在构建不可晋级测试包前运行受控进程 fixture', () => {
  const builder = readFileSync(
    path.join(repositoryRoot, '.github/workflows/test-package-build.yml'),
    'utf8',
  );
  const testStep = builder.indexOf('- name: 运行受控进程跨平台测试');
  const cliBuildStep = builder.indexOf('- name: 构建独立 CLI');

  assert.ok(testStep > 0);
  assert.ok(testStep < cliBuildStep);
  assert.match(
    builder.slice(testStep, cliBuildStep),
    /if: runner\.os == 'Windows' \|\| runner\.os == 'Linux'/,
  );
  assert.match(
    builder.slice(testStep, cliBuildStep),
    /cargo test --locked[\s\S]*--target "\$\{\{ matrix\.rust_target \}\}"[\s\S]*core::process_runner::tests/,
  );
});

test('手工入口提供不产包且不可晋级的 Windows 与 Linux 进程验证模式', () => {
  const manual = readFileSync(
    path.join(repositoryRoot, '.github/workflows/manual-test-package.yml'),
    'utf8',
  );
  const validationStart = manual.indexOf('  validate-process-runner:');
  const packageStart = manual.indexOf('  manual-package:');
  const validationJob = manual.slice(validationStart, packageStart);

  assert.ok(validationStart > 0);
  assert.ok(packageStart > validationStart);
  assert.match(manual, /validation_only:[\s\S]*type: boolean/);
  assert.match(validationJob, /if: inputs\.validation_only == true/);
  assert.match(validationJob, /runner: \[windows-latest, ubuntu-22\.04\]/);
  assert.match(validationJob, /PROMOTABLE: ['\"]false['\"]/);
  assert.match(
    validationJob,
    /cargo test --locked[\s\S]*core::process_runner::tests/,
  );
  assert.match(
    validationJob,
    /cargo check --locked[\s\S]*--all-targets/,
  );
  assert.doesNotMatch(
    validationJob,
    /tauri(?:\s+--)?\s+build|upload-artifact|gh release|git tag|workflow_call/,
  );
  assert.match(
    manual,
    /select-targets:[\s\S]*if: inputs\.validation_only == false/,
  );
  assert.match(
    manual.slice(packageStart),
    /if: inputs\.validation_only == false[\s\S]*uses: \.\/\.github\/workflows\/test-package-build\.yml/,
  );
});
