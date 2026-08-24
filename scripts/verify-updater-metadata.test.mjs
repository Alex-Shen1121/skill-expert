import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const verifier = path.join(repositoryRoot, 'scripts/verify-updater-metadata.mjs');
const canonicalDownloadRoot =
  'https://github.com/Alex-Shen1121/skill-expert/releases/download/v1.0.0';

function tauriSignatureFixture(fileName) {
  const signatureBytes = Buffer.alloc(74, 1);
  signatureBytes[0] = 0x45;
  signatureBytes[1] = 0x44;
  const signature = signatureBytes.toString('base64');
  const globalSignature = Buffer.alloc(64, 2).toString('base64');
  return Buffer.from(
    [
      'untrusted comment: signature from tauri secret key',
      signature,
      `trusted comment: timestamp:1787592911\tfile:${fileName}`,
      globalSignature,
      '',
    ].join('\n'),
  ).toString('base64');
}

function completeMetadata() {
  return {
    version: '1.0.0',
    notes: 'Skill Expert 1.0.0',
    pub_date: '2026-08-25T00:00:00Z',
    platforms: {
      'darwin-aarch64': {
        signature: tauriSignatureFixture('skill-expert-v1.0.0-macos-arm64.app.tar.gz'),
        url: `${canonicalDownloadRoot}/skill-expert-v1.0.0-macos-arm64.app.tar.gz`,
      },
      'darwin-x86_64': {
        signature: tauriSignatureFixture('skill-expert-v1.0.0-macos-x64.app.tar.gz'),
        url: `${canonicalDownloadRoot}/skill-expert-v1.0.0-macos-x64.app.tar.gz`,
      },
      'linux-x86_64': {
        signature: tauriSignatureFixture('skill-expert-v1.0.0-linux-x64.AppImage'),
        url: `${canonicalDownloadRoot}/skill-expert-v1.0.0-linux-x64.AppImage`,
      },
      'windows-x86_64': {
        signature: tauriSignatureFixture('skill-expert-v1.0.0-windows-x64-setup.exe'),
        url: `${canonicalDownloadRoot}/skill-expert-v1.0.0-windows-x64-setup.exe`,
      },
    },
  };
}

function runVerifier(t, metadata) {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'skill-expert-latest-json-'));
  t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));
  const metadataPath = path.join(fixtureRoot, 'latest.json');
  writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
  return spawnSync(
    process.execPath,
    [verifier, '--file', metadataPath, '--version', '1.0.0'],
    { encoding: 'utf8' },
  );
}

test('accepts complete signed updater metadata for all four Skill Expert targets', (t) => {
  const result = runVerifier(t, completeMetadata());

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Updater metadata verified for 1\.0\.0 \(4 platforms\)/);
});

test('rejects updater metadata when any platform signature is missing', (t) => {
  const metadata = completeMetadata();
  delete metadata.platforms['linux-x86_64'].signature;

  const result = runVerifier(t, metadata);

  assert.notEqual(result.status, 0, 'unsigned updater metadata must fail');
  assert.match(result.stderr, /missing a signature for linux-x86_64/);
});

test('rejects updater metadata with a malformed Tauri signature', (t) => {
  const metadata = completeMetadata();
  metadata.platforms['linux-x86_64'].signature = 'signed-linux-x64';

  const result = runVerifier(t, metadata);

  assert.notEqual(result.status, 0, 'garbage signature text must fail');
  assert.match(result.stderr, /malformed Tauri signature for linux-x86_64/);
});

test('rejects a Tauri signature payload with the wrong algorithm identifier', (t) => {
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

  assert.notEqual(result.status, 0, 'non-Ed25519 signature payload must fail');
  assert.match(result.stderr, /malformed Tauri signature for linux-x86_64/);
});

test('rejects updater metadata that downloads from the upstream repository', (t) => {
  const metadata = completeMetadata();
  metadata.platforms['windows-x86_64'].url =
    'https://github.com/xingkongliang/skills-manager/releases/download/v1.0.0/Skills.Manager_1.0.0_x64-setup.exe';

  const result = runVerifier(t, metadata);

  assert.notEqual(result.status, 0, 'upstream updater URLs must fail');
  assert.match(result.stderr, /URL mismatch for windows-x86_64/);
});
