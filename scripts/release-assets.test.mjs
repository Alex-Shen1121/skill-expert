import assert from 'node:assert/strict';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createReleaseChecksums,
  createUpdaterMetadata,
  expectedDraftOnlyAssets,
  expectedReleaseAssets,
  verifyReleaseInventory,
} from './release-assets.mjs';

const version = '1.2.3';

const draftOnlySignatureInputs = [
  'skill-expert-v1.2.3-linux-x64.AppImage.sig',
  'skill-expert-v1.2.3-macos-arm64.app.tar.gz.sig',
  'skill-expert-v1.2.3-macos-x64.app.tar.gz.sig',
  'skill-expert-v1.2.3-windows-x64-setup.exe.sig',
];

function fixture(t) {
  const directory = mkdtempSync(path.join(tmpdir(), 'skill-expert-release-assets-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const filename of expectedReleaseAssets(version, { includeGenerated: false })) {
    writeFileSync(path.join(directory, filename), `产物-${filename}\n`);
  }
  for (const filename of draftOnlySignatureInputs) {
    writeFileSync(path.join(directory, filename), `签名-${filename}\n`);
  }
  return directory;
}

test('正式发布只公开十二个应用分发与可信验证资产', () => {
  const inventory = expectedReleaseAssets(version);

  assert.deepEqual(inventory, [
    'SHA256SUMS',
    'build-provenance.json',
    'latest.json',
    'skill-expert-v1.2.3-linux-x64.AppImage',
    'skill-expert-v1.2.3-linux-x64.deb',
    'skill-expert-v1.2.3-linux-x64.rpm',
    'skill-expert-v1.2.3-macos-arm64.app.tar.gz',
    'skill-expert-v1.2.3-macos-arm64.dmg',
    'skill-expert-v1.2.3-macos-x64.app.tar.gz',
    'skill-expert-v1.2.3-macos-x64.dmg',
    'skill-expert-v1.2.3-windows-x64-setup.exe',
    'skill-expert-v1.2.3-windows-x64.msi',
  ]);
  assert.ok(!inventory.some((name) => name.includes('-cli-')));
  assert.ok(!inventory.some((name) => name.endsWith('.sig')));
});

test('Draft 只暂存四个实际进入更新元数据的临时签名资产', () => {
  assert.deepEqual(expectedDraftOnlyAssets(version), [
    'skill-expert-v1.2.3-linux-x64.AppImage.sig',
    'skill-expert-v1.2.3-macos-arm64.app.tar.gz.sig',
    'skill-expert-v1.2.3-macos-x64.app.tar.gz.sig',
    'skill-expert-v1.2.3-windows-x64-setup.exe.sig',
  ]);
});

test('从真实签名文件生成四平台 latest.json 和可复算的 SHA256SUMS', (t) => {
  const directory = fixture(t);
  createUpdaterMetadata(directory, version, '2026-08-25T00:00:00Z');
  createReleaseChecksums(directory, version);

  const metadata = JSON.parse(readFileSync(path.join(directory, 'latest.json'), 'utf8'));
  assert.equal(metadata.version, version);
  assert.equal(metadata.pub_date, '2026-08-25T00:00:00Z');
  assert.deepEqual(Object.keys(metadata.platforms).sort(), [
    'darwin-aarch64',
    'darwin-x86_64',
    'linux-x86_64',
    'windows-x86_64',
  ]);
  assert.equal(
    metadata.platforms['darwin-aarch64'].url,
    'https://github.com/Alex-Shen1121/skill-expert/releases/download/v1.2.3/skill-expert-v1.2.3-macos-arm64.app.tar.gz',
  );
  assert.match(metadata.platforms['windows-x86_64'].signature, /^签名-/);

  const checksums = readFileSync(path.join(directory, 'SHA256SUMS'), 'utf8');
  assert.match(checksums, /  latest\.json$/m);
  assert.match(checksums, /  skill-expert-v1\.2\.3-linux-x64\.rpm$/m);
  assert.doesNotMatch(checksums, /SHA256SUMS|build-provenance|-cli-|\.sig$/m);
});

test('下载回验要求精确清单并拒绝缺失或额外资产', (t) => {
  const directory = fixture(t);
  createUpdaterMetadata(directory, version, '2026-08-25T00:00:00Z');
  createReleaseChecksums(directory, version);
  for (const filename of draftOnlySignatureInputs) unlinkSync(path.join(directory, filename));
  writeFileSync(path.join(directory, 'build-provenance.json'), '{}\n');

  assert.doesNotThrow(() => verifyReleaseInventory(directory, version));

  unlinkSync(path.join(directory, 'skill-expert-v1.2.3-macos-x64.dmg'));
  writeFileSync(path.join(directory, '调试符号.zip'), '额外文件\n');
  assert.throws(
    () => verifyReleaseInventory(directory, version),
    /缺少：skill-expert-v1\.2\.3-macos-x64\.dmg.*意外：调试符号\.zip/,
  );
});
