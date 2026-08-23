import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const checker = path.join(repositoryRoot, 'scripts/check-repository-identity.mjs');
const fixtureFiles = [
  '.codex/environments/environment.toml',
  '.github/ISSUE_TEMPLATE/bug_report.md',
  '.github/ISSUE_TEMPLATE/config.yml',
  '.github/workflows/release.yml',
  'CONTRIBUTING.md',
  'README.md',
  'README.zh-CN.md',
  'docs/agents/issue-tracker.md',
  'package.json',
  'src-tauri/Cargo.toml',
  'src-tauri/src/commands/settings.rs',
  'src-tauri/tauri.conf.json',
  'src/views/Settings.tsx',
];

function createFixture(t) {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'skill-expert-repository-identity-'));
  t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));

  for (const relativePath of fixtureFiles) {
    const destination = path.join(fixtureRoot, relativePath);
    mkdirSync(path.dirname(destination), { recursive: true });
    copyFileSync(path.join(repositoryRoot, relativePath), destination);
  }

  return fixtureRoot;
}

function runChecker(fixtureRoot) {
  return spawnSync(process.execPath, [checker], {
    cwd: fixtureRoot,
    encoding: 'utf8',
  });
}

function replaceInFixture(fixtureRoot, relativePath, search, replacement) {
  const target = path.join(fixtureRoot, relativePath);
  const contents = readFileSync(target, 'utf8');
  assert.ok(contents.includes(search), `fixture must contain ${search}`);
  writeFileSync(target, contents.replace(search, replacement));
}

test('accepts the canonical repository identity fixture', (t) => {
  const fixtureRoot = createFixture(t);
  const result = runChecker(fixtureRoot);

  assert.equal(result.status, 0, result.stderr);
});

test('rejects a diagnostic issue destination outside the canonical repository', (t) => {
  const fixtureRoot = createFixture(t);
  replaceInFixture(
    fixtureRoot,
    'src/views/Settings.tsx',
    'const GITHUB_URL = "https://github.com/Alex-Shen1121/skill-expert";',
    'const GITHUB_URL = "https://github.com/SomeoneElse/not-skill-expert";',
  );

  const result = runChecker(fixtureRoot);
  assert.notEqual(result.status, 0, 'wrong diagnostic repository must fail the contract');
  assert.match(result.stderr, /diagnostics issue destination/);
});

test('rejects legacy product spelling case-insensitively', (t) => {
  const fixtureRoot = createFixture(t);
  replaceInFixture(
    fixtureRoot,
    '.github/ISSUE_TEMPLATE/bug_report.md',
    'Report a problem with Skill Expert',
    'Report a problem with Skills manager',
  );

  const result = runChecker(fixtureRoot);
  assert.notEqual(result.status, 0, 'legacy product spelling must fail regardless of case');
  assert.match(result.stderr, /legacy product name/);
});

const unapprovedImageReferences = [
  ['HTML', '<img src="assets/demo/legacy-brand.png" />'],
  ['Markdown inline', '![Legacy brand](assets/demo/legacy-brand.png)'],
  [
    'Markdown reference',
    '![Legacy brand][legacy-brand]\n\n[legacy-brand]: assets/demo/legacy-brand.png',
  ],
  ['remote Markdown', '![Legacy brand](https://example.com/legacy-brand.png)'],
];

for (const [syntax, imageReference] of unapprovedImageReferences) {
  test(`rejects unapproved README image assets in ${syntax} syntax`, (t) => {
    const fixtureRoot = createFixture(t);
    replaceInFixture(
      fixtureRoot,
      'README.md',
      '<img src="assets/icon.png" width="80" />',
      `<img src="assets/icon.png" width="80" />\n${imageReference}`,
    );

    const result = runChecker(fixtureRoot);
    assert.notEqual(result.status, 0, 'unapproved README image assets must fail the contract');
    assert.match(result.stderr, /published image assets/);
  });
}

test('rejects an old backend release API beside the canonical URL', (t) => {
  const fixtureRoot = createFixture(t);
  const settingsCommand = path.join(fixtureRoot, 'src-tauri/src/commands/settings.rs');
  const contents = readFileSync(settingsCommand, 'utf8');
  writeFileSync(
    settingsCommand,
    `${contents}\n// https://api.github.com/repos/Alex-Shen1121/skills-manager/releases/latest\n`,
  );

  const result = runChecker(fixtureRoot);
  assert.notEqual(result.status, 0, 'old backend release APIs must fail the contract');
  assert.match(result.stderr, /legacy fork repository/);
});
