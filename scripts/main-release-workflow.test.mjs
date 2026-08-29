import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workflowPath = path.join(repositoryRoot, '.github/workflows/release.yml');
const workflow = readFileSync(workflowPath, 'utf8');
const linuxVerifier = readFileSync(
  path.join(repositoryRoot, 'scripts/verify-linux-release.mjs'),
  'utf8',
);
const windowsVerifier = readFileSync(
  path.join(repositoryRoot, 'scripts/verify-windows-release.ps1'),
  'utf8',
);

test('正式发布只能手动绑定精确 main SHA', () => {
  assert.match(workflow, /^\s{2}workflow_dispatch:\n\s{4}inputs:\n\s{6}release_sha:/m);
  assert.doesNotMatch(workflow, /^\s{2}push:/m);
  assert.match(workflow, /INPUT_RELEASE_SHA:\s*\$\{\{ inputs\.release_sha \}\}/);
  assert.match(workflow, /\^\[0-9a-f\]\{40\}\$/);
  assert.match(workflow, /refs\/heads\/main:refs\/remotes\/origin\/main/);
  assert.match(workflow, /merge-base --is-ancestor[^]*?origin\/main/);
  assert.match(workflow, /commits\/\$\{INPUT_RELEASE_SHA\}\/pulls/);
  assert.match(workflow, /\.head\.ref == \$release_ref/);
  assert.match(workflow, /\.base\.ref == "main"/);
  assert.match(workflow, /\.merge_commit_sha == \$release_sha/);
  assert.doesNotMatch(workflow, /CURRENT_MAIN_SHA/);
  assert.match(workflow, /ref:\s*\$\{\{ inputs\.release_sha \}\}/);
});

test('正式发布提交必须已经通过三项轻量检查', () => {
  assert.match(workflow, /actions\/workflows\/test\.yml\/runs\?/);
  assert.match(workflow, /event=push/);
  assert.match(workflow, /branch=main/);
  assert.match(workflow, /\.event == "push"/);
  assert.match(workflow, /\.head_branch == "main"/);
  assert.match(workflow, /\.head_sha == \$release_sha/);
  assert.match(workflow, /\.conclusion == "success"/);
  assert.match(workflow, /commits\/\$\{INPUT_RELEASE_SHA\}\/check-runs/);
  for (const check of [
    'Frontend and version contract',
    'GitHub Actions syntax',
    'Rust quality and Linux check',
  ]) {
    assert.match(workflow, new RegExp(check));
  }
  assert.match(workflow, /\.conclusion == "success"/);
  assert.match(workflow, /actions:\s*read/);
  assert.match(workflow, /pull-requests:\s*read/);
});

test('正式发布不再依赖 release 分支或候选晋级', () => {
  assert.doesNotMatch(workflow, /refs\/heads\/release|origin\/release/);
  assert.doesNotMatch(workflow, /release-promotion|promotion-binding/);
  assert.doesNotMatch(workflow, /candidate-manifest|candidate-build-provenance/);
  assert.equal(existsSync(path.join(repositoryRoot, '.github/workflows/release-legacy.yml')), false);
  assert.equal(existsSync(path.join(repositoryRoot, '.github/workflows/release-promotion.yml')), false);
  assert.equal(
    existsSync(path.join(repositoryRoot, '.github/workflows/release-promotion-dispatch.yml')),
    false,
  );
});

test('正式发布只构建一次四平台生产包并运行跨平台 Rust 测试', () => {
  assert.match(workflow, /build-release:/);
  for (const target of ['macos-arm64', 'macos-x64', 'windows-x64', 'linux-x64']) {
    assert.match(workflow, new RegExp(`target_id: ${target}`));
  }
  assert.equal((workflow.match(/npm run tauri -- build/g) ?? []).length, 1);
  assert.match(workflow, /cargo test --manifest-path src-tauri\/Cargo\.toml/);
  assert.match(workflow, /environment:\s*release/);
  assert.match(workflow, /TAURI_SIGNING_PRIVATE_KEY/);
});

test('正式发布保留 CLI 构建但不上传 CLI，并在公开前清理四个 Draft 临时资产', () => {
  assert.match(workflow, /--bin skill-expert-cli/);
  assert.match(workflow, /sign-release-updater\.mjs/);
  assert.match(
    workflow,
    /上传到同一 Draft Release[^]*?package-assets\.mjs draft-upload[^]*?gh release upload/,
  );
  assert.match(
    workflow,
    /上传元数据与完整性清单[^]*?清理 Draft 临时资产[^]*?release-assets\.mjs draft-only[^]*?gh release delete-asset/,
  );
  assert.doesNotMatch(workflow, /release-assets\/\$\{\{ matrix\.target_id \}\}\/"\*/);
  assert.match(workflow, /release-provenance:[^]*?needs: release-metadata/);
});

test('最终原生回验只要求公开的应用安装包', () => {
  assert.doesNotMatch(linuxVerifier, /verifyCliVersion|assetPaths\.cli|\bCLI\b/);
  assert.doesNotMatch(windowsVerifier, /skill-expert-cli|\$Cli|CLI/);
  assert.match(windowsVerifier, /-setup\.exe/);
  assert.match(windowsVerifier, /\.msi/);
});

test('正式发布保留不可变 tag、Draft 回验、来源证明和原子公开', () => {
  assert.match(workflow, /git\/tags/);
  assert.match(workflow, /git\/refs/);
  assert.match(workflow, /--draft/);
  assert.match(workflow, /actions\/attest@[0-9a-f]{40}/);
  assert.match(workflow, /SHA256SUMS/);
  assert.match(workflow, /verify-updater-metadata\.mjs/);
  assert.match(workflow, /verify-macos-release\.mjs/);
  assert.match(workflow, /verify-linux-release\.mjs/);
  assert.match(workflow, /verify-windows-release\.ps1/);
  assert.match(workflow, /gh release edit[^]*?--draft=false[^]*?--latest/);
});
