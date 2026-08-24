import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const VERSION = '1.2.3';
const CHECK_SCRIPT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'check-version-consistency.mjs',
);

function write(root, relativePath, content) {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function writeJson(root, relativePath, value) {
  write(root, relativePath, `${JSON.stringify(value, null, 2)}\n`);
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'version-contract-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  writeJson(root, 'package.json', { name: 'fixture-app', version: VERSION });
  writeJson(root, 'package-lock.json', {
    name: 'fixture-app',
    version: VERSION,
    packages: { '': { name: 'fixture-app', version: VERSION } },
  });
  write(root, 'src-tauri/Cargo.toml', `[package]\nname = "fixture-app"\nversion = "${VERSION}"\n\n[dependencies]\n`);
  write(root, 'src-tauri/Cargo.lock', `[[package]]\nname = "fixture-app"\nversion = "${VERSION}"\n`);
  writeJson(root, 'src-tauri/tauri.conf.json', { version: VERSION });
  for (const locale of ['en', 'zh', 'zh-TW']) {
    writeJson(root, `src/i18n/${locale}.json`, { settings: { version: `Fixture App ${VERSION}` } });
  }
  write(root, 'CHANGELOG.md', `# Changelog\n\n## [${VERSION}] - 2026-08-24\n`);
  write(root, 'CHANGELOG-zh.md', `# 更新日志\n\n## [${VERSION}] - 2026-08-24\n`);
  return root;
}

function runVersionCheck(root) {
  return spawnSync(process.execPath, [CHECK_SCRIPT], { cwd: root, encoding: 'utf8' });
}

test('accepts a complete, consistent version contract', (t) => {
  const result = runVersionCheck(fixture(t));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Version consistency check passed for 1\.2\.3\./);
});

test('reports both npm lockfile version fields when they drift', (t) => {
  const root = fixture(t);
  writeJson(root, 'package-lock.json', {
    name: 'fixture-app',
    version: '1.2.2',
    packages: { '': { name: 'fixture-app', version: '1.2.1' } },
  });

  const result = runVersionCheck(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /package-lock\.json root version: expected 1\.2\.3, found 1\.2\.2/);
  assert.match(
    result.stderr,
    /package-lock\.json workspace version: expected 1\.2\.3, found 1\.2\.1/,
  );
});

const driftCases = [
  {
    name: 'Cargo.toml',
    mutate(root) {
      write(root, 'src-tauri/Cargo.toml', '[package]\nname = "fixture-app"\nversion = "1.2.2"\n');
    },
    expected: 'src-tauri/Cargo.toml package version: expected 1.2.3, found 1.2.2',
  },
  {
    name: 'Cargo.lock',
    mutate(root) {
      write(root, 'src-tauri/Cargo.lock', '[[package]]\nname = "fixture-app"\nversion = "1.2.2"\n');
    },
    expected: 'src-tauri/Cargo.lock package fixture-app: expected 1.2.3, found 1.2.2',
  },
  {
    name: 'Tauri config',
    mutate(root) {
      writeJson(root, 'src-tauri/tauri.conf.json', { version: '1.2.2' });
    },
    expected: 'src-tauri/tauri.conf.json version: expected 1.2.3, found 1.2.2',
  },
  {
    name: 'localized UI',
    mutate(root) {
      writeJson(root, 'src/i18n/zh-TW.json', { settings: { version: 'Fixture App 1.2.2' } });
    },
    expected: 'src/i18n/zh-TW.json settings.version: expected 1.2.3, found 1.2.2',
  },
  {
    name: 'English changelog',
    mutate(root) {
      write(root, 'CHANGELOG.md', '# Changelog\n\n## [1.2.2] - 2026-08-23\n');
    },
    expected: 'CHANGELOG.md latest release: expected 1.2.3, found 1.2.2',
  },
  {
    name: 'Chinese changelog',
    mutate(root) {
      write(root, 'CHANGELOG-zh.md', '# 更新日志\n\n## [1.2.2] - 2026-08-23\n');
    },
    expected: 'CHANGELOG-zh.md latest release: expected 1.2.3, found 1.2.2',
  },
];

for (const driftCase of driftCases) {
  test(`reports ${driftCase.name} drift`, (t) => {
    const root = fixture(t);
    driftCase.mutate(root);
    const result = runVersionCheck(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, new RegExp(driftCase.expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });
}
