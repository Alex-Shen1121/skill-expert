import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const guide = readFileSync(path.join(repositoryRoot, 'docs/formal-release.md'), 'utf8');
const readme = readFileSync(path.join(repositoryRoot, 'README.md'), 'utf8');
const readmeZh = readFileSync(path.join(repositoryRoot, 'README.zh-CN.md'), 'utf8');

test('正式发布指南记录明确授权、发布 PR 和精确 main SHA', () => {
  assert.match(guide, /明确说“发布新版本”或“发布 `vX\.Y\.Z`”/);
  assert.match(guide, /codex\/release-vX\.Y\.Z/);
  assert.match(guide, /npm run release:prepare -- patch/);
  assert.match(guide, /npm run release:prepare -- X\.Y\.Z/);
  assert.match(guide, /release_sha/);
  assert.match(guide, /40 位 SHA/);
  assert.match(guide, /不读取或修改历史 `release` 分支/);
});

test('正式发布指南记录单次四平台构建和完整公开门禁', () => {
  assert.match(guide, /macOS arm64、macOS x64、Windows x64 和 Linux x64/);
  assert.match(guide, /macOS 与 Windows[^\n]+Rust 测试/);
  assert.match(guide, /`release` Environment[\s\S]*TAURI_SIGNING_PRIVATE_KEY/);
  assert.match(guide, /annotated `vX\.Y\.Z` tag/);
  assert.match(guide, /Draft/);
  assert.match(guide, /build-provenance\.json/);
  assert.match(guide, /SHA256SUMS/);
  assert.match(guide, /重新下载 GitHub 保存的真实字节/);
  assert.match(guide, /公开 Draft[^\n]+Latest/);
  assert.match(guide, /共 12 个资产/);
  assert.match(guide, /CLI[^\n]+不再作为 Release 下载/);
  assert.match(guide, /\.sig[^\n]+不再单独公开/);
});

test('正式发布指南记录失败版本与 macOS 分发边界', () => {
  assert.match(guide, /tag 创建前失败[^\n]+同一版本/);
  assert.match(guide, /tag 或 Draft 一旦创建[^\n]+不得[^\n]+复用版本/);
  assert.match(guide, /Updater 不自动降级/);
  assert.match(guide, /ad-hoc[\s\S]*仍要打开/);
});

test('README 只提供本地 CLI 安装方式而不承诺 Release 下载', () => {
  assert.match(readmeZh, /npm run cli:install/);
  assert.match(readme, /npm run cli:install/);
  assert.doesNotMatch(readmeZh, /正式 Release[^\n]+独立 CLI/);
  assert.doesNotMatch(readme, /Official releases[^\n]+standalone CLI/);
});
