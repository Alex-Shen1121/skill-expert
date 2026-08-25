#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const configPath = path.join(root, 'src-tauri/tauri.conf.json');
const canonicalEndpoint =
  'https://github.com/Alex-Shen1121/skill-expert/releases/latest/download/latest.json';
const upstreamPublicKey =
  'dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IERBRUYwMTBDOEQ3MDdEODAKUldTQWZYQ05EQUh2Mm0wNDZtNm5VYWJpbjRaZVJQRUhrQ2tkOXc3MHBWZ2VaREo0OVd3WEU3d0oK';
const unprovisionedPublicKey =
  'dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEEzQzAwMTQ3Nzc3ODNEODUKUldTRlBYaDNSd0hBbzFGYzFkaXZqOFgvTTZIdTNkQjU1S3l2NmpNdXQ3TVNWdmNnckhwUEJiRUcK';
const supportedArguments = new Set(['--require-production']);
const unknownArgument = process.argv.slice(2).find((argument) => !supportedArguments.has(argument));
if (unknownArgument) {
  console.error(`未知的 Updater 信任检查参数：${unknownArgument}`);
  process.exit(2);
}
const requireProduction = process.argv.includes('--require-production');
const failures = [];

function expect(label, condition, detail) {
  if (!condition) failures.push(`${label}: ${detail}`);
}

const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const updater = config.plugins?.updater;
const publicKey = updater?.pubkey;

function decodeCanonicalBase64(value) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(value)
  ) {
    return null;
  }
  const decoded = Buffer.from(value, 'base64');
  return decoded.toString('base64') === value ? decoded : null;
}

function inspectMinisignPublicKey(value) {
  const envelope = decodeCanonicalBase64(value);
  if (!envelope) return { valid: false, publicKeyMaterial: null };
  const text = envelope.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(envelope) || !text.endsWith('\n')) {
    return { valid: false, publicKeyMaterial: null };
  }
  const lines = text.slice(0, -1).split('\n');
  if (lines.length !== 2) return { valid: false, publicKeyMaterial: null };

  const comment = /^untrusted comment: minisign public key: ([0-9A-F]{16})$/.exec(
    lines[0],
  );
  const keyBytes = decodeCanonicalBase64(lines[1]);
  if (!keyBytes || keyBytes.length !== 42) {
    return { valid: false, publicKeyMaterial: null };
  }
  const algorithmIsEd25519 = keyBytes[0] === 0x45 && keyBytes[1] === 0x64;
  const embeddedKeyId = Buffer.from(keyBytes.subarray(2, 10))
    .reverse()
    .toString('hex')
    .toUpperCase();
  return {
    valid: algorithmIsEd25519 && comment?.[1] === embeddedKeyId,
    publicKeyMaterial: keyBytes.subarray(10),
  };
}

const inspectedPublicKey = inspectMinisignPublicKey(publicKey);
const upstreamPublicKeyMaterial =
  inspectMinisignPublicKey(upstreamPublicKey).publicKeyMaterial;
const unprovisionedPublicKeyMaterial =
  inspectMinisignPublicKey(unprovisionedPublicKey).publicKeyMaterial;
const isUnprovisioned = inspectedPublicKey.publicKeyMaterial?.equals(
  unprovisionedPublicKeyMaterial,
);

expect(
  'Updater 公钥',
  inspectedPublicKey.valid,
  '应为规范 Base64 编码的 Ed25519 minisign 公钥，且密钥标识必须匹配',
);
expect(
  '上游 Updater 公钥',
  !inspectedPublicKey.publicKeyMaterial?.equals(upstreamPublicKeyMaterial),
  'Skill Expert 不得复用上游信任根',
);
expect(
  'Updater 地址',
  JSON.stringify(updater?.endpoints) === JSON.stringify([canonicalEndpoint]),
  `只允许 ${canonicalEndpoint}`,
);
expect(
  '生产 Updater 公钥',
  !requireProduction || !isUnprovisioned,
  '尚未配置的开发信任根不能用于发布',
);

if (failures.length > 0) {
  console.error('Updater 信任检查失败：');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

if (isUnprovisioned) {
  console.log('Skill Expert Updater 信任检查通过（尚未配置的开发状态）。');
} else {
  console.log('Skill Expert Updater 信任检查通过（生产信任根）。');
}
