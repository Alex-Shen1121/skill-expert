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
const unprovisionedPublicKey =
  'dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEEzQzAwMTQ3Nzc3ODNEODUKUldTRlBYaDNSd0hBbzFGYzFkaXZqOFgvTTZIdTNkQjU1S3l2NmpNdXQ3TVNWdmNnckhwUEJiRUcK';

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

function runChecker(fixtureRoot, ...args) {
  return spawnSync(process.execPath, [checker, ...args], {
    cwd: fixtureRoot,
    encoding: 'utf8',
  });
}

test('接受独立 Updater 公钥和 Skill Expert 规范更新源', (t) => {
  const fixtureRoot = createFixture(t, {
    pubkey: independentFixturePublicKey,
    endpoints: [canonicalEndpoint],
  });

  const result = runChecker(fixtureRoot);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Updater 信任检查通过/);
});

test('普通开发检查接受唯一的尚未配置公钥', (t) => {
  const fixtureRoot = createFixture(t, {
    pubkey: unprovisionedPublicKey,
    endpoints: [canonicalEndpoint],
  });

  const result = runChecker(fixtureRoot);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /尚未配置/);
});

test('要求生产信任根时拒绝尚未配置公钥', (t) => {
  const fixtureRoot = createFixture(t, {
    pubkey: unprovisionedPublicKey,
    endpoints: [canonicalEndpoint],
  });

  const result = runChecker(fixtureRoot, '--require-production');

  assert.notEqual(result.status, 0, '发布必须具有生产 Updater 公钥');
  assert.match(result.stderr, /生产 Updater 公钥/);
});

test('尚未配置的密钥材料更换标识后仍被拒绝', (t) => {
  const fixtureRoot = createFixture(t, {
    pubkey: replaceMinisignKeyId(
      unprovisionedPublicKey,
      Buffer.from('fedcba9876543210', 'hex'),
    ),
    endpoints: [canonicalEndpoint],
  });

  const result = runChecker(fixtureRoot, '--require-production');

  assert.notEqual(result.status, 0, '占位公钥材料永远不能成为生产信任根');
  assert.match(result.stderr, /生产 Updater 公钥/);
});

test('拒绝上游 Updater 公钥', (t) => {
  const fixtureRoot = createFixture(t, {
    pubkey: upstreamPublicKey,
    endpoints: [canonicalEndpoint],
  });

  const result = runChecker(fixtureRoot);

  assert.notEqual(result.status, 0, '不得信任上游 Updater 公钥');
  assert.match(result.stderr, /上游 Updater 公钥/);
});

test('拒绝非规范 Base64 Updater 公钥', (t) => {
  const fixtureRoot = createFixture(t, {
    pubkey: `${independentFixturePublicKey}!`,
    endpoints: [canonicalEndpoint],
  });

  const result = runChecker(fixtureRoot);

  assert.notEqual(result.status, 0, '不得接受格式错误的 Base64');
  assert.match(result.stderr, /Updater 公钥/);
});

test('拒绝格式错误的 minisign 公钥载荷', (t) => {
  const malformedPublicKey = Buffer.from(
    'untrusted comment: minisign public key: AEE52092CD117464\nRWx\n',
  ).toString('base64');
  const fixtureRoot = createFixture(t, {
    pubkey: malformedPublicKey,
    endpoints: [canonicalEndpoint],
  });

  const result = runChecker(fixtureRoot);

  assert.notEqual(result.status, 0, '格式错误的 minisign 载荷必须失败');
  assert.match(result.stderr, /Updater 公钥/);
});

test('即使伪造公钥注释仍拒绝上游密钥字节', (t) => {
  const fixtureRoot = createFixture(t, {
    pubkey: replacePublicKeyComment(upstreamPublicKey, 'AEE52092CD117464'),
    endpoints: [canonicalEndpoint],
  });

  const result = runChecker(fixtureRoot);

  assert.notEqual(result.status, 0, '不得信任上游密钥字节');
  assert.match(result.stderr, /上游 Updater 公钥/);
});

test('即使更换密钥标识仍拒绝上游 Ed25519 材料', (t) => {
  const fixtureRoot = createFixture(t, {
    pubkey: replaceMinisignKeyId(
      upstreamPublicKey,
      Buffer.from('0123456789abcdef', 'hex'),
    ),
    endpoints: [canonicalEndpoint],
  });

  const result = runChecker(fixtureRoot);

  assert.notEqual(result.status, 0, '不得信任上游 Ed25519 材料');
  assert.match(result.stderr, /上游 Updater 公钥/);
});
