import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const verifier = path.join(repositoryRoot, 'scripts/verify-updater-signature.mjs');
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';

function generateKeyPair(root, name) {
  const keyPath = path.join(root, `${name}.key`);
  const password = `${name}-fixture-password`;
  const result = spawnSync(
    npx,
    [
      'tauri',
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

function sign(filePath, keyPair) {
  const result = spawnSync(
    npx,
    [
      'tauri',
      'signer',
      'sign',
      '--private-key-path',
      keyPair.keyPath,
      '--password',
      keyPair.password,
      filePath,
    ],
    { cwd: repositoryRoot, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  return `${filePath}.sig`;
}

function runVerifier(filePath, signaturePath, publicKeyPath) {
  return spawnSync(
    process.execPath,
    [
      verifier,
      '--file',
      filePath,
      '--signature',
      signaturePath,
      '--public-key',
      publicKeyPath,
    ],
    { cwd: repositoryRoot, encoding: 'utf8' },
  );
}

test('使用公钥对 Tauri Updater 签名执行密码学验证', (t) => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'skill-expert-signature-'));
  t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));
  const keyPair = generateKeyPair(fixtureRoot, 'signing');
  const artifactPath = path.join(fixtureRoot, 'canary.txt');
  writeFileSync(artifactPath, 'skill-expert-updater-canary\n');
  const signaturePath = sign(artifactPath, keyPair);

  const result = runVerifier(artifactPath, signaturePath, keyPair.publicKeyPath);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Updater 签名验证通过/);
});

test('已配置公钥不同时拒绝有效签名', (t) => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'skill-expert-signature-'));
  t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));
  const signingKeyPair = generateKeyPair(fixtureRoot, 'signing');
  const differentKeyPair = generateKeyPair(fixtureRoot, 'different');
  const artifactPath = path.join(fixtureRoot, 'canary.txt');
  writeFileSync(artifactPath, 'skill-expert-updater-canary\n');
  const signaturePath = sign(artifactPath, signingKeyPair);

  const result = runVerifier(
    artifactPath,
    signaturePath,
    differentKeyPair.publicKeyPath,
  );

  assert.notEqual(result.status, 0, '不匹配的公钥必须失败');
  assert.match(result.stderr, /密钥标识|签名验证失败/);
  assert.notEqual(readFileSync(signaturePath, 'utf8').trim(), '');
});

test('拒绝签名后被修改的产物', (t) => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'skill-expert-signature-'));
  t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));
  const keyPair = generateKeyPair(fixtureRoot, 'signing');
  const artifactPath = path.join(fixtureRoot, 'canary.txt');
  writeFileSync(artifactPath, 'skill-expert-updater-canary\n');
  const signaturePath = sign(artifactPath, keyPair);
  writeFileSync(artifactPath, 'tampered-after-signing\n');

  const result = runVerifier(artifactPath, signaturePath, keyPair.publicKeyPath);

  assert.notEqual(result.status, 0, '被篡改的内容必须失败');
  assert.match(result.stderr, /签名验证失败/);
});
