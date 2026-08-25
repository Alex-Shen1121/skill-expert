#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyUpdaterSignature } from './updater-signature.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const platformAssets = {
  'darwin-aarch64': 'skill-expert-vVERSION-macos-arm64.app.tar.gz',
  'darwin-x86_64': 'skill-expert-vVERSION-macos-x64.app.tar.gz',
  'linux-x86_64': 'skill-expert-vVERSION-linux-x64.AppImage',
  'windows-x86_64': 'skill-expert-vVERSION-windows-x64-setup.exe',
};

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
  return options;
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  if (!options.file || !options.version || !options['asset-directory']) {
    throw new Error(
      '用法：verify-updater-metadata.mjs --file latest.json --version x.y.z --asset-directory artifacts [--public-key updater.pub]',
    );
  }
  if (!/^\d+\.\d+\.\d+$/.test(options.version)) {
    throw new Error(`版本必须是稳定的 x.y.z 值，实际为 ${options.version}`);
  }

  const metadata = JSON.parse(fs.readFileSync(options.file, 'utf8'));
  const publicKeyValue = options['public-key']
    ? fs.readFileSync(options['public-key'], 'utf8')
    : JSON.parse(
        fs.readFileSync(path.join(repositoryRoot, 'src-tauri/tauri.conf.json'), 'utf8'),
      ).plugins?.updater?.pubkey;
  if (metadata.version !== options.version) {
    throw new Error(
      `latest.json 版本不匹配：预期 ${options.version}，实际为 ${metadata.version ?? '缺失'}`,
    );
  }

  const expectedPlatforms = Object.keys(platformAssets).sort();
  const actualPlatforms = Object.keys(metadata.platforms ?? {}).sort();
  if (JSON.stringify(actualPlatforms) !== JSON.stringify(expectedPlatforms)) {
    throw new Error(
      `latest.json 平台不匹配：预期 ${expectedPlatforms.join('、')}，实际为 ${actualPlatforms.join('、') || '无'}`,
    );
  }

  const downloadRoot =
    `https://github.com/Alex-Shen1121/skill-expert/releases/download/v${options.version}`;
  for (const [platform, assetPattern] of Object.entries(platformAssets)) {
    const entry = metadata.platforms[platform];
    const assetName = assetPattern.replace('VERSION', options.version);
    if (typeof entry.signature !== 'string' || entry.signature.trim() === '') {
      throw new Error(`latest.json 缺少 ${platform} 的签名`);
    }
    const expectedUrl = `${downloadRoot}/${assetName}`;
    if (entry.url !== expectedUrl) {
      throw new Error(`latest.json 的 ${platform} URL 不匹配：预期 ${expectedUrl}`);
    }
    try {
      verifyUpdaterSignature({
        artifact: fs.readFileSync(path.join(options['asset-directory'], assetName)),
        signatureValue: entry.signature,
        publicKeyValue,
        expectedFileName: assetName,
      });
    } catch (error) {
      throw new Error(
        `latest.json 的 ${platform} 签名验证失败：${error.message}`,
      );
    }
  }

  console.log(
    `Updater 元数据和产物签名验证通过：${options.version}（${expectedPlatforms.length} 个平台）。`,
  );
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
