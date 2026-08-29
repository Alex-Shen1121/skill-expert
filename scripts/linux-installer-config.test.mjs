import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const linuxConfigPath = path.join(repositoryRoot, 'src-tauri/tauri.linux.conf.json');
const linuxConfig = existsSync(linuxConfigPath)
  ? JSON.parse(readFileSync(linuxConfigPath, 'utf8'))
  : {};
const desktopTemplate = linuxConfig.bundle?.linux?.deb?.desktopTemplate;
const templatePath = desktopTemplate
  ? path.join(repositoryRoot, 'src-tauri', desktopTemplate)
  : '';
const template = templatePath && existsSync(templatePath)
  ? readFileSync(templatePath, 'utf8')
  : '';

test('Linux 技术包名必须使用稳定的 skill-expert 身份', () => {
  assert.equal(linuxConfig.productName, 'skill-expert');
});

test('DEB、RPM 与 AppImage 必须共享同一桌面入口模板', () => {
  assert.equal(desktopTemplate, 'linux/agent-skills-manager.desktop.hbs');
  assert.equal(linuxConfig.bundle?.linux?.rpm?.desktopTemplate, desktopTemplate);
  assert.equal(existsSync(templatePath), true);
});

test('Linux 桌面入口必须保留 Agent 技能管家显示名称', () => {
  assert.match(template, /^Name=Agent 技能管家$/m);
  assert.match(template, /^Exec=\{\{exec\}\}$/m);
  assert.match(template, /^Icon=\{\{icon\}\}$/m);
});
