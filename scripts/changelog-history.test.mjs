import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function releaseHeadings(content) {
  return [...content.matchAll(/^## \[([^\]]+)\](?:\s+-\s+\d{4}-\d{2}-\d{2})?\s*$/gm)].map(
    (match) => match[1],
  );
}

function assertIndependentReleaseLine(content) {
  const headings = releaseHeadings(content);
  assert.equal(headings[0], 'Unreleased');
  assert.equal(headings.at(-1), '1.0.0');
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

test('English changelog starts the Skill Expert line at 1.0.0 and preserves complete upstream history', () => {
  const changelog = read('CHANGELOG.md');
  const archive = read('docs/upstream-history/CHANGELOG.md');
  const upstreamHistory = archive.slice(archive.indexOf('## [1.34.2]'));

  assertIndependentReleaseLine(changelog);
  assert.match(
    changelog,
    /Upstream Skills Manager history is preserved in \[the upstream history archive\]\(docs\/upstream-history\/CHANGELOG\.md\)\./,
  );
  assert.match(archive, /archived history of the upstream `xingkongliang\/skills-manager` project/i);
  assert.equal(
    sha256(upstreamHistory),
    'fc5a77ba86d54743713356a970fbac1de98fe8352f30d3d3bba3a98bc9f18f47',
  );
});

test('Chinese changelog starts the Skill Expert line at 1.0.0 and preserves complete upstream history', () => {
  const changelog = read('CHANGELOG-zh.md');
  const archive = read('docs/upstream-history/CHANGELOG-zh.md');
  const upstreamHistory = archive.slice(archive.indexOf('## [1.34.2]'));

  assertIndependentReleaseLine(changelog);
  assert.match(
    changelog,
    /上游 Skills Manager 的历史记录保存在\[上游历史归档\]\(docs\/upstream-history\/CHANGELOG-zh\.md\)中。/,
  );
  assert.match(archive, /上游 `xingkongliang\/skills-manager` 项目的历史归档/);
  assert.equal(
    sha256(upstreamHistory),
    'f6648946a4e2e8ba239e188c1ecb37c3594c1d27cf1a68c9e92b5af4b0da8a7f',
  );
});

test('upstream history archives are visible to version control', () => {
  const result = spawnSync(
    'git',
    ['check-ignore', 'docs/upstream-history/CHANGELOG.md', 'docs/upstream-history/CHANGELOG-zh.md'],
    { cwd: ROOT, encoding: 'utf8' },
  );

  assert.equal(result.status, 1, result.stdout || result.stderr);
});

test('verbatim upstream archives opt out of whitespace normalization', () => {
  const result = spawnSync(
    'git',
    [
      'check-attr',
      'whitespace',
      '--',
      'docs/upstream-history/CHANGELOG.md',
      'docs/upstream-history/CHANGELOG-zh.md',
    ],
    { cwd: ROOT, encoding: 'utf8' },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /docs\/upstream-history\/CHANGELOG\.md: whitespace: unset/);
  assert.match(result.stdout, /docs\/upstream-history\/CHANGELOG-zh\.md: whitespace: unset/);
});
