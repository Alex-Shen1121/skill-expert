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
  classifyDraftInventory,
  createReleaseChecksums,
  createUpdaterMetadata,
  expectedReleaseAssets,
  verifyReleaseInventory,
} from './release-assets.mjs';

const version = '1.2.3';

function fixture(t) {
  const directory = mkdtempSync(path.join(tmpdir(), 'skill-expert-release-assets-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const filename of expectedReleaseAssets(version, { includeGenerated: false })) {
    const content = filename.endsWith('.sig') ? `签名-${filename}\n` : `产物-${filename}\n`;
    writeFileSync(path.join(directory, filename), content);
  }
  return directory;
}

test('正式发布清单精确区分候选构建、晋级绑定与正式生成来源证明', () => {
  const inventory = expectedReleaseAssets(version);

  assert.equal(inventory.length, 24);
  assert.ok(inventory.includes('skill-expert-v1.2.3-macos-arm64.dmg'));
  assert.ok(inventory.includes('skill-expert-v1.2.3-windows-x64-setup.exe.sig'));
  assert.ok(inventory.includes('skill-expert-v1.2.3-linux-x64.AppImage.sig'));
  assert.ok(inventory.includes('skill-expert-cli-v1.2.3-macos-x64'));
  assert.ok(inventory.includes('latest.json'));
  assert.ok(inventory.includes('SHA256SUMS'));
  assert.ok(inventory.includes('candidate-manifest.json'));
  assert.ok(inventory.includes('candidate-build-provenance.json'));
  assert.ok(inventory.includes('promotion-binding.json'));
  assert.ok(inventory.includes('release-provenance.json'));
  assert.ok(!inventory.includes('build-provenance.json'));
});

test('从真实签名文件生成四平台 latest.json 和可复算的 SHA256SUMS', (t) => {
  const directory = fixture(t);
  writeFileSync(path.join(directory, 'candidate-manifest.json'), '{}\n');
  writeFileSync(path.join(directory, 'candidate-build-provenance.json'), '{}\n');
  writeFileSync(path.join(directory, 'promotion-binding.json'), '{}\n');
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
  assert.match(checksums, /  candidate-manifest\.json$/m);
  assert.match(checksums, /  candidate-build-provenance\.json$/m);
  assert.match(checksums, /  promotion-binding\.json$/m);
  assert.doesNotMatch(checksums, /SHA256SUMS|release-provenance/);
});

test('下载回验要求精确清单并拒绝缺失或额外资产', (t) => {
  const directory = fixture(t);
  writeFileSync(path.join(directory, 'candidate-manifest.json'), '{}\n');
  writeFileSync(path.join(directory, 'candidate-build-provenance.json'), '{}\n');
  writeFileSync(path.join(directory, 'promotion-binding.json'), '{}\n');
  createUpdaterMetadata(directory, version, '2026-08-25T00:00:00Z');
  createReleaseChecksums(directory, version);
  writeFileSync(path.join(directory, 'release-provenance.json'), '{}\n');

  assert.doesNotThrow(() => verifyReleaseInventory(directory, version));

  unlinkSync(path.join(directory, 'skill-expert-v1.2.3-macos-x64.dmg'));
  writeFileSync(path.join(directory, '调试符号.zip'), '额外文件\n');
  assert.throws(
    () => verifyReleaseInventory(directory, version),
    /缺少：skill-expert-v1\.2\.3-macos-x64\.dmg.*意外：调试符号\.zip/,
  );
});

test('同一次 workflow 重跑只复用空 Draft 或精确完整的既有资产', () => {
  const expected = expectedReleaseAssets(version);

  assert.deepEqual(classifyDraftInventory([], version), {
    state: 'empty',
    count: 0,
  });
  assert.deepEqual(classifyDraftInventory([...expected].reverse(), version), {
    state: 'complete',
    count: expected.length,
  });
  assert.throws(
    () => classifyDraftInventory(expected.slice(0, -1), version),
    /既有 Draft 是不完整资产集.*缺少/,
  );
  assert.throws(
    () => classifyDraftInventory([...expected, '额外文件.zip'], version),
    /既有 Draft 是不完整资产集.*意外/,
  );
});
