import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const checker = path.join(repositoryRoot, 'scripts/check-updater-trust.mjs');
const canonicalEndpoint =
  'https://github.com/Alex-Shen1121/skill-expert/releases/latest/download/latest.json';
const independentFixturePublicKey =
  'dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEFFRTUyMDkyQ0QxMTc0NjQKUldSa2RCSE5raURscm5tN0pIeTBBOWtCYW9ZTGVLSW1Nalk1THd4b28rRWZMak52RHNiaXVadUkK';
const upstreamPublicKey =
  'dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IERBRUYwMTBDOEQ3MDdEODAKUldTQWZYQ05EQUh2Mm0wNDZtNm5VYWJpbjRaZVJQRUhrQ2tkOXc3MHBWZ2VaREo0OVd3WEU3d0oK';

function replacePublicKeyComment(publicKey, keyId) {
  const [, encodedKey] = Buffer.from(publicKey, 'base64').toString('utf8').split('\n');
  return Buffer.from(
    `untrusted comment: minisign public key: ${keyId}\n${encodedKey}\n`,
  ).toString('base64');
}

function replaceMinisignKeyId(publicKey, keyIdBytes) {
  const [, encodedKey] = Buffer.from(publicKey, 'base64').toString('utf8').split('\n');
  const keyBytes = Buffer.from(encodedKey, 'base64');
  keyIdBytes.copy(keyBytes, 2);
  const displayedKeyId = Buffer.from(keyIdBytes)
    .reverse()
    .toString('hex')
    .toUpperCase();
  return Buffer.from(
    `untrusted comment: minisign public key: ${displayedKeyId}\n${keyBytes.toString('base64')}\n`,
  ).toString('base64');
}

function createFixture(t, updater) {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'skill-expert-updater-trust-'));
  t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));
  const configPath = path.join(fixtureRoot, 'src-tauri/tauri.conf.json');
  mkdirSync(path.dirname(configPath), { recursive: true });
  writeFileSync(
    configPath,
    `${JSON.stringify({ plugins: { updater } }, null, 2)}\n`,
  );
  return fixtureRoot;
}

function runChecker(fixtureRoot) {
  return spawnSync(process.execPath, [checker], {
    cwd: fixtureRoot,
    encoding: 'utf8',
  });
}

test('accepts an independent updater public key and the canonical Skill Expert feed', (t) => {
  const fixtureRoot = createFixture(t, {
    pubkey: independentFixturePublicKey,
    endpoints: [canonicalEndpoint],
  });

  const result = runChecker(fixtureRoot);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Updater trust check passed/);
});

test('rejects the upstream updater public key', (t) => {
  const fixtureRoot = createFixture(t, {
    pubkey: upstreamPublicKey,
    endpoints: [canonicalEndpoint],
  });

  const result = runChecker(fixtureRoot);

  assert.notEqual(result.status, 0, 'the upstream updater key must not be trusted');
  assert.match(result.stderr, /upstream updater public key/);
});

test('rejects a non-canonical base64 updater public key', (t) => {
  const fixtureRoot = createFixture(t, {
    pubkey: `${independentFixturePublicKey}!`,
    endpoints: [canonicalEndpoint],
  });

  const result = runChecker(fixtureRoot);

  assert.notEqual(result.status, 0, 'malformed base64 must not be accepted');
  assert.match(result.stderr, /updater public key/);
});

test('rejects a malformed minisign public key payload', (t) => {
  const malformedPublicKey = Buffer.from(
    'untrusted comment: minisign public key: AEE52092CD117464\nRWx\n',
  ).toString('base64');
  const fixtureRoot = createFixture(t, {
    pubkey: malformedPublicKey,
    endpoints: [canonicalEndpoint],
  });

  const result = runChecker(fixtureRoot);

  assert.notEqual(result.status, 0, 'a malformed minisign payload must fail');
  assert.match(result.stderr, /updater public key/);
});

test('rejects upstream key bytes even when the public-key comment is forged', (t) => {
  const fixtureRoot = createFixture(t, {
    pubkey: replacePublicKeyComment(upstreamPublicKey, 'AEE52092CD117464'),
    endpoints: [canonicalEndpoint],
  });

  const result = runChecker(fixtureRoot);

  assert.notEqual(result.status, 0, 'upstream key bytes must not be trusted');
  assert.match(result.stderr, /upstream updater public key/);
});

test('rejects upstream Ed25519 material even when its key ID is replaced', (t) => {
  const fixtureRoot = createFixture(t, {
    pubkey: replaceMinisignKeyId(
      upstreamPublicKey,
      Buffer.from('0123456789abcdef', 'hex'),
    ),
    endpoints: [canonicalEndpoint],
  });

  const result = runChecker(fixtureRoot);

  assert.notEqual(result.status, 0, 'upstream Ed25519 material must not be trusted');
  assert.match(result.stderr, /upstream updater public key/);
});
