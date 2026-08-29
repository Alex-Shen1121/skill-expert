import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageAssets = path.join(repositoryRoot, 'scripts/package-assets.mjs');
const version = '1.2.3';

const expectedInventory = {
  'macos-arm64': [
    'skill-expert-cli-v1.2.3-macos-arm64',
    'skill-expert-v1.2.3-macos-arm64.app.tar.gz',
    'skill-expert-v1.2.3-macos-arm64.app.tar.gz.sig',
    'skill-expert-v1.2.3-macos-arm64.dmg',
  ],
  'macos-x64': [
    'skill-expert-cli-v1.2.3-macos-x64',
    'skill-expert-v1.2.3-macos-x64.app.tar.gz',
    'skill-expert-v1.2.3-macos-x64.app.tar.gz.sig',
    'skill-expert-v1.2.3-macos-x64.dmg',
  ],
  'windows-x64': [
    'skill-expert-cli-v1.2.3-windows-x64.exe',
    'skill-expert-v1.2.3-windows-x64-setup.exe',
    'skill-expert-v1.2.3-windows-x64-setup.exe.sig',
    'skill-expert-v1.2.3-windows-x64.msi',
    'skill-expert-v1.2.3-windows-x64.msi.sig',
  ],
  'linux-x64': [
    'skill-expert-cli-v1.2.3-linux-x64',
    'skill-expert-v1.2.3-linux-x64.AppImage',
    'skill-expert-v1.2.3-linux-x64.AppImage.sig',
    'skill-expert-v1.2.3-linux-x64.deb',
    'skill-expert-v1.2.3-linux-x64.rpm',
  ],
};

const expectedDraftUploadInventory = {
  'macos-arm64': [
    'skill-expert-v1.2.3-macos-arm64.app.tar.gz',
    'skill-expert-v1.2.3-macos-arm64.app.tar.gz.sig',
    'skill-expert-v1.2.3-macos-arm64.dmg',
  ],
  'macos-x64': [
    'skill-expert-v1.2.3-macos-x64.app.tar.gz',
    'skill-expert-v1.2.3-macos-x64.app.tar.gz.sig',
    'skill-expert-v1.2.3-macos-x64.dmg',
  ],
  'windows-x64': [
    'skill-expert-v1.2.3-windows-x64-setup.exe',
    'skill-expert-v1.2.3-windows-x64-setup.exe.sig',
    'skill-expert-v1.2.3-windows-x64.msi',
  ],
  'linux-x64': [
    'skill-expert-v1.2.3-linux-x64.AppImage',
    'skill-expert-v1.2.3-linux-x64.AppImage.sig',
    'skill-expert-v1.2.3-linux-x64.deb',
    'skill-expert-v1.2.3-linux-x64.rpm',
  ],
};

function runPackageAssets(args) {
  return spawnSync(process.execPath, [packageAssets, ...args], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });
}

function createInventoryFixture(t, target) {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'skill-expert-package-assets-'));
  t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));
  const assetDirectory = path.join(fixtureRoot, target);
  mkdirSync(assetDirectory);
  for (const filename of expectedInventory[target]) {
    writeFileSync(path.join(assetDirectory, filename), `${filename}\n`);
  }
  return assetDirectory;
}

function writeBuildArtifact(buildRoot, relativePath) {
  const artifactPath = path.join(buildRoot, relativePath);
  mkdirSync(path.dirname(artifactPath), { recursive: true });
  writeFileSync(artifactPath, `${relativePath}\n`);
}

const buildArtifacts = {
  'macos-arm64': [
    'bundle/dmg/Agent 技能管家_1.2.3_aarch64.dmg',
    'bundle/macos/Agent 技能管家.app.tar.gz',
    'bundle/macos/Agent 技能管家.app.tar.gz.sig',
    'skill-expert-cli',
  ],
  'macos-x64': [
    'bundle/dmg/Agent 技能管家_1.2.3_x64.dmg',
    'bundle/macos/Agent 技能管家.app.tar.gz',
    'bundle/macos/Agent 技能管家.app.tar.gz.sig',
    'skill-expert-cli',
  ],
  'windows-x64': [
    'bundle/nsis/Agent 技能管家_1.2.3_x64-setup.exe',
    'bundle/nsis/Agent 技能管家_1.2.3_x64-setup.exe.sig',
    'bundle/msi/Agent 技能管家_1.2.3_x64_en-US.msi',
    'bundle/msi/Agent 技能管家_1.2.3_x64_en-US.msi.sig',
    'skill-expert-cli.exe',
  ],
  'linux-x64': [
    'bundle/appimage/Agent 技能管家_1.2.3_amd64.AppImage',
    'bundle/appimage/Agent 技能管家_1.2.3_amd64.AppImage.sig',
    'bundle/deb/Agent 技能管家_1.2.3_amd64.deb',
    'bundle/rpm/Agent 技能管家-1.2.3-1.x86_64.rpm',
    'skill-expert-cli',
  ],
};

test('输出四个平台的精确稳定打包清单', () => {
  for (const [target, expected] of Object.entries(expectedInventory)) {
    const result = runPackageAssets(['expected', '--version', version, '--target', target]);

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.stdout.trim().split('\n'), expected);
  }
});

test('输出不包含独立 CLI 的 Draft 上传清单', () => {
  for (const [target, expected] of Object.entries(expectedDraftUploadInventory)) {
    const result = runPackageAssets(['draft-upload', '--version', version, '--target', target]);

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.stdout.trim().split('\n'), expected);
  }
});

test('接受只包含精确预期集合的打包资产目录', (t) => {
  const assetDirectory = createInventoryFixture(t, 'macos-arm64');
  const result = runPackageAssets([
    'verify',
    '--version',
    version,
    '--target',
    'macos-arm64',
    '--directory',
    assetDirectory,
  ]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /打包资产精确清单验证通过/);
});

test('拒绝缺少预期文件的打包资产目录', (t) => {
  const assetDirectory = createInventoryFixture(t, 'windows-x64');
  rmSync(path.join(assetDirectory, expectedInventory['windows-x64'][0]));
  const result = runPackageAssets([
    'verify',
    '--version',
    version,
    '--target',
    'windows-x64',
    '--directory',
    assetDirectory,
  ]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /缺少：skill-expert-cli-v1\.2\.3-windows-x64\.exe/);
});

test('拒绝包含意外文件的打包资产目录', (t) => {
  const assetDirectory = createInventoryFixture(t, 'linux-x64');
  writeFileSync(path.join(assetDirectory, 'debug-symbols.zip'), 'unexpected\n');
  const result = runPackageAssets([
    'verify',
    '--version',
    version,
    '--target',
    'linux-x64',
    '--directory',
    assetDirectory,
  ]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /意外：debug-symbols\.zip/);
});

test('把每个 Tauri 目标暂存为精确稳定打包清单', (t) => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'skill-expert-package-stage-'));
  t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));

  for (const [target, sourceArtifacts] of Object.entries(buildArtifacts)) {
    const buildRoot = path.join(fixtureRoot, 'build', target);
    const assetDirectory = path.join(fixtureRoot, 'package-assets', target);
    for (const relativePath of sourceArtifacts) writeBuildArtifact(buildRoot, relativePath);

    const result = runPackageAssets([
      'stage',
      '--version',
      version,
      '--target',
      target,
      '--build-root',
      buildRoot,
      '--directory',
      assetDirectory,
    ]);

    assert.equal(result.status, 0, `${target}: ${result.stderr}`);
    assert.deepEqual(readdirSync(assetDirectory).sort(), expectedInventory[target]);
    for (const filename of expectedInventory[target]) {
      assert.match(readFileSync(path.join(assetDirectory, filename), 'utf8'), /bundle\/|skill-expert-cli/);
    }
  }
});

test('所有打包入口都拒绝开发序号版本', () => {
  const result = runPackageAssets([
    'expected',
    '--version',
    '1.0.3-2',
    '--target',
    'macos-arm64',
  ]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /版本必须是 x\.y\.z/);
});
