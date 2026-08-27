import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('AGENTS.md 给出稳定版本、轻量 PR 和明确发布授权边界', () => {
  const agents = readFileSync(path.join(repositoryRoot, 'AGENTS.md'), 'utf8');

  assert.match(agents, /源码版本只允许稳定的 `x\.y\.z`/);
  assert.match(agents, /普通[^\n]+PR[^\n]+不修改版本号/);
  assert.match(agents, /GitHub Actions syntax/);
  assert.match(agents, /Frontend and version contract/);
  assert.match(agents, /Rust quality and Linux check/);
  assert.match(agents, /upstream-tracking\/main[^\n]+不是开发分支[^\n]+唯一例外/);
  assert.match(agents, /普通 PR[^\n]+不运行 macOS\/Windows Rust 测试[^\n]+不构建 Tauri/);
  assert.match(agents, /明确说“发布新版本”或“发布 `vX\.Y\.Z`”/);
  assert.match(agents, /npm run release:prepare -- patch/);
  assert.match(agents, /npm run release:prepare -- X\.Y\.Z/);
  assert.match(agents, /codex\/release-vX\.Y\.Z/);
  assert.match(agents, /对该精确 SHA 手动触发/);
  assert.match(agents, /三项 `main` push 检查全部成功/);
  assert.match(agents, /历史分支[^\n]+不得依赖/);
  assert.match(agents, /promotable: false/);
});
