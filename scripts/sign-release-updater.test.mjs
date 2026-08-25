import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { tauriSignerInvocation } from './sign-release-updater.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const signer = path.join(repositoryRoot, 'scripts/sign-release-updater.mjs');
const verifier = path.join(repositoryRoot, 'scripts/verify-updater-signature.mjs');
const tauriCli = path.join(repositoryRoot, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');
const version = '1.2.3';

function generateKeyPair(root, name) {
  const keyPath = path.join(root, `${name}.key`);
  const password = `${name}-fixture-password`;
  const result = spawnSync(
    process.execPath,
    [
      tauriCli,
      'signer',
      'generate',
      '--ci',
      '--force',
      '--password',
      password,
      '--write-keys',
      keyPath,
    ],
    { cwd: repositoryRoot, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  return { keyPath, publicKeyPath: `${keyPath}.pub`, password };
}

test('Updater 重签跨平台直接调用 Node CLI 而不依赖 cmd shim', () => {
  const invocation = tauriSignerInvocation('C:\\候选包\\Skill Expert.exe');

  assert.equal(invocation.command, process.execPath);
  assert.match(invocation.args[0], /@tauri-apps[\\/]cli[\\/]tauri\.js$/);
  assert.deepEqual(invocation.args.slice(1), [
    'signer',
    'sign',
    'C:\\候选包\\Skill Expert.exe',
  ]);
});

function runSigner(directory, target, keyPair, publicKeyPath = keyPair.publicKeyPath) {
  return spawnSync(
    process.execPath,
    [
      signer,
      '--directory',
      directory,
      '--version',
      version,
      '--target',
      target,
      '--public-key',
      publicKeyPath,
    ],
    {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        TAURI_SIGNING_PRIVATE_KEY_PATH: keyPair.keyPath,
        TAURI_SIGNING_PRIVATE_KEY_PASSWORD: keyPair.password,
      },
    },
  );
}

function verify(artifactPath, publicKeyPath) {
  return spawnSync(
    process.execPath,
    [
      verifier,
      '--file',
      artifactPath,
      '--signature',
      `${artifactPath}.sig`,
      '--public-key',
      publicKeyPath,
    ],
    { cwd: repositoryRoot, encoding: 'utf8' },
  );
}

test('稳定重命名后重新签署全部 Windows Updater 资产并绑定最终文件名', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'skill-expert-release-sign-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, 'assets');
  mkdirSync(directory);
  const keyPair = generateKeyPair(root, 'production');
  const artifacts = [
    `skill-expert-v${version}-windows-x64-setup.exe`,
    `skill-expert-v${version}-windows-x64.msi`,
  ];
  for (const artifact of artifacts) {
    writeFileSync(path.join(directory, artifact), `正式资产：${artifact}\n`);
    writeFileSync(path.join(directory, `${artifact}.sig`), '旧文件名对应的签名\n');
  }

  const result = runSigner(directory, 'windows-x64', keyPair);

  assert.equal(result.status, 0, result.stderr);
  for (const artifact of artifacts) {
    const verification = verify(path.join(directory, artifact), keyPair.publicKeyPath);
    assert.equal(verification.status, 0, verification.stderr);
  }
});

test('正式私钥与产品公钥不匹配时在上传前失败', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'skill-expert-release-sign-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, 'assets');
  mkdirSync(directory);
  const signingKey = generateKeyPair(root, 'signing');
  const differentKey = generateKeyPair(root, 'different');
  const artifact = `skill-expert-v${version}-linux-x64.AppImage`;
  writeFileSync(path.join(directory, artifact), 'Linux 正式资产\n');
  writeFileSync(path.join(directory, `${artifact}.sig`), '旧签名\n');

  const result = runSigner(directory, 'linux-x64', signingKey, differentKey.publicKeyPath);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /签名密钥标识与已配置公钥不匹配/);
});
