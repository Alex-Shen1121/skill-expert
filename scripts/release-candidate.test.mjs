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

function isAncestor(repository, ancestor, descendant) {
  const result = spawnSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], {
    cwd: repository,
    encoding: 'utf8',
  });
  assert.ok([0, 1].includes(result.status), result.stderr);
  return result.status === 0;
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
    candidateVersion = '1.0.1',
    basePackageName = 'skill-expert',
  } = {},
) {
  const repository = mkdtempSync(path.join(tmpdir(), 'skill-expert-release-candidate-'));
  t.after(() => rmSync(repository, { recursive: true, force: true }));

  git(repository, 'init', '-b', 'release');
  git(repository, 'config', 'user.name', 'Release Candidate Test');
  git(repository, 'config', 'user.email', 'release-candidate@example.com');
  mkdirSync(path.join(repository, 'src-tauri'), { recursive: true });
  let baseSha;
  if (basePackageName === 'skill-expert') {
    writeVersionContract(repository, '1.34.2', { packageName: 'skills-manager' });
    git(repository, 'add', '.');
    git(repository, 'commit', '-m', '建立旧版 release 基线');
    git(repository, 'switch', '-c', 'main');
    writeVersionContract(repository, baseVersion);
    git(repository, 'add', '.');
    git(repository, 'commit', '-m', `准备 Skill Expert v${baseVersion}`);
    git(repository, 'switch', 'release');
    git(repository, 'merge', '--no-ff', 'main', '-m', `晋级 Skill Expert v${baseVersion}`);
    baseSha = git(repository, 'rev-parse', 'HEAD');
    git(repository, 'switch', 'main');
  } else {
    writeVersionContract(repository, baseVersion, { packageName: basePackageName });
    git(repository, 'add', '.');
    git(repository, 'commit', '-m', `建立旧版 release v${baseVersion}`);
    baseSha = git(repository, 'rev-parse', 'HEAD');
    git(repository, 'switch', '-c', 'main');
  }
  writeVersionContract(repository, candidateVersion);
  git(repository, 'add', '.');
  git(repository, 'commit', '--allow-empty', '-m', `prepare v${candidateVersion}`);
  const candidateSha = git(repository, 'rev-parse', 'HEAD');

  return { repository, baseSha, candidateSha };
}

function createRepeatedPromotionRepository(t) {
  const repository = mkdtempSync(path.join(tmpdir(), 'skill-expert-repeated-promotion-'));
  t.after(() => rmSync(repository, { recursive: true, force: true }));

  git(repository, 'init', '-b', 'release');
  git(repository, 'config', 'user.name', 'Release Candidate Test');
  git(repository, 'config', 'user.email', 'release-candidate@example.com');
  mkdirSync(path.join(repository, 'src-tauri'), { recursive: true });
  writeVersionContract(repository, '1.34.2', { packageName: 'skills-manager' });
  git(repository, 'add', '.');
  git(repository, 'commit', '-m', '建立旧版 release 基线');

  git(repository, 'switch', '-c', 'main');
  writeVersionContract(repository, '1.0.0');
  git(repository, 'add', '.');
  git(repository, 'commit', '-m', '准备 Skill Expert v1.0.0');
  const previousCandidateSha = git(repository, 'rev-parse', 'HEAD');

  git(repository, 'switch', 'release');
  git(repository, 'merge', '--no-ff', 'main', '-m', '晋级 Skill Expert v1.0.0');
  const baseSha = git(repository, 'rev-parse', 'HEAD');

  git(repository, 'switch', 'main');
  writeVersionContract(repository, '1.0.1');
  git(repository, 'add', '.');
  git(repository, 'commit', '-m', '准备 Skill Expert v1.0.1');
  const candidateSha = git(repository, 'rev-parse', 'HEAD');

  return { repository, previousCandidateSha, baseSha, candidateSha };
}

function runCandidate(repository, args) {
  const releaseBaselineSha = git(repository, 'rev-list', '--max-parents=0', 'release')
    .split('\n')
    .at(0);
  return spawnSync(process.execPath, [candidateCli, ...args], {
    cwd: repository,
    encoding: 'utf8',
    env: {
      ...process.env,
      SKILL_EXPERT_RELEASE_BASELINE_SHA: releaseBaselineSha,
    },
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
    version: '1.0.1',
    tag: 'v1.0.1',
    candidateSha,
    baseSha,
    commitRange: `${baseSha}..${candidateSha}`,
    tagAbsence: 'refs/tags/v1.0.1 在本地不存在（未配置 origin）',
  });
});

test('接受 release 保留上次晋级 merge commit 后的下一次 main 候选', (t) => {
  const { repository, baseSha, candidateSha } = createRepeatedPromotionRepository(t);

  const result = runCandidateGuard(repository, candidateSha, { json: true });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    version: '1.0.1',
    tag: 'v1.0.1',
    candidateSha,
    baseSha,
    commitRange: `${baseSha}..${candidateSha}`,
    tagAbsence: 'refs/tags/v1.0.1 在本地不存在（未配置 origin）',
  });
});

test('拒绝把 release 独有的单父提交当作上一次合法晋级', (t) => {
  const { repository, candidateSha } = createRepeatedPromotionRepository(t);
  git(repository, 'switch', 'release');
  writeFileSync(path.join(repository, 'release-only.txt'), '禁止 release 独有修改\n');
  git(repository, 'add', 'release-only.txt');
  git(repository, 'commit', '-m', '错误：直接修改 release');
  git(repository, 'switch', 'main');

  const result = runCandidateGuard(repository, candidateSha);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /release 第一父历史只能包含合法的双父晋级 merge commit/);
});

test('拒绝藏在后续 merge commit 第一父链中的 release 独有提交', (t) => {
  const { repository } = createRepeatedPromotionRepository(t);
  git(repository, 'switch', 'release');
  writeFileSync(path.join(repository, 'release-only.txt'), '禁止隐藏 release 独有修改\n');
  git(repository, 'add', 'release-only.txt');
  git(repository, 'commit', '-m', '错误：直接修改 release');
  git(repository, 'merge', '--no-ff', 'main', '-m', '伪装：晋级 Skill Expert v1.0.1');
  git(repository, 'rm', 'release-only.txt');
  git(repository, 'commit', '--amend', '--no-edit');

  git(repository, 'switch', 'main');
  writeVersionContract(repository, '1.0.2');
  git(repository, 'add', '.');
  git(repository, 'commit', '-m', '准备 Skill Expert v1.0.2');
  const candidateSha = git(repository, 'rev-parse', 'HEAD');

  const result = runCandidateGuard(repository, candidateSha);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /release 第一父历史只能包含合法的双父晋级 merge commit/);
});

test('拒绝把 release 直接移动到旧 main 候选后继续晋级', (t) => {
  const { repository, previousCandidateSha, candidateSha } =
    createRepeatedPromotionRepository(t);
  git(repository, 'branch', '--force', 'release', previousCandidateSha);

  const result = runCandidateGuard(repository, candidateSha);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /release 第一父历史只能包含合法的双父晋级 merge commit/);
});

test('拒绝由互不连续的并行 main 候选伪造 release 晋级链', (t) => {
  const repository = mkdtempSync(path.join(tmpdir(), 'skill-expert-parallel-promotion-'));
  t.after(() => rmSync(repository, { recursive: true, force: true }));
  git(repository, 'init', '-b', 'release');
  git(repository, 'config', 'user.name', 'Release Candidate Test');
  git(repository, 'config', 'user.email', 'release-candidate@example.com');
  mkdirSync(path.join(repository, 'src-tauri'), { recursive: true });
  writeVersionContract(repository, '1.34.2', { packageName: 'skills-manager' });
  git(repository, 'add', '.');
  git(repository, 'commit', '-m', '建立旧版 release 基线');
  const baselineSha = git(repository, 'rev-parse', 'HEAD');

  git(repository, 'switch', '-c', 'side');
  writeVersionContract(repository, '1.0.0');
  writeFileSync(path.join(repository, 'side.txt'), '并行侧支候选\n');
  git(repository, 'add', '.');
  git(repository, 'commit', '-m', '准备侧支 Skill Expert v1.0.0');
  const sideCandidateSha = git(repository, 'rev-parse', 'HEAD');
  git(repository, 'switch', 'release');
  git(repository, 'merge', '--no-ff', 'side', '-m', '晋级侧支 Skill Expert v1.0.0');
  const firstReleaseSha = git(repository, 'rev-parse', 'HEAD');

  git(repository, 'switch', '-c', 'main', baselineSha);
  writeVersionContract(repository, '1.0.1');
  writeFileSync(path.join(repository, 'main.txt'), '主线候选\n');
  git(repository, 'add', '.');
  git(repository, 'commit', '-m', '准备主线 Skill Expert v1.0.1');
  const mainCandidateSha = git(repository, 'rev-parse', 'HEAD');
  const forgedReleaseSha = git(
    repository,
    'commit-tree',
    `${mainCandidateSha}^{tree}`,
    '-p',
    firstReleaseSha,
    '-p',
    mainCandidateSha,
    '-m',
    '伪造：晋级不连续的 Skill Expert v1.0.1',
  );
  git(repository, 'update-ref', 'refs/heads/release', forgedReleaseSha);

  git(repository, 'merge', '--no-ff', '-s', 'ours', 'side', '-m', '让最终 main 同时包含两个侧支');
  writeVersionContract(repository, '1.0.2');
  git(repository, 'add', '.');
  git(repository, 'commit', '-m', '准备 Skill Expert v1.0.2');
  const candidateSha = git(repository, 'rev-parse', 'HEAD');

  assert.equal(isAncestor(repository, sideCandidateSha, candidateSha), true);
  assert.equal(isAncestor(repository, mainCandidateSha, candidateSha), true);
  assert.equal(isAncestor(repository, sideCandidateSha, mainCandidateSha), false);

  const result = runCandidateGuard(repository, candidateSha);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /较旧的晋级候选 [0-9a-f]{40} 必须是下一次晋级候选/);
});

test('拒绝树内容不等于上次 main 候选的 release merge commit', (t) => {
  const { repository, candidateSha } = createRepeatedPromotionRepository(t);
  git(repository, 'switch', 'release');
  writeFileSync(path.join(repository, 'release-only.txt'), '篡改 merge tree\n');
  git(repository, 'add', 'release-only.txt');
  git(repository, 'commit', '--amend', '--no-edit');
  git(repository, 'switch', 'main');

  const result = runCandidateGuard(repository, candidateSha);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /release 的树必须与上一次晋级的 main 候选完全一致/);
});

test('rejects every release branch pair except main to release', (t) => {
  const { repository, baseSha, candidateSha } = createCandidateRepository(t);
  git(repository, 'branch', 'release-prep/v1.0.1', candidateSha);
  git(repository, 'branch', 'production', baseSha);

  for (const [head, base] of [
    ['release-prep/v1.0.1', 'release'],
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
    /候选版本必须是稳定 SemVer x\.y\.z，实际为 1\.1\.0-rc\.1/,
  );
});

test('rejects a candidate whose version copies have drifted', (t) => {
  const { repository } = createCandidateRepository(t);
  const lockPath = path.join(repository, 'package-lock.json');
  writeJson(repository, 'package-lock.json', {
    name: 'skill-expert',
    version: '9.9.9',
    lockfileVersion: 3,
    packages: { '': { name: 'skill-expert', version: '1.0.1' } },
  });
  git(repository, 'add', lockPath);
  git(repository, 'commit', '--amend', '--no-edit');
  const candidateSha = git(repository, 'rev-parse', 'HEAD');

  const result = runCandidateGuard(repository, candidateSha);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /candidate version contract is inconsistent/);
  assert.match(result.stderr, /package-lock\.json root version: expected 1\.0\.1, found 9\.9\.9/);
});

test('rejects a candidate with empty English or Chinese release notes', (t) => {
  const { repository } = createCandidateRepository(t);
  writeVersionContract(repository, '1.0.1', { englishNotes: '', chineseNotes: '' });
  git(repository, 'add', 'CHANGELOG.md', 'CHANGELOG-zh.md');
  git(repository, 'commit', '--amend', '--no-edit');
  const candidateSha = git(repository, 'rev-parse', 'HEAD');

  const result = runCandidateGuard(repository, candidateSha);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /CHANGELOG\.md release 1\.0\.1 must contain a non-empty bullet/);
  assert.match(result.stderr, /CHANGELOG-zh\.md release 1\.0\.1 must contain a non-empty bullet/);
});

test('rejects an existing candidate tag even when it exists only on origin', (t) => {
  const { repository, candidateSha } = createCandidateRepository(t);
  publishFixtureToOrigin(t, repository, { tag: 'v1.0.1' });

  const result = runCandidateGuard(repository, candidateSha);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /tag v1\.0\.1 already exists on origin/);
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
  assert.match(
    result.stderr,
    /正式候选版本 1\.1\.0 必须是 release 版本 1\.1\.0 的下一补丁版本；预期 1\.1\.1/,
  );
});

test('正式发布候选必须严格进入 release 的下一补丁版本，不能跳号', (t) => {
  const { repository, candidateSha } = createCandidateRepository(t, {
    baseVersion: '1.0.3',
    candidateVersion: '1.0.5',
  });

  const result = runCandidateGuard(repository, candidateSha);

  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /正式候选版本 1\.0\.5 必须是 release 版本 1\.0\.3 的下一补丁版本；预期 1\.0\.4/,
  );
});

test('生成完整的双语发布晋级批准契约', (t) => {
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
  assert.match(body, /Skill Expert v1\.0\.1/);
  assert.match(body, new RegExp(`Candidate SHA[^\n]+${candidateSha}`));
  assert.match(body, new RegExp(`提交范围[^\n]+${baseSha}\.\.${candidateSha}`));
  assert.match(body, /English release note/);
  assert.match(body, /中文发布说明/);
  assert.match(body, /macOS arm64[^]*macOS x64[^]*Windows x64[^]*Linux x64/);
  assert.match(body, /ad-hoc 签名/);
  assert.match(body, /未经 Apple 公证/);
  assert.match(body, /Gatekeeper[^\n]+仍要打开/);
  assert.match(body, /日常 main CI[^\n]+已通过/);
  assert.match(body, /四平台候选打包[^\n]+已通过/);
  assert.match(body, /版本一致性[^\n]+已通过/);
  assert.match(body, /refs\/tags\/v1\.0\.1 在本地和 origin 均不存在/);
  assert.match(body, /合并即批准正式发布/);
  assert.match(body, /必须使用 merge commit/);
  assert.match(body, /普通功能 PR 仍可使用 squash/);
});
