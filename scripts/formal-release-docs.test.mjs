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
  assert.match(guide, /发布晋级来源[\s\S]*发布晋级契约/);
  assert.match(guide, /Release PR[\s\S]*不重新运行[\s\S]*完整[^\n]+CI/);
  assert.match(guide, /release[\s\S]*push[\s\S]*同一次 workflow/);
  assert.match(guide, /annotated[\s\S]*tag[\s\S]*绝不覆盖/);
  assert.match(guide, /workflow run ID/);
  assert.match(guide, /release Environment[\s\S]*TAURI_SIGNING_PRIVATE_KEY/);
  assert.match(guide, /唯一[^\n]+生产重签[^\n]+release Environment/);
  assert.match(guide, /不运行[^\n]+cargo build[^\n]+tauri build/);
  assert.match(guide, /逐字节复用/);
  assert.match(guide, /candidate-manifest\.json/);
  assert.match(guide, /candidate-build-provenance\.json/);
  assert.match(guide, /promotion-binding\.json/);
  assert.match(guide, /release-provenance\.json/);
  assert.match(guide, /候选构建来源证明[^\n]+main[^\n]+candidate SHA/);
  assert.match(guide, /正式来源证明[^\n]+release SHA/);
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

test('正式发布指南记录精确候选选择和 Ruleset 高层检查', () => {
  const guide = fs.readFileSync(guidePath, 'utf8');

  assert.match(guide, /run ID[^\n]+run attempt[^\n]+artifact ID[^\n]+digest/);
  assert.match(guide, /PR 正文[^\n]+不是信任根/);
  assert.match(guide, /开发集成分支[^\n]+五个完整日常 CI/);
  assert.match(guide, /发布分支[\s\S]{0,120}发布晋级来源[\s\S]{0,80}发布晋级契约/);
  assert.match(guide, /过期[^\n]+不可晋级/);
});

test('正式发布指南记录真实演练开关与旧路径退出条件', () => {
  const guide = fs.readFileSync(guidePath, 'utf8');

  assert.match(guide, /RELEASE_PIPELINE_MODE/);
  assert.match(guide, /candidate-reuse/);
  assert.match(guide, /Ruleset 回读[^\n]+真实测试版本演练/);
  assert.match(guide, /删除旧 workflow、旧资产契约脚本和该开关/);
});
