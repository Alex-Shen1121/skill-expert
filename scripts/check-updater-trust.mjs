#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const configPath = path.join(root, 'src-tauri/tauri.conf.json');
const canonicalEndpoint =
  'https://github.com/Alex-Shen1121/skill-expert/releases/latest/download/latest.json';
const upstreamPublicKey =
  'dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IERBRUYwMTBDOEQ3MDdEODAKUldTQWZYQ05EQUh2Mm0wNDZtNm5VYWJpbjRaZVJQRUhrQ2tkOXc3MHBWZ2VaREo0OVd3WEU3d0oK';
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

expect(
  'updater public key',
  inspectedPublicKey.valid,
  'expected a canonical base64-encoded Ed25519 minisign public key with a matching key ID',
);
expect(
  'upstream updater public key',
  !inspectedPublicKey.publicKeyMaterial?.equals(upstreamPublicKeyMaterial),
  'the upstream trust root must not be reused by Skill Expert',
);
expect(
  'updater endpoint',
  JSON.stringify(updater?.endpoints) === JSON.stringify([canonicalEndpoint]),
  `expected only ${canonicalEndpoint}`,
);

if (failures.length > 0) {
  console.error('Updater trust check failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('Updater trust check passed for Skill Expert.');
