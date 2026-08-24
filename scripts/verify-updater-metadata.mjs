#!/usr/bin/env node
import fs from 'node:fs';

const platformAssets = {
  'darwin-aarch64': 'skill-expert-vVERSION-macos-arm64.app.tar.gz',
  'darwin-x86_64': 'skill-expert-vVERSION-macos-x64.app.tar.gz',
  'linux-x86_64': 'skill-expert-vVERSION-linux-x64.AppImage',
  'windows-x86_64': 'skill-expert-vVERSION-windows-x64-setup.exe',
};

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith('--') || value === undefined) {
      throw new Error(`expected --name value arguments, found ${flag ?? 'nothing'}`);
    }
    options[flag.slice(2)] = value;
  }
  return options;
}

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

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isTauriSignature(value, assetName) {
  const envelope = decodeCanonicalBase64(value);
  if (!envelope) return false;
  const text = envelope.toString('utf8');
  if (!text.endsWith('\n')) return false;
  const lines = text.slice(0, -1).split('\n');
  const trustedComment = new RegExp(
    `^trusted comment: timestamp:\\d+\\tfile:${escapeRegExp(assetName)}$`,
  );
  if (
    lines.length !== 4 ||
    lines[0] !== 'untrusted comment: signature from tauri secret key' ||
    !trustedComment.test(lines[2])
  ) {
    return false;
  }
  const signature = decodeCanonicalBase64(lines[1]);
  return (
    signature?.length === 74 &&
    signature[0] === 0x45 &&
    signature[1] === 0x44 &&
    decodeCanonicalBase64(lines[3])?.length === 64
  );
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  if (!options.file || !options.version) {
    throw new Error('usage: verify-updater-metadata.mjs --file latest.json --version x.y.z');
  }
  if (!/^\d+\.\d+\.\d+$/.test(options.version)) {
    throw new Error(`version must be a stable x.y.z value, found ${options.version}`);
  }

  const metadata = JSON.parse(fs.readFileSync(options.file, 'utf8'));
  if (metadata.version !== options.version) {
    throw new Error(
      `latest.json version mismatch: expected ${options.version}, found ${metadata.version ?? 'missing'}`,
    );
  }

  const expectedPlatforms = Object.keys(platformAssets).sort();
  const actualPlatforms = Object.keys(metadata.platforms ?? {}).sort();
  if (JSON.stringify(actualPlatforms) !== JSON.stringify(expectedPlatforms)) {
    throw new Error(
      `latest.json platform mismatch: expected ${expectedPlatforms.join(', ')}, found ${actualPlatforms.join(', ') || 'none'}`,
    );
  }

  const downloadRoot =
    `https://github.com/Alex-Shen1121/skill-expert/releases/download/v${options.version}`;
  for (const [platform, assetPattern] of Object.entries(platformAssets)) {
    const entry = metadata.platforms[platform];
    const assetName = assetPattern.replace('VERSION', options.version);
    if (typeof entry.signature !== 'string' || entry.signature.trim() === '') {
      throw new Error(`latest.json is missing a signature for ${platform}`);
    }
    if (!isTauriSignature(entry.signature, assetName)) {
      throw new Error(`latest.json has a malformed Tauri signature for ${platform}`);
    }
    const expectedUrl = `${downloadRoot}/${assetName}`;
    if (entry.url !== expectedUrl) {
      throw new Error(`latest.json URL mismatch for ${platform}: expected ${expectedUrl}`);
    }
  }

  console.log(
    `Updater metadata verified for ${options.version} (${expectedPlatforms.length} platforms).`,
  );
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
