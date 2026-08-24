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

test('cryptographically verifies a Tauri updater signature with its public key', (t) => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'skill-expert-signature-'));
  t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));
  const keyPair = generateKeyPair(fixtureRoot, 'signing');
  const artifactPath = path.join(fixtureRoot, 'canary.txt');
  writeFileSync(artifactPath, 'skill-expert-updater-canary\n');
  const signaturePath = sign(artifactPath, keyPair);

  const result = runVerifier(artifactPath, signaturePath, keyPair.publicKeyPath);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Updater signature verified/);
});

test('rejects a valid signature when the configured public key is different', (t) => {
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

  assert.notEqual(result.status, 0, 'a mismatched public key must fail');
  assert.match(result.stderr, /key ID|signature verification failed/);
  assert.notEqual(readFileSync(signaturePath, 'utf8').trim(), '');
});

test('rejects an artifact changed after it was signed', (t) => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'skill-expert-signature-'));
  t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));
  const keyPair = generateKeyPair(fixtureRoot, 'signing');
  const artifactPath = path.join(fixtureRoot, 'canary.txt');
  writeFileSync(artifactPath, 'skill-expert-updater-canary\n');
  const signaturePath = sign(artifactPath, keyPair);
  writeFileSync(artifactPath, 'tampered-after-signing\n');

  const result = runVerifier(artifactPath, signaturePath, keyPair.publicKeyPath);

  assert.notEqual(result.status, 0, 'tampered content must fail');
  assert.match(result.stderr, /signature verification failed/);
});
