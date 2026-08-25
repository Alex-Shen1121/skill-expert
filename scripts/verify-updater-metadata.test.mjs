import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after, before } from 'node:test';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const verifier = path.join(repositoryRoot, 'scripts/verify-updater-metadata.mjs');
const canonicalDownloadRoot =
  'https://github.com/Alex-Shen1121/skill-expert/releases/download/v1.0.0';
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const assetNames = {
  'darwin-aarch64': 'skill-expert-v1.0.0-macos-arm64.app.tar.gz',
  'darwin-x86_64': 'skill-expert-v1.0.0-macos-x64.app.tar.gz',
  'linux-x86_64': 'skill-expert-v1.0.0-linux-x64.AppImage',
  'windows-x86_64': 'skill-expert-v1.0.0-windows-x64-setup.exe',
};
const sharedRoot = mkdtempSync(path.join(tmpdir(), 'skill-expert-metadata-signing-'));
const keyPath = path.join(sharedRoot, 'updater.key');
const publicKeyPath = `${keyPath}.pub`;
const signingPassword = 'metadata-fixture-password';
let signedMetadata;

function runTauri(args) {
  const result = spawnSync(npx, ['tauri', 'signer', ...args], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
}

before(() => {
  runTauri([
    'generate',
    '--ci',
    '--force',
    '--password',
    signingPassword,
    '--write-keys',
    keyPath,
  ]);
  signedMetadata = {
    version: '1.0.0',
    notes: 'Skill Expert 1.0.0',
    pub_date: '2026-08-25T00:00:00Z',
    platforms: {},
  };
  for (const [platform, assetName] of Object.entries(assetNames)) {
    const assetPath = path.join(sharedRoot, assetName);
    writeFileSync(assetPath, `signed fixture for ${platform}\n`);
    runTauri([
      'sign',
      '--private-key-path',
      keyPath,
      '--password',
      signingPassword,
      assetPath,
    ]);
    signedMetadata.platforms[platform] = {
      signature: readFileSync(`${assetPath}.sig`, 'utf8').trim(),
      url: `${canonicalDownloadRoot}/${assetName}`,
    };
  }
});

after(() => rmSync(sharedRoot, { recursive: true, force: true }));

function completeMetadata() {
  return structuredClone(signedMetadata);
}

function runVerifier(t, metadata, overridePublicKeyPath = publicKeyPath) {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'skill-expert-latest-json-'));
  t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));
  const metadataPath = path.join(fixtureRoot, 'latest.json');
  for (const assetName of Object.values(assetNames)) {
    copyFileSync(path.join(sharedRoot, assetName), path.join(fixtureRoot, assetName));
  }
  writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
  return spawnSync(
    process.execPath,
    [
      verifier,
      '--file',
      metadataPath,
      '--version',
      '1.0.0',
      '--asset-directory',
      fixtureRoot,
      '--public-key',
      overridePublicKeyPath,
    ],
    { cwd: repositoryRoot, encoding: 'utf8' },
  );
}

test('接受四个产物均通过密码学验证的完整元数据', (t) => {
  const result = runVerifier(t, completeMetadata());

  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /Updater 元数据和产物签名验证通过：1\.0\.0（4 个平台）/,
  );
});

test('拒绝结构有效但没有密码学证明的随机签名字节', (t) => {
  const metadata = completeMetadata();
  const signatureBytes = Buffer.alloc(74, 1);
  signatureBytes[0] = 0x45;
  signatureBytes[1] = 0x44;
  metadata.platforms['linux-x86_64'].signature = Buffer.from(
    [
      'untrusted comment: signature from tauri secret key',
      signatureBytes.toString('base64'),
      'trusted comment: timestamp:1787592911\tfile:skill-expert-v1.0.0-linux-x64.AppImage',
      Buffer.alloc(64, 2).toString('base64'),
      '',
    ].join('\n'),
  ).toString('base64');

  const result = runVerifier(t, metadata);

  assert.notEqual(result.status, 0, '不得信任随机签名字节');
  assert.match(result.stderr, /签名验证失败|密钥标识/);
});

test('任一平台签名缺失时拒绝 Updater 元数据', (t) => {
  const metadata = completeMetadata();
  delete metadata.platforms['linux-x86_64'].signature;

  const result = runVerifier(t, metadata);

  assert.notEqual(result.status, 0, '没有签名的 Updater 元数据必须失败');
  assert.match(result.stderr, /缺少 linux-x86_64 的签名/);
});

test('拒绝包含格式错误 Tauri 签名的 Updater 元数据', (t) => {
  const metadata = completeMetadata();
  metadata.platforms['linux-x86_64'].signature = 'signed-linux-x64';

  const result = runVerifier(t, metadata);

  assert.notEqual(result.status, 0, '无效签名文本必须失败');
  assert.match(result.stderr, /linux-x86_64 签名验证失败/);
});

test('拒绝算法标识错误的 Tauri 签名载荷', (t) => {
  const metadata = completeMetadata();
  const outer = Buffer.from(metadata.platforms['linux-x86_64'].signature, 'base64')
    .toString('utf8')
    .split('\n');
  const signatureBytes = Buffer.from(outer[1], 'base64');
  signatureBytes[0] = 0x01;
  signatureBytes[1] = 0x01;
  outer[1] = signatureBytes.toString('base64');
  metadata.platforms['linux-x86_64'].signature = Buffer.from(outer.join('\n')).toString(
    'base64',
  );

  const result = runVerifier(t, metadata);

  assert.notEqual(result.status, 0, '非 Ed25519 签名载荷必须失败');
  assert.match(result.stderr, /不受支持的算法或长度/);
});

test('拒绝从上游仓库下载的 Updater 元数据', (t) => {
  const metadata = completeMetadata();
  metadata.platforms['windows-x86_64'].url =
    'https://github.com/xingkongliang/skills-manager/releases/download/v1.0.0/Skills.Manager_1.0.0_x64-setup.exe';

  const result = runVerifier(t, metadata);

  assert.notEqual(result.status, 0, '上游 Updater URL 必须失败');
  assert.match(result.stderr, /windows-x86_64 URL 不匹配/);
});

test('已配置公钥不同时拒绝全部元数据签名', (t) => {
  const differentKeyPath = path.join(sharedRoot, 'different.key');
  runTauri([
    'generate',
    '--ci',
    '--force',
    '--password',
    'different-fixture-password',
    '--write-keys',
    differentKeyPath,
  ]);

  const result = runVerifier(t, completeMetadata(), `${differentKeyPath}.pub`);

  assert.notEqual(result.status, 0, '不同信任根必须失败');
  assert.match(result.stderr, /密钥标识.*不匹配/);
});
