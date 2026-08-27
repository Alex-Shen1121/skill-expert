import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const guidePath = path.join(repositoryRoot, 'docs/updater-trust-root.md');

test('Updater 信任指南记录 Secret 边界、恢复和两阶段轮换', () => {
  const guide = fs.readFileSync(guidePath, 'utf8');

  assert.match(guide, /`?release`? Environment/i);
  assert.match(guide, /TAURI_SIGNING_PRIVATE_KEY/);
  assert.match(guide, /TAURI_SIGNING_PRIVATE_KEY_PASSWORD/);
  assert.match(guide, /updater-key-recovery\.mjs create/);
  assert.match(guide, /updater-key-recovery\.mjs restore/);
  assert.match(guide, /verify-updater-metadata\.mjs/);
  assert.match(guide, /verify-updater-signature\.mjs/);
  assert.match(guide, /对列出的每个产物执行密码学签名验证/);
  assert.match(guide, /非空的 `?\.sig`? 文件本身不能证明/);
  assert.match(guide, /原子发布/);
  assert.match(guide, /chmod 600/);
  assert.match(guide, /不同物理位置|不同介质/);
  assert.match(guide, /阶段 1[\s\S]*旧私钥[\s\S]*新公钥/);
  assert.match(guide, /阶段 2[\s\S]*新私钥/);
  assert.match(guide, /手动重新安装/);
  assert.match(guide, /手工测试包[\s\S]*临时/);
  assert.match(guide, /一次性产品配置/);
  assert.match(guide, /不是终端用户设置/);
  assert.match(guide, /npm run updater:provision/);
  assert.match(guide, /尚未配置[\s\S]*开发/);
  assert.match(guide, /main[\s\S]*正式发布工作流[\s\S]*生产/);
  assert.match(guide, /路径[\s\S]*不得提交/);
  assert.doesNotMatch(guide, /disable Gatekeeper/i);
});
