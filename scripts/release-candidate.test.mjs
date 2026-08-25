import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const candidateCli = path.join(repositoryRoot, 'scripts/release-candidate.mjs');

function git(repository, ...args) {
  const result = spawnSync('git', args, { cwd: repository, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function writeJson(repository, relativePath, value) {
  const filePath = path.join(repository, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeVersionContract(
  repository,
  version,
  {
    packageName = 'skill-expert',
    englishNotes = '- English release note.',
    chineseNotes = '- 中文发布说明。',
  } = {},
) {
  writeJson(repository, 'package.json', { name: packageName, version });
  writeJson(repository, 'package-lock.json', {
    name: packageName,
    version,
    lockfileVersion: 3,
    packages: { '': { name: packageName, version } },
  });
  writeJson(repository, 'src-tauri/tauri.conf.json', { version });
  writeFileSync(
    path.join(repository, 'src-tauri/Cargo.toml'),
    `[package]\nname = "${packageName}"\nversion = "${version}"\n`,
  );
  writeFileSync(
    path.join(repository, 'src-tauri/Cargo.lock'),
    `[[package]]\nname = "${packageName}"\nversion = "${version}"\n`,
  );
  for (const locale of ['en', 'zh', 'zh-TW']) {
    writeJson(repository, `src/i18n/${locale}.json`, {
      settings: { version: `Version ${version}` },
    });
  }
  writeFileSync(
    path.join(repository, 'CHANGELOG.md'),
    `# Changelog\n\n## [Unreleased]\n\n## [${version}] - 2026-08-25\n\n${englishNotes}\n`,
  );
  writeFileSync(
    path.join(repository, 'CHANGELOG-zh.md'),
    `# 更新日志\n\n## [Unreleased]\n\n## [${version}] - 2026-08-25\n\n${chineseNotes}\n`,
  );
}

function createCandidateRepository(
  t,
  {
    baseVersion = '1.0.0',
    candidateVersion = '1.1.0',
    basePackageName = 'skill-expert',
  } = {},
) {
  const repository = mkdtempSync(path.join(tmpdir(), 'skill-expert-release-candidate-'));
  t.after(() => rmSync(repository, { recursive: true, force: true }));

  git(repository, 'init', '-b', 'release');
  git(repository, 'config', 'user.name', 'Release Candidate Test');
  git(repository, 'config', 'user.email', 'release-candidate@example.com');
  mkdirSync(path.join(repository, 'src-tauri'), { recursive: true });
  writeVersionContract(repository, baseVersion, { packageName: basePackageName });
  git(repository, 'add', '.');
  git(repository, 'commit', '-m', `release v${baseVersion}`);
  const baseSha = git(repository, 'rev-parse', 'HEAD');

  git(repository, 'switch', '-c', 'main');
  writeVersionContract(repository, candidateVersion);
  git(repository, 'add', '.');
  git(repository, 'commit', '--allow-empty', '-m', `prepare v${candidateVersion}`);
  const candidateSha = git(repository, 'rev-parse', 'HEAD');

  return { repository, baseSha, candidateSha };
}

function runCandidate(repository, args) {
  return spawnSync(process.execPath, [candidateCli, ...args], {
    cwd: repository,
    encoding: 'utf8',
  });
}

function runCandidateGuard(
  repository,
  candidateSha,
  { head = 'main', base = 'release', json = false } = {},
) {
  return runCandidate(repository, [
    'verify',
    '--candidate-sha',
    candidateSha,
    '--head',
    head,
    '--base',
    base,
    ...(json ? ['--json'] : []),
  ]);
}

function publishFixtureToOrigin(t, repository, { tag } = {}) {
  const origin = mkdtempSync(path.join(tmpdir(), 'skill-expert-release-origin-'));
  t.after(() => rmSync(origin, { recursive: true, force: true }));
  git(origin, 'init', '--bare');
  git(repository, 'remote', 'add', 'origin', origin);
  git(repository, 'push', 'origin', 'release', 'main');
  if (tag) {
    git(repository, 'tag', tag);
    git(repository, 'push', 'origin', `refs/tags/${tag}`);
    git(repository, 'tag', '--delete', tag);
  }
  return origin;
}

test('verifies an exact current main candidate through the public guard CLI', (t) => {
  const { repository, baseSha, candidateSha } = createCandidateRepository(t);
  const result = runCandidateGuard(repository, candidateSha, { json: true });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    version: '1.1.0',
    tag: 'v1.1.0',
    candidateSha,
    baseSha,
    commitRange: `${baseSha}..${candidateSha}`,
    tagAbsence: 'refs/tags/v1.1.0 is absent locally (no origin configured)',
  });
});

test('rejects every release branch pair except main to release', (t) => {
  const { repository, baseSha, candidateSha } = createCandidateRepository(t);
  git(repository, 'branch', 'release-prep/v1.1.0', candidateSha);
  git(repository, 'branch', 'production', baseSha);

  for (const [head, base] of [
    ['release-prep/v1.1.0', 'release'],
    ['main', 'production'],
  ]) {
    const result = runCandidateGuard(repository, candidateSha, { head, base });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /release promotion must use head=main and base=release/);
  }
});

test('invalidates an old candidate as soon as main moves', (t) => {
  const { repository, candidateSha } = createCandidateRepository(t);
  writeFileSync(path.join(repository, 'README.md'), 'main moved\n');
  git(repository, 'add', 'README.md');
  git(repository, 'commit', '-m', 'move main after candidate validation');
  const currentMainSha = git(repository, 'rev-parse', 'main');
  git(repository, 'switch', '--detach', candidateSha);

  const result = runCandidateGuard(repository, candidateSha);

  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    new RegExp(`candidate SHA ${candidateSha} is stale; main is ${currentMainSha}`),
  );
});

test('rejects a checkout that does not match the exact candidate SHA', (t) => {
  const { repository, baseSha, candidateSha } = createCandidateRepository(t);
  git(repository, 'switch', '--detach', baseSha);

  const result = runCandidateGuard(repository, candidateSha);

  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    new RegExp(`checked-out HEAD ${baseSha} does not match candidate SHA ${candidateSha}`),
  );
});

test('checks the live origin main SHA instead of trusting a stale tracking ref', (t) => {
  const { repository, candidateSha } = createCandidateRepository(t);
  publishFixtureToOrigin(t, repository);
  writeFileSync(path.join(repository, 'README.md'), 'origin main moved\n');
  git(repository, 'add', 'README.md');
  git(repository, 'commit', '-m', 'move origin main');
  const currentMainSha = git(repository, 'rev-parse', 'HEAD');
  git(repository, 'push', 'origin', 'main');
  git(repository, 'switch', '--detach', candidateSha);
  git(repository, 'branch', '--force', 'main', candidateSha);
  git(repository, 'update-ref', 'refs/remotes/origin/main', candidateSha);

  const result = runCandidateGuard(repository, candidateSha);

  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    new RegExp(`candidate SHA ${candidateSha} is stale; main is ${currentMainSha}`),
  );
});

test('rejects prerelease and other non-stable candidate versions', (t) => {
  const { repository, candidateSha } = createCandidateRepository(t, {
    candidateVersion: '1.1.0-rc.1',
  });
  const result = runCandidateGuard(repository, candidateSha);

  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /candidate version must be a stable SemVer x\.y\.z, found 1\.1\.0-rc\.1/,
  );
});

test('rejects a candidate whose version copies have drifted', (t) => {
  const { repository } = createCandidateRepository(t);
  const lockPath = path.join(repository, 'package-lock.json');
  writeJson(repository, 'package-lock.json', {
    name: 'skill-expert',
    version: '9.9.9',
    lockfileVersion: 3,
    packages: { '': { name: 'skill-expert', version: '1.1.0' } },
  });
  git(repository, 'add', lockPath);
  git(repository, 'commit', '--amend', '--no-edit');
  const candidateSha = git(repository, 'rev-parse', 'HEAD');

  const result = runCandidateGuard(repository, candidateSha);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /candidate version contract is inconsistent/);
  assert.match(result.stderr, /package-lock\.json root version: expected 1\.1\.0, found 9\.9\.9/);
});

test('rejects a candidate with empty English or Chinese release notes', (t) => {
  const { repository } = createCandidateRepository(t);
  writeVersionContract(repository, '1.1.0', { englishNotes: '', chineseNotes: '' });
  git(repository, 'add', 'CHANGELOG.md', 'CHANGELOG-zh.md');
  git(repository, 'commit', '--amend', '--no-edit');
  const candidateSha = git(repository, 'rev-parse', 'HEAD');

  const result = runCandidateGuard(repository, candidateSha);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /CHANGELOG\.md release 1\.1\.0 must contain a non-empty bullet/);
  assert.match(result.stderr, /CHANGELOG-zh\.md release 1\.1\.0 must contain a non-empty bullet/);
});

test('rejects an existing candidate tag even when it exists only on origin', (t) => {
  const { repository, candidateSha } = createCandidateRepository(t);
  publishFixtureToOrigin(t, repository, { tag: 'v1.1.0' });

  const result = runCandidateGuard(repository, candidateSha);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /tag v1\.1\.0 already exists on origin/);
});

test('accepts Skill Expert 1.0.0 as the one bootstrap from the legacy release baseline', (t) => {
  const { repository, candidateSha } = createCandidateRepository(t, {
    baseVersion: '1.34.2',
    basePackageName: 'skills-manager',
    candidateVersion: '1.0.0',
  });

  const result = runCandidateGuard(repository, candidateSha, { json: true });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).version, '1.0.0');
});

test('requires later Skill Expert candidates to advance the release version', (t) => {
  const { repository, candidateSha } = createCandidateRepository(t, {
    baseVersion: '1.1.0',
    candidateVersion: '1.1.0',
  });
  const result = runCandidateGuard(repository, candidateSha);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /candidate version 1\.1\.0 must be newer than release version 1\.1\.0/);
});

test('renders the complete bilingual release promotion approval contract', (t) => {
  const { repository, baseSha, candidateSha } = createCandidateRepository(t);
  publishFixtureToOrigin(t, repository);
  const outputPath = path.join(repository, 'release-pr.md');
  const result = runCandidate(repository, [
    'render-pr-body',
    '--candidate-sha',
    candidateSha,
    '--head',
    'main',
    '--base',
    'release',
    '--output',
    outputPath,
  ]);

  assert.equal(result.status, 0, result.stderr);
  const body = readFileSync(outputPath, 'utf8');
  assert.match(body, /Skill Expert v1\.1\.0/);
  assert.match(body, new RegExp(`Candidate SHA[^\n]+${candidateSha}`));
  assert.match(body, new RegExp(`Commit range[^\n]+${baseSha}\.\.${candidateSha}`));
  assert.match(body, /English release note/);
  assert.match(body, /中文发布说明/);
  assert.match(body, /macOS arm64[^]*macOS x64[^]*Windows x64[^]*Linux x64/);
  assert.match(body, /ad-hoc signed/i);
  assert.match(body, /not notarized/i);
  assert.match(body, /Gatekeeper[^\n]+Open Anyway/i);
  assert.match(body, /Ordinary main CI[^\n]+passed/i);
  assert.match(body, /Four-target candidate packaging[^\n]+passed/i);
  assert.match(body, /Version consistency[^\n]+passed/i);
  assert.match(body, /refs\/tags\/v1\.1\.0 is absent locally and on origin/);
  assert.match(body, /Merge means publication approval \/ 合并即批准正式发布/);
  assert.match(body, /Merge commit required \/ 必须使用 merge commit/);
  assert.match(body, /Normal feature pull requests may still use squash/);
});
