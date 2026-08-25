import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const guidePath = path.join(repositoryRoot, 'docs/formal-release.md');

test('正式发布指南记录唯一批准入口、完整门禁和不可变故障策略', () => {
  const guide = fs.readFileSync(guidePath, 'utf8');

  assert.match(guide, /main[\s\S]*release[\s\S]*合并即批准正式发布/);
  assert.match(guide, /release[\s\S]*push[\s\S]*同一次 workflow/);
  assert.match(guide, /annotated[\s\S]*tag[\s\S]*绝不覆盖/);
  assert.match(guide, /workflow run id/);
  assert.match(guide, /release Environment[\s\S]*TAURI_SIGNING_PRIVATE_KEY/);
  assert.match(guide, /Draft[\s\S]*四平台[\s\S]*latest\.json[\s\S]*SHA256SUMS[\s\S]*build provenance/);
  assert.match(guide, /下载回验[\s\S]*公开[\s\S]*Latest/);
  assert.match(guide, /ad-hoc[\s\S]*仍要打开/);
  assert.match(guide, /失败[\s\S]*Draft[\s\S]*不移动 tag[\s\S]*新 patch/);
  assert.match(guide, /不自动降级/);
});

test('正式发布指南把真实 Updater 配置和仓库治理列为首发前置条件', () => {
  const guide = fs.readFileSync(guidePath, 'utf8');

  assert.match(guide, /Issue #11[\s\S]*Updater/);
  assert.match(guide, /Issue #13[\s\S]*分支[\s\S]*tag[\s\S]*Environment/);
  assert.match(guide, /npm run updater:provision/);
  assert.match(guide, /不会[\s\S]*自动生成生产密钥/);
});
