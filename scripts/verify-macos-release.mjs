#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { verifyAdHocSignature } from './verify-macos-adhoc.mjs';
import { verifyCliVersion } from './release-binary-version.mjs';

const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const targets = ['macos-arm64', 'macos-x64'];
const expectedAppName = 'Agent 技能管家.app';

function run(command, args) {
  return spawnSync(command, args, { encoding: 'utf8' });
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith('--') || value === undefined) {
      throw new Error(`应使用 --name value 参数，实际为 ${flag ?? '空值'}`);
    }
    options[flag.slice(2)] = value;
  }
  if (!STABLE_VERSION.test(options.version ?? '')) {
    throw new Error(`版本必须是稳定的 x.y.z，实际为 ${options.version ?? '缺失'}`);
  }
  if (!options.directory || !fs.statSync(options.directory).isDirectory()) {
    throw new Error(`正式资产目录无效：${options.directory ?? '缺失'}`);
  }
  if (options.target && !targets.includes(options.target)) {
    throw new Error(`不支持的 macOS 目标：${options.target}`);
  }
  return options;
}

function onlyTopLevelApp(directory, label) {
  const apps = fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name === expectedAppName);
  if (apps.length !== 1) {
    throw new Error(`${label} 必须包含唯一的顶层 ${expectedAppName}，实际为 ${apps.length} 个`);
  }
  return path.join(directory, apps[0].name);
}

function verifyBundleVersion(appPath, expectedVersion, label) {
  const plist = path.join(appPath, 'Contents', 'Info.plist');
  const result = run('plutil', [
    '-extract',
    'CFBundleShortVersionString',
    'raw',
    '-o',
    '-',
    plist,
  ]);
  if (result.status !== 0) {
    throw new Error(`${label} 无法读取应用版本：${result.stderr.trim()}`);
  }
  const actual = result.stdout.trim();
  if (actual !== expectedVersion) {
    throw new Error(`${label} 应用版本不匹配：预期 ${expectedVersion}，实际 ${actual}`);
  }
}

function verifySignature(label, filePath) {
  try {
    verifyAdHocSignature(label, filePath);
  } catch (error) {
    throw new Error(`${label} 签名验证失败：${error.message}`);
  }
}

function verifyArchive(archivePath, version, target) {
  const extractionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-expert-release-archive-'));
  try {
    const extraction = run('tar', ['-xzf', archivePath, '-C', extractionRoot]);
    if (extraction.status !== 0) {
      throw new Error(`${target} Updater archive 解压失败：${extraction.stderr.trim()}`);
    }
    const app = onlyTopLevelApp(extractionRoot, `${target} Updater archive`);
    verifySignature(`${target} Updater archive`, app);
    verifyBundleVersion(app, version, `${target} Updater archive`);
    console.log(`${target} Updater archive：签名与版本验证通过`);
  } finally {
    fs.rmSync(extractionRoot, { recursive: true, force: true });
  }
}

function verifyDmg(dmgPath, version, target) {
  const mountPoint = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-expert-release-dmg-'));
  let attached = false;
  try {
    const attach = run('hdiutil', [
      'attach',
      '-nobrowse',
      '-readonly',
      '-mountpoint',
      mountPoint,
      dmgPath,
    ]);
    if (attach.status !== 0) {
      throw new Error(`${target} DMG 挂载失败：${attach.stderr.trim()}`);
    }
    attached = true;
    const app = onlyTopLevelApp(mountPoint, `${target} DMG`);
    verifySignature(`${target} DMG`, app);
    verifyBundleVersion(app, version, `${target} DMG`);
    console.log(`${target} DMG：签名与版本验证通过`);
  } finally {
    if (attached) {
      const detach = run('hdiutil', ['detach', mountPoint]);
      if (detach.status !== 0) {
        console.error(`${target} DMG 卸载警告：${detach.stderr.trim()}`);
      }
    }
    fs.rmSync(mountPoint, { recursive: true, force: true });
  }
}

export function verifyMacosRelease(directory, version, target) {
  if (process.platform !== 'darwin') {
    throw new Error('macOS 正式资产回验需要带 codesign 和 hdiutil 的 macOS runner');
  }
  const selectedTargets = target ? [target] : targets;
  for (const selectedTarget of selectedTargets) {
    const prefix = `skill-expert-v${version}-${selectedTarget}`;
    const archive = path.join(directory, `${prefix}.app.tar.gz`);
    const dmg = path.join(directory, `${prefix}.dmg`);
    const cli = path.join(directory, `skill-expert-cli-v${version}-${selectedTarget}`);
    for (const [label, filePath] of [
      ['Updater archive', archive],
      ['DMG', dmg],
      ['CLI', cli],
    ]) {
      if (!fs.statSync(filePath).isFile()) throw new Error(`${selectedTarget} ${label} 不是普通文件`);
    }
    fs.chmodSync(cli, fs.statSync(cli).mode | 0o111);
    verifyArchive(archive, version, selectedTarget);
    verifyDmg(dmg, version, selectedTarget);
    verifySignature(`${selectedTarget} CLI`, cli);
    verifyCliVersion(cli, version);
    console.log(`${selectedTarget} CLI：ad-hoc 签名与版本验证通过`);
  }
}

function main() {
  try {
    const options = parseArguments(process.argv.slice(2));
    verifyMacosRelease(options.directory, options.version, options.target);
    console.log(`macOS 正式资产下载回验完成：${options.version}。`);
  } catch (error) {
    console.error(`macOS 正式资产回验失败：${error.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
