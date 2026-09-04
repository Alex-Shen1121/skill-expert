import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const production = JSON.parse(fs.readFileSync(path.join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
const acceptance = JSON.parse(fs.readFileSync(
  path.join(root, 'src-tauri/tauri.acceptance.conf.json'),
  'utf8',
));
const runner = fs.readFileSync(path.join(root, 'scripts/run-plugin-acceptance.mjs'), 'utf8');
const rustApp = fs.readFileSync(path.join(root, 'src-tauri/src/lib.rs'), 'utf8');

test('插件真实验收使用独立应用身份、WebView 数据和专用状态根', () => {
  assert.notEqual(acceptance.identifier, production.identifier);
  assert.match(acceptance.identifier, /\.acceptance\./);
  assert.match(acceptance.productName, /验收/);
  assert.equal(acceptance.app.windows.length, 1);
  assert.equal(acceptance.app.windows[0].width, 1100);
  assert.equal(acceptance.app.windows[0].height, 640);
  assert.equal(acceptance.app.windows[0].minWidth, 1100);
  assert.equal(acceptance.app.windows[0].minHeight, 640);
  assert.equal(acceptance.app.windows[0].dataDirectory, 'plugin-acceptance');
  assert.equal(acceptance.app.windows[0].create, false);
  assert.match(acceptance.app.security.csp, /ws:\/\/127\.0\.0\.1:\*/);
  assert.equal(acceptance.bundle.createUpdaterArtifacts, false);
  assert.equal(acceptance.build.devUrl, 'http://127.0.0.1:1432');
  assert.match(acceptance.build.beforeDevCommand, /--port 1432/);
  assert.equal(packageJson.scripts['tauri:plugin-acceptance'], 'node scripts/run-plugin-acceptance.mjs');
  assert.match(runner, /SKILL_EXPERT_ACCEPTANCE_ROOT/);
  assert.match(runner, /tauri\.acceptance\.conf\.json/);
  assert.match(runner, /run-tauri\.mjs/);
  assert.match(runner, /process\.platform === 'darwin'/);
  assert.match(runner, /\[\s*'build', '--debug', '--bundles', 'app'/s);
  assert.match(runner, /Agent 技能管家 · 插件验收\.app/);
  assert.match(runner, /Contents.*MacOS.*skill-expert/s);
  assert.match(rustApp, /ACCEPTANCE_DATA_STORE_IDENTIFIER:\s*\[u8; 16\]/);
  assert.match(
    rustApp,
    /data_store_identifier\(ACCEPTANCE_DATA_STORE_IDENTIFIER\)/,
  );
});
