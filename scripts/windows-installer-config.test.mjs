import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tauriConfig = JSON.parse(
  readFileSync(path.join(repositoryRoot, 'src-tauri/tauri.conf.json'), 'utf8'),
);
const wixConfig = tauriConfig.bundle?.windows?.wix;

test('中文桌面显示名称必须显式使用简体中文 WiX 安装语言', () => {
  assert.equal(
    wixConfig?.language,
    'zh-CN',
    '默认 en-US MSI 代码页不能安全承载中文 productName',
  );
});

test('Windows MSI 重命名后必须保留既有 Skill Expert 升级身份', () => {
  assert.equal(
    wixConfig?.upgradeCode,
    'ebbb86b0-094a-56a4-9293-56350a87189d',
    '更改 productName 会改变 Tauri 默认 upgradeCode，必须显式固定旧值',
  );
});
