#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expectedCandidateAssets } from './candidate-assets.mjs';
import { verifyUpdaterSignature } from './updater-signature.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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
  if (!options.directory || !options.version || !options.target) {
    throw new Error('用法：sign-release-updater.mjs --directory 路径 --version x.y.z --target 平台');
  }
  return options;
}

function configuredPublicKey(options) {
  if (options['public-key']) return fs.readFileSync(options['public-key'], 'utf8');
  const config = JSON.parse(
    fs.readFileSync(path.join(repositoryRoot, 'src-tauri/tauri.conf.json'), 'utf8'),
  );
  const publicKey = config.plugins?.updater?.pubkey;
  if (typeof publicKey !== 'string' || publicKey.trim() === '') {
    throw new Error('产品配置缺少 Updater 公钥');
  }
  return publicKey;
}

function requireRegularFile(filePath, label) {
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) throw new Error(`${label} 不是普通文件：${filePath}`);
}

export function signReleaseUpdaterAssets(options) {
  const publicKeyValue = configuredPublicKey(options);
  const signatureNames = expectedCandidateAssets(options.version, options.target).filter(
    (name) => name.endsWith('.sig'),
  );
  if (signatureNames.length === 0) {
    throw new Error(`${options.target} 没有需要重新签署的 Updater 资产`);
  }

  const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  for (const signatureName of signatureNames) {
    const artifactName = signatureName.slice(0, -'.sig'.length);
    const artifactPath = path.join(options.directory, artifactName);
    const signaturePath = path.join(options.directory, signatureName);
    requireRegularFile(artifactPath, 'Updater 资产');
    fs.rmSync(signaturePath, { force: true });
    const signing = spawnSync(npx, ['tauri', 'signer', 'sign', artifactPath], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: process.env,
    });
    if (signing.status !== 0) {
      throw new Error(
        `${artifactName} 重新签署失败：${signing.stderr.trim() || signing.stdout.trim()}`,
      );
    }
    requireRegularFile(signaturePath, 'Updater 签名');
    verifyUpdaterSignature({
      artifact: fs.readFileSync(artifactPath),
      signatureValue: fs.readFileSync(signaturePath, 'utf8'),
      publicKeyValue,
      expectedFileName: artifactName,
    });
    console.log(`已用稳定文件名重新签署并验证：${artifactName}`);
  }
  return signatureNames;
}

function main() {
  try {
    const options = parseArguments(process.argv.slice(2));
    const signatures = signReleaseUpdaterAssets(options);
    console.log(`${options.target} 正式 Updater 签名完成（${signatures.length} 个）。`);
  } catch (error) {
    console.error(`正式 Updater 重新签署失败：${error.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
