import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const candidateAssets = path.join(repositoryRoot, 'scripts/candidate-assets.mjs');
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

function runCandidateAssets(args) {
  return spawnSync(process.execPath, [candidateAssets, ...args], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });
}

function createInventoryFixture(t, target) {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'skill-expert-candidate-assets-'));
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
    'bundle/dmg/Skill Expert_1.2.3_aarch64.dmg',
    'bundle/macos/Skill Expert.app.tar.gz',
    'bundle/macos/Skill Expert.app.tar.gz.sig',
    'skill-expert-cli',
  ],
  'macos-x64': [
    'bundle/dmg/Skill Expert_1.2.3_x64.dmg',
    'bundle/macos/Skill Expert.app.tar.gz',
    'bundle/macos/Skill Expert.app.tar.gz.sig',
    'skill-expert-cli',
  ],
  'windows-x64': [
    'bundle/nsis/Skill Expert_1.2.3_x64-setup.exe',
    'bundle/nsis/Skill Expert_1.2.3_x64-setup.exe.sig',
    'bundle/msi/Skill Expert_1.2.3_x64_en-US.msi',
    'bundle/msi/Skill Expert_1.2.3_x64_en-US.msi.sig',
    'skill-expert-cli.exe',
  ],
  'linux-x64': [
    'bundle/appimage/Skill Expert_1.2.3_amd64.AppImage',
    'bundle/appimage/Skill Expert_1.2.3_amd64.AppImage.sig',
    'bundle/deb/Skill Expert_1.2.3_amd64.deb',
    'bundle/rpm/Skill Expert-1.2.3-1.x86_64.rpm',
    'skill-expert-cli',
  ],
};

test('prints the exact stable candidate inventory for all four targets', () => {
  for (const [target, expected] of Object.entries(expectedInventory)) {
    const result = runCandidateAssets(['expected', '--version', version, '--target', target]);

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.stdout.trim().split('\n'), expected);
  }
});

test('accepts a candidate asset directory containing the exact expected set', (t) => {
  const assetDirectory = createInventoryFixture(t, 'macos-arm64');
  const result = runCandidateAssets([
    'verify',
    '--version',
    version,
    '--target',
    'macos-arm64',
    '--directory',
    assetDirectory,
  ]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /exact candidate asset inventory verified/);
});

test('rejects a candidate asset directory with a missing expected file', (t) => {
  const assetDirectory = createInventoryFixture(t, 'windows-x64');
  rmSync(path.join(assetDirectory, expectedInventory['windows-x64'][0]));
  const result = runCandidateAssets([
    'verify',
    '--version',
    version,
    '--target',
    'windows-x64',
    '--directory',
    assetDirectory,
  ]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /missing: skill-expert-cli-v1\.2\.3-windows-x64\.exe/);
});

test('rejects a candidate asset directory with an unexpected extra file', (t) => {
  const assetDirectory = createInventoryFixture(t, 'linux-x64');
  writeFileSync(path.join(assetDirectory, 'debug-symbols.zip'), 'unexpected\n');
  const result = runCandidateAssets([
    'verify',
    '--version',
    version,
    '--target',
    'linux-x64',
    '--directory',
    assetDirectory,
  ]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unexpected: debug-symbols\.zip/);
});

test('stages each Tauri target as the exact stable candidate inventory', (t) => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'skill-expert-candidate-stage-'));
  t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));

  for (const [target, sourceArtifacts] of Object.entries(buildArtifacts)) {
    const buildRoot = path.join(fixtureRoot, 'build', target);
    const assetDirectory = path.join(fixtureRoot, 'candidate-assets', target);
    for (const relativePath of sourceArtifacts) writeBuildArtifact(buildRoot, relativePath);

    const result = runCandidateAssets([
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
