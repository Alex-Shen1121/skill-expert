import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_SCRIPTS = [
  'prepare-release.mjs',
  'check-version-consistency.mjs',
  'product-version.mjs',
];
const CURRENT_VERSION = '1.2.3';

function write(root, relativePath, content) {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function writeJson(root, relativePath, value) {
  write(root, relativePath, `${JSON.stringify(value, null, 2)}\n`);
}

function git(root, ...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function fixture(t, { currentVersion = CURRENT_VERSION } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-prepare-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const changelogVersion = currentVersion.split('-')[0];

  writeJson(root, 'package.json', {
    name: 'skill-expert',
    version: currentVersion,
    private: true,
    scripts: { 'release:prepare': 'node scripts/prepare-release.mjs' },
  });
  writeJson(root, 'package-lock.json', {
    name: 'skill-expert',
    version: currentVersion,
    lockfileVersion: 3,
    packages: { '': { name: 'skill-expert', version: currentVersion } },
  });
  write(root, 'src-tauri/Cargo.toml', `[package]\nname = "skill-expert"\nversion = "${currentVersion}"\n`);
  write(root, 'src-tauri/Cargo.lock', `[[package]]\nname = "skill-expert"\nversion = "${currentVersion}"\n`);
  writeJson(root, 'src-tauri/tauri.conf.json', { productName: 'Agent 技能管家', version: currentVersion });
  for (const locale of ['en', 'zh', 'zh-TW']) {
    writeJson(root, `src/i18n/${locale}.json`, {
      settings: { version: `Agent 技能管家 ${currentVersion}` },
    });
  }
  write(
    root,
    'CHANGELOG.md',
    `# Changelog\n\n## [Unreleased]\n\n### Release Overview\n- Ship safer release preparation.\n\n### User-facing\n-\n\n### Developer & Governance\n-\n\n## [${changelogVersion}] - 2026-08-23\n\n### Release Overview\n- Previous release.\n`,
  );
  write(
    root,
    'CHANGELOG-zh.md',
    `# 更新日志\n\n## [Unreleased]\n\n### 发布概览\n- 交付更安全的版本准备流程。\n\n### 用户可见更新\n-\n\n### 开发者与治理更新\n-\n\n## [${changelogVersion}] - 2026-08-23\n\n### 发布概览\n- 上一个版本。\n`,
  );

  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  for (const script of SOURCE_SCRIPTS) {
    fs.copyFileSync(path.join(SCRIPT_DIR, script), path.join(root, 'scripts', script));
  }

  git(root, 'init', '-q');
  git(root, 'config', 'user.name', 'Release Test');
  git(root, 'config', 'user.email', 'release-test@example.com');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'fixture');
  return root;
}

function runPrepare(root, ...args) {
  return spawnSync('npm', ['run', 'release:prepare', '--', ...args], {
    cwd: root,
    encoding: 'utf8',
  });
}

function read(root, relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

test('patch promotes both Unreleased sections under the same UTC version heading', (t) => {
  const root = fixture(t);
  const date = new Date().toISOString().slice(0, 10);

  const result = runPrepare(root, 'patch');

  assert.equal(result.status, 0, result.stderr);
  assert.match(
    read(root, 'CHANGELOG.md'),
    new RegExp(
      `## \\[Unreleased\\]\\n\\n### Release Overview\\n-\\n\\n### User-facing\\n-\\n\\n### Developer & Governance\\n-\\n\\n## \\[1\\.2\\.4\\] - ${date}\\n\\n### Release Overview\\n- Ship safer release preparation\\.`,
    ),
  );
  assert.match(
    read(root, 'CHANGELOG-zh.md'),
    new RegExp(
      `## \\[Unreleased\\]\\n\\n### 发布概览\\n-\\n\\n### 用户可见更新\\n-\\n\\n### 开发者与治理更新\\n-\\n\\n## \\[1\\.2\\.4\\] - ${date}\\n\\n### 发布概览\\n- 交付更安全的版本准备流程。`,
    ),
  );
});

test('拒绝 development 版本类型且不修改仓库', (t) => {
  const root = fixture(t);

  const result = runPrepare(root, 'development');

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /版本参数只能是 patch 或明确的 x\.y\.z/);
  assert.equal(git(root, 'status', '--porcelain'), '');
});

test('拒绝从开发序号版本准备正式版本', (t) => {
  const root = fixture(t, { currentVersion: '1.2.3-9' });

  const result = runPrepare(root, 'patch');

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /版本必须是 x\.y\.z/);
  assert.equal(git(root, 'status', '--porcelain'), '');
});

test('明确版本可以跨越补丁号并同步全部版本契约', (t) => {
  const root = fixture(t);

  const result = runPrepare(root, '1.3.0');

  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(read(root, 'package.json')).version, '1.3.0');
  assert.equal(JSON.parse(read(root, 'src-tauri/tauri.conf.json')).version, '1.3.0');
  assert.match(read(root, 'CHANGELOG.md'), /^## \[1\.3\.0\]/m);
  assert.match(read(root, 'CHANGELOG-zh.md'), /^## \[1\.3\.0\]/m);
});

test('拒绝不高于当前版本的明确版本且不修改仓库', (t) => {
  const root = fixture(t);

  const result = runPrepare(root, '1.2.3');

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /目标版本 1\.2\.3 必须高于当前版本 1\.2\.3/);
  assert.equal(git(root, 'status', '--porcelain'), '');
});

test('rejects unknown flags and extra positional arguments without changing the repository', (t) => {
  for (const invalidArgs of [
    ['patch', '--unexpected'],
    ['patch', 'minor'],
  ]) {
    const root = fixture(t);

    const result = runPrepare(root, ...invalidArgs);

    assert.notEqual(result.status, 0, invalidArgs.join(' '));
    assert.match(
      result.stderr,
      /参数必须符合：patch\|x\.y\.z \[--dry-run\]/,
    );
    assert.equal(git(root, 'status', '--porcelain'), '');
  }
});

test('fails without partial writes when English Unreleased has no release note', (t) => {
  const root = fixture(t);
  write(
    root,
    'CHANGELOG.md',
    `# Changelog\n\n## [Unreleased]\n\n### Release Overview\n-\n\n### User-facing\n-\n\n### Developer & Governance\n-\n\n## [${CURRENT_VERSION}] - 2026-08-23\n\n### Release Overview\n- Previous release.\n`,
  );
  git(root, 'add', 'CHANGELOG.md');
  git(root, 'commit', '-qm', 'empty English release notes');

  const result = runPrepare(root, 'patch');

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /CHANGELOG\.md Unreleased must contain at least one non-empty bullet/);
  assert.equal(git(root, 'status', '--porcelain'), '');
});

test('fails without partial writes when the current version contract has drifted', (t) => {
  const root = fixture(t);
  writeJson(root, 'src/i18n/zh-TW.json', {
    settings: { version: 'Agent 技能管家 1.2.2' },
  });
  git(root, 'add', 'src/i18n/zh-TW.json');
  git(root, 'commit', '-qm', 'drift version fixture');

  const result = runPrepare(root, 'patch');

  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /src\/i18n\/zh-TW\.json settings\.version: expected 1\.2\.3, found 1\.2\.2/,
  );
  assert.equal(git(root, 'status', '--porcelain'), '');
});

test('fails without partial writes when the target tag already exists', (t) => {
  const root = fixture(t);
  git(root, 'tag', 'v1.2.4');

  const result = runPrepare(root, 'patch');

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /标签 v1\.2\.4 已存在/);
  assert.equal(git(root, 'status', '--porcelain'), '');
});

test('fails without partial writes when the target tag exists only on origin', (t) => {
  const root = fixture(t);
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'release-origin-'));
  t.after(() => fs.rmSync(remote, { recursive: true, force: true }));
  git(remote, 'init', '--bare', '-q');
  git(root, 'branch', '-M', 'main');
  git(root, 'remote', 'add', 'origin', remote);
  git(root, 'push', '-qu', 'origin', 'main');
  git(root, 'tag', 'v1.2.4');
  git(root, 'push', '-q', 'origin', 'v1.2.4');
  git(root, 'tag', '-d', 'v1.2.4');
  assert.equal(git(root, 'tag', '--list'), '');

  const result = runPrepare(root, 'patch', '--dry-run');

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /标签 v1\.2\.4 已存在/);
  assert.equal(git(root, 'status', '--porcelain'), '');
});

test('同一版本线存在更高标签时拒绝回退且不修改仓库', (t) => {
  const root = fixture(t);
  git(root, 'tag', 'v1.2.5');

  const result = runPrepare(root, 'patch');

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /目标版本 1\.2\.4 必须高于同一版本线已有标签 v1\.2\.5/);
  assert.equal(git(root, 'status', '--porcelain'), '');
});

test('忽略独立产品版本线之外的更高稳定标签', (t) => {
  const root = fixture(t);
  git(root, 'tag', 'v1.36.0');

  const result = runPrepare(root, 'patch', '--dry-run');

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\[dry-run\] 1\.2\.3 -> 1\.2\.4/);
  assert.equal(git(root, 'status', '--porcelain'), '');
});

test('拒绝 minor 与 major，正式版本只能递增补丁号', (t) => {
  for (const releaseType of ['minor', 'major']) {
    const root = fixture(t);
    const result = runPrepare(root, releaseType);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /版本参数只能是 patch 或明确的 x\.y\.z/);
    assert.equal(git(root, 'status', '--porcelain'), '');
  }
});

test('fails without partial writes when Chinese Unreleased has no release note', (t) => {
  const root = fixture(t);
  write(
    root,
    'CHANGELOG-zh.md',
    `# 更新日志\n\n## [Unreleased]\n\n### 发布概览\n-\n\n### 用户可见更新\n-\n\n### 开发者与治理更新\n-\n\n## [${CURRENT_VERSION}] - 2026-08-23\n\n### 发布概览\n- 上一个版本。\n`,
  );
  git(root, 'add', 'CHANGELOG-zh.md');
  git(root, 'commit', '-qm', 'empty Chinese release notes');

  const result = runPrepare(root, 'patch');

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /CHANGELOG-zh\.md Unreleased must contain at least one non-empty bullet/);
  assert.equal(git(root, 'status', '--porcelain'), '');
});

test('fails without partial writes when a changelog has no Unreleased target heading', (t) => {
  const root = fixture(t);
  write(
    root,
    'CHANGELOG.md',
    `# Changelog\n\n## [${CURRENT_VERSION}] - 2026-08-23\n\n### Release Overview\n- Previous release.\n`,
  );
  git(root, 'add', 'CHANGELOG.md');
  git(root, 'commit', '-qm', 'remove Unreleased target');

  const result = runPrepare(root, 'patch');

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Missing ## \[Unreleased\] heading in CHANGELOG\.md/);
  assert.equal(git(root, 'status', '--porcelain'), '');
});

test('fails without partial writes when the target version heading already exists', (t) => {
  const root = fixture(t);
  write(
    root,
    'CHANGELOG.md',
    `${read(root, 'CHANGELOG.md')}\n## [1.2.4] - 2026-08-20\n\n### Release Overview\n- Conflicting target.\n`,
  );
  git(root, 'add', 'CHANGELOG.md');
  git(root, 'commit', '-qm', 'add conflicting target heading');

  const result = runPrepare(root, 'patch');

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Target heading ## \[1\.2\.4\] already exists in CHANGELOG\.md/);
  assert.equal(git(root, 'status', '--porcelain'), '');
});
