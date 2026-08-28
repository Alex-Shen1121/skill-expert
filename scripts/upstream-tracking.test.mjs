import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const trackingCli = path.join(repositoryRoot, 'scripts/upstream-tracking.mjs');
const trustedUpstream = 'https://github.com/xingkongliang/skills-manager.git';

function git(repository, ...args) {
  const result = spawnSync('git', args, { cwd: repository, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || `git ${args.join(' ')} failed`);
  return result.stdout.trim();
}

function write(repository, relativePath, contents) {
  const filePath = path.join(repository, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, contents);
}

function createFixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'skill-expert-upstream-tracking-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const upstreamWork = path.join(root, 'upstream-work');
  const upstreamBare = path.join(root, 'upstream.git');
  const forkWork = path.join(root, 'fork-work');
  const originBare = path.join(root, 'origin.git');
  const checkout = path.join(root, 'checkout');

  mkdirSync(upstreamWork);
  git(upstreamWork, 'init', '-b', 'main');
  git(upstreamWork, 'config', 'user.name', 'Upstream Test');
  git(upstreamWork, 'config', 'user.email', 'upstream@example.com');
  write(upstreamWork, 'src/shared.txt', 'shared baseline\n');
  write(upstreamWork, 'package.json', '{"name":"skills-manager","version":"1.34.2"}\n');
  write(upstreamWork, 'CHANGELOG.md', '# Skills Manager history\n');
  write(upstreamWork, 'assets/star-history.svg', '<svg>upstream baseline</svg>\n');
  write(upstreamWork, '.github/workflows/release.yml', 'name: Upstream release\n');
  write(
    upstreamWork,
    'src-tauri/tauri.conf.json',
    '{"productName":"Skills Manager","identifier":"dev.skillsmanager.app"}\n',
  );
  git(upstreamWork, 'add', '.');
  git(upstreamWork, 'commit', '-m', 'upstream baseline');
  git(root, 'init', '--bare', '--initial-branch=main', upstreamBare);
  git(upstreamWork, 'remote', 'add', 'origin', upstreamBare);
  git(upstreamWork, 'push', '-u', 'origin', 'main');

  git(root, 'clone', upstreamBare, forkWork);
  git(forkWork, 'config', 'user.name', 'Skill Expert Test');
  git(forkWork, 'config', 'user.email', 'skill-expert@example.com');
  write(forkWork, 'package.json', '{"name":"skill-expert","version":"1.0.0"}\n');
  write(forkWork, 'CHANGELOG.md', '# Skill Expert history\n');
  write(forkWork, '.github/workflows/release.yml', 'name: Skill Expert release\n');
  write(
    forkWork,
    'src-tauri/tauri.conf.json',
    '{"productName":"Skill Expert","identifier":"com.codingshen.skill-expert"}\n',
  );
  write(forkWork, 'src/fork.txt', 'Skill Expert decision\n');
  git(forkWork, 'add', '.');
  git(forkWork, 'commit', '-m', 'establish Skill Expert');
  git(root, 'init', '--bare', '--initial-branch=main', originBare);
  git(forkWork, 'remote', 'set-url', 'origin', originBare);
  git(forkWork, 'push', '-u', 'origin', 'main');

  git(root, 'clone', originBare, checkout);
  git(checkout, 'config', 'user.name', 'Tracking Bot');
  git(checkout, 'config', 'user.email', 'tracking@example.com');
  git(checkout, 'config', `url.${upstreamBare}.insteadOf`, trustedUpstream);

  return { root, upstreamWork, upstreamBare, originBare, checkout };
}

function read(repository, relativePath) {
  return readFileSync(path.join(repository, relativePath), 'utf8');
}

function runTracking(repository, resultPath, extra = []) {
  return spawnSync(
    process.execPath,
    [trackingCli, 'prepare', '--result', resultPath, ...extra],
    { cwd: repository, encoding: 'utf8' },
  );
}

function verifyReview(repository, extra = []) {
  return spawnSync(process.execPath, [trackingCli, 'verify-review', ...extra], {
    cwd: repository,
    encoding: 'utf8',
  });
}

test('requires provenance metadata on the fixed upstream review branch', (t) => {
  const { checkout } = createFixture(t);

  const verification = verifyReview(checkout, ['--required', 'true']);

  assert.notEqual(verification.status, 0);
  assert.match(
    verification.stderr,
    /fixed upstream review branch must retain \.github\/upstream-tracking-review\.json/,
  );
});

test('reports no new upstream commits without changing repository branches or files', (t) => {
  const { root, checkout } = createFixture(t);
  const resultPath = path.join(root, 'result.json');
  const mainBefore = git(checkout, 'rev-parse', 'refs/heads/main');
  const headsBefore = git(checkout, 'for-each-ref', '--format=%(refname):%(objectname)', 'refs/heads');

  const result = runTracking(checkout, resultPath);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /No new upstream commits; the review branch was left unchanged\./);
  assert.equal(git(checkout, 'rev-parse', 'refs/heads/main'), mainBefore);
  assert.equal(
    git(checkout, 'for-each-ref', '--format=%(refname):%(objectname)', 'refs/heads'),
    headsBefore,
  );
  assert.equal(git(checkout, 'status', '--porcelain'), '');
  assert.equal(git(checkout, 'branch', '--list', 'upstream-tracking/main'), '');
});

test('rejects every attempt to override the trusted upstream repository or branch', (t) => {
  const { root, checkout } = createFixture(t);
  const resultPath = path.join(root, 'result.json');

  for (const override of [
    ['--upstream-url', path.join(root, 'untrusted.git')],
    ['--upstream-branch', 'develop'],
  ]) {
    const result = runTracking(checkout, resultPath, override);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unsupported prepare option: --upstream-(?:url|branch)/);
  }
  assert.equal(git(checkout, 'branch', '--list', 'upstream-tracking/main'), '');
  assert.equal(git(checkout, 'status', '--porcelain'), '');
});

test('prepares a fixed review branch while preserving Skill Expert release decisions', (t) => {
  const { root, upstreamWork, checkout } = createFixture(t);
  write(upstreamWork, 'src/shared.txt', 'upstream feature\n');
  write(upstreamWork, 'src/new-feature.txt', 'new upstream behavior\n');
  write(upstreamWork, 'package.json', '{"name":"skills-manager","version":"1.35.0"}\n');
  write(upstreamWork, 'CHANGELOG.md', '# Skills Manager 1.35.0\n');
  write(upstreamWork, '.github/workflows/release.yml', 'name: Publish upstream automatically\n');
  write(
    upstreamWork,
    'src-tauri/tauri.conf.json',
    '{"productName":"Skills Manager Next","identifier":"dev.skillsmanager.next"}\n',
  );
  git(upstreamWork, 'add', '.');
  git(upstreamWork, 'commit', '-m', 'add upstream feature');
  git(upstreamWork, 'push', 'origin', 'main');
  const upstreamSha = git(upstreamWork, 'rev-parse', 'HEAD');
  const mainBefore = git(checkout, 'rev-parse', 'refs/heads/main');
  const resultPath = path.join(root, 'result.json');

  const result = runTracking(checkout, resultPath);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Prepared upstream review branch upstream-tracking\/main/);
  const outcome = JSON.parse(readFileSync(resultPath, 'utf8'));
  assert.equal(outcome.status, 'review-ready');
  assert.equal(outcome.syncBranch, 'upstream-tracking/main');
  assert.equal(outcome.upstream.sha, upstreamSha);
  assert.equal(outcome.mainSha, mainBefore);
  assert.equal(git(checkout, 'rev-parse', 'refs/heads/main'), mainBefore);
  assert.equal(git(checkout, 'branch', '--show-current'), 'upstream-tracking/main');
  assert.equal(read(checkout, 'src/shared.txt'), 'upstream feature\n');
  assert.equal(read(checkout, 'src/new-feature.txt'), 'new upstream behavior\n');
  assert.equal(read(checkout, 'package.json'), '{"name":"skill-expert","version":"1.0.0"}\n');
  assert.equal(read(checkout, 'CHANGELOG.md'), '# Skill Expert history\n');
  assert.equal(read(checkout, '.github/workflows/release.yml'), 'name: Skill Expert release\n');
  assert.equal(
    read(checkout, 'src-tauri/tauri.conf.json'),
    '{"productName":"Skill Expert","identifier":"com.codingshen.skill-expert"}\n',
  );
  assert.deepEqual(
    JSON.parse(read(checkout, '.github/upstream-tracking-review.json')),
    {
      upstreamRepository: 'xingkongliang/skills-manager',
      upstreamBranch: 'main',
      upstreamSha,
      baseMainSha: mainBefore,
      conflicts: [],
      protectedChanges: [
        '.github/workflows/release.yml',
        'CHANGELOG.md',
        'package.json',
        'src-tauri/tauri.conf.json',
      ],
    },
  );
  assert.equal(git(checkout, 'show', '-s', '--format=%P', 'HEAD').split(' ').length, 2);
  assert.equal(git(checkout, 'status', '--porcelain'), '');
  const verification = verifyReview(checkout);
  assert.equal(verification.status, 0, verification.stderr);
  assert.match(verification.stdout, /Upstream review has no unresolved conflict paths\./);
});

test('我方删除而上游修改受保护文件时仍可生成评审', (t) => {
  const { root, upstreamWork, checkout } = createFixture(t);
  git(checkout, 'rm', 'assets/star-history.svg');
  git(checkout, 'commit', '-m', '删除独立发行不再使用的历史图');
  git(checkout, 'push', 'origin', 'main');

  write(upstreamWork, 'assets/star-history.svg', '<svg>upstream changed</svg>\n');
  git(upstreamWork, 'add', 'assets/star-history.svg');
  git(upstreamWork, 'commit', '-m', '更新上游历史图');
  git(upstreamWork, 'push', 'origin', 'main');
  const resultPath = path.join(root, 'result.json');

  const result = runTracking(checkout, resultPath);

  assert.equal(result.status, 0, result.stderr);
  const outcome = JSON.parse(readFileSync(resultPath, 'utf8'));
  assert.equal(outcome.status, 'review-ready');
  assert.ok(outcome.protectedChanges.includes('assets/star-history.svg'));
  assert.equal(existsSync(path.join(checkout, 'assets/star-history.svg')), false);
  assert.equal(git(checkout, 'status', '--porcelain'), '');
});

test('按独立治理清单保护工作树基线入口与安全文档', (t) => {
  const { root, upstreamWork, checkout } = createFixture(t);
  write(checkout, 'scripts/worktree-baseline.mjs', 'Skill Expert 工作树入口\n');
  write(checkout, 'docs/worktree-baseline.md', '# Skill Expert 安全同步\n');
  git(checkout, 'add', '--', 'scripts/worktree-baseline.mjs', 'docs/worktree-baseline.md');
  git(checkout, 'commit', '-m', '建立工作树安全治理');
  git(checkout, 'push', 'origin', 'main');

  write(upstreamWork, 'scripts/worktree-baseline.mjs', 'upstream worktree command\n');
  write(upstreamWork, 'docs/worktree-baseline.md', '# upstream worktree guide\n');
  git(upstreamWork, 'add', '--', 'scripts/worktree-baseline.mjs', 'docs/worktree-baseline.md');
  git(upstreamWork, 'commit', '-m', '添加上游工作树工具');
  git(upstreamWork, 'push', 'origin', 'main');
  const resultPath = path.join(root, 'result.json');

  const result = runTracking(checkout, resultPath);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(read(checkout, 'scripts/worktree-baseline.mjs'), 'Skill Expert 工作树入口\n');
  assert.equal(read(checkout, 'docs/worktree-baseline.md'), '# Skill Expert 安全同步\n');
  const outcome = JSON.parse(readFileSync(resultPath, 'utf8'));
  assert.ok(outcome.protectedChanges.includes('scripts/worktree-baseline.mjs'));
  assert.ok(outcome.protectedChanges.includes('docs/worktree-baseline.md'));
});

test('keeps a conflicting upstream change reviewable and reports the exact paths', (t) => {
  const { root, upstreamWork, checkout } = createFixture(t);
  write(checkout, 'src/shared.txt', 'Skill Expert adaptation\n');
  git(checkout, 'add', 'src/shared.txt');
  git(checkout, 'commit', '-m', 'adapt shared behavior for Skill Expert');
  git(checkout, 'push', 'origin', 'main');
  const mainBefore = git(checkout, 'rev-parse', 'refs/heads/main');

  write(upstreamWork, 'src/shared.txt', 'conflicting upstream behavior\n');
  git(upstreamWork, 'add', 'src/shared.txt');
  git(upstreamWork, 'commit', '-m', 'change shared upstream behavior');
  git(upstreamWork, 'push', 'origin', 'main');
  const upstreamSha = git(upstreamWork, 'rev-parse', 'HEAD');
  const resultPath = path.join(root, 'result.json');

  const result = runTracking(checkout, resultPath);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Conflicts require manual review: src\/shared\.txt/);
  const outcome = JSON.parse(readFileSync(resultPath, 'utf8'));
  assert.equal(outcome.status, 'conflicts');
  assert.deepEqual(outcome.conflicts, ['src/shared.txt']);
  assert.equal(outcome.mainSha, mainBefore);
  assert.equal(outcome.upstream.sha, upstreamSha);
  assert.equal(git(checkout, 'rev-parse', 'refs/heads/main'), mainBefore);
  assert.equal(read(checkout, 'src/shared.txt'), 'Skill Expert adaptation\n');
  assert.deepEqual(
    JSON.parse(read(checkout, '.github/upstream-tracking-review.json')).conflicts,
    ['src/shared.txt'],
  );
  const verification = verifyReview(checkout);
  assert.notEqual(verification.status, 0);
  assert.match(
    verification.stderr,
    /upstream review still requires manual reconciliation: src\/shared\.txt/,
  );
  assert.equal(git(checkout, 'show', '-s', '--format=%P', 'HEAD').split(' ').length, 2);
  assert.equal(git(checkout, 'status', '--porcelain'), '');
});

test('拒绝已经退出的 release 候选参数', (t) => {
  const { root, upstreamWork, checkout } = createFixture(t);
  write(upstreamWork, 'src/new-feature.txt', 'new upstream behavior\n');
  git(upstreamWork, 'add', 'src/new-feature.txt');
  git(upstreamWork, 'commit', '-m', 'add upstream feature during release review');
  git(upstreamWork, 'push', 'origin', 'main');
  const resultPath = path.join(root, 'result.json');

  const result = runTracking(checkout, resultPath, [
    '--release-candidate-sha',
    git(checkout, 'rev-parse', 'refs/heads/main'),
  ]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unsupported prepare option: --release-candidate-sha/);
});

test('does not rewrite an existing review branch when upstream has no newer commit', (t) => {
  const { root, upstreamWork, originBare, checkout } = createFixture(t);
  write(upstreamWork, 'src/new-feature.txt', 'new upstream behavior\n');
  git(upstreamWork, 'add', 'src/new-feature.txt');
  git(upstreamWork, 'commit', '-m', 'add upstream feature');
  git(upstreamWork, 'push', 'origin', 'main');

  const firstResultPath = path.join(root, 'first-result.json');
  const first = runTracking(checkout, firstResultPath);
  assert.equal(first.status, 0, first.stderr);
  git(checkout, 'push', 'origin', 'upstream-tracking/main');
  const remoteReviewBefore = git(
    checkout,
    'ls-remote',
    'origin',
    'refs/heads/upstream-tracking/main',
  );

  const secondCheckout = path.join(root, 'second-checkout');
  git(root, 'clone', originBare, secondCheckout);
  git(secondCheckout, 'config', 'user.name', 'Tracking Bot');
  git(secondCheckout, 'config', 'user.email', 'tracking@example.com');
  git(
    secondCheckout,
    'config',
    `url.${path.join(root, 'upstream.git')}.insteadOf`,
    trustedUpstream,
  );
  const headsBefore = git(
    secondCheckout,
    'for-each-ref',
    '--format=%(refname):%(objectname)',
    'refs/heads',
  );
  const secondResultPath = path.join(root, 'second-result.json');
  const secondBodyPath = path.join(root, 'second-pr.md');

  const second = runTracking(secondCheckout, secondResultPath, ['--body', secondBodyPath]);

  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /No new upstream commits; the review branch was left unchanged\./);
  const outcome = JSON.parse(readFileSync(secondResultPath, 'utf8'));
  assert.equal(outcome.status, 'no-change');
  assert.equal(outcome.syncSha, remoteReviewBefore.split(/\s+/)[0]);
  assert.match(outcome.prTitle, /^Upstream tracking: [0-9a-f]{12}$/);
  assert.match(readFileSync(secondBodyPath, 'utf8'), /never merges upstream changes automatically/);
  assert.equal(
    git(secondCheckout, 'for-each-ref', '--format=%(refname):%(objectname)', 'refs/heads'),
    headsBefore,
  );
  assert.equal(
    git(secondCheckout, 'ls-remote', 'origin', 'refs/heads/upstream-tracking/main'),
    remoteReviewBefore,
  );
  assert.equal(git(secondCheckout, 'status', '--porcelain'), '');
});

test('does not recreate a review after main absorbed upstream and the fixed branch remained', (t) => {
  const { root, upstreamWork, originBare, checkout } = createFixture(t);
  write(upstreamWork, 'src/new-feature.txt', 'new upstream behavior\n');
  git(upstreamWork, 'add', 'src/new-feature.txt');
  git(upstreamWork, 'commit', '-m', 'add upstream feature');
  git(upstreamWork, 'push', 'origin', 'main');
  const firstResultPath = path.join(root, 'first-result.json');
  const first = runTracking(checkout, firstResultPath);
  assert.equal(first.status, 0, first.stderr);
  git(checkout, 'push', 'origin', 'upstream-tracking/main');
  git(checkout, 'switch', 'main');
  git(checkout, 'merge', '--no-ff', 'upstream-tracking/main', '-m', 'merge reviewed upstream');
  git(checkout, 'push', 'origin', 'main');
  const mergedMainSha = git(checkout, 'rev-parse', 'main');

  const secondCheckout = path.join(root, 'merged-checkout');
  git(root, 'clone', originBare, secondCheckout);
  git(secondCheckout, 'config', `url.${path.join(root, 'upstream.git')}.insteadOf`, trustedUpstream);
  const resultPath = path.join(root, 'merged-result.json');
  const bodyPath = path.join(root, 'merged-pr.md');

  const second = runTracking(secondCheckout, resultPath, ['--body', bodyPath]);

  assert.equal(second.status, 0, second.stderr);
  const outcome = JSON.parse(readFileSync(resultPath, 'utf8'));
  assert.equal(outcome.status, 'no-change');
  assert.equal(outcome.mainSha, mergedMainSha);
  assert.equal('syncSha' in outcome, false);
  assert.equal('prTitle' in outcome, false);
  assert.equal(existsSync(bodyPath), false);
  assert.notEqual(
    git(secondCheckout, 'ls-remote', 'origin', 'refs/heads/upstream-tracking/main'),
    '',
  );
});

test('does not recreate a review after a squash merge with or without the fixed branch', (t) => {
  const { root, upstreamWork, originBare, checkout } = createFixture(t);
  write(upstreamWork, 'src/new-feature.txt', 'new upstream behavior\n');
  git(upstreamWork, 'add', 'src/new-feature.txt');
  git(upstreamWork, 'commit', '-m', 'add upstream feature');
  git(upstreamWork, 'push', 'origin', 'main');
  const firstResultPath = path.join(root, 'first-result.json');
  const first = runTracking(checkout, firstResultPath);
  assert.equal(first.status, 0, first.stderr);
  git(checkout, 'push', 'origin', 'upstream-tracking/main');
  git(checkout, 'switch', 'main');
  git(checkout, 'merge', '--squash', 'upstream-tracking/main');
  git(checkout, 'commit', '-m', 'squash reviewed upstream');
  git(checkout, 'push', 'origin', 'main');
  const mergedMainSha = git(checkout, 'rev-parse', 'main');

  const outcomes = [];
  for (const branchState of ['retained', 'deleted']) {
    if (branchState === 'deleted') {
      git(checkout, 'push', 'origin', '--delete', 'upstream-tracking/main');
    }
    const reviewCheckout = path.join(root, `squash-${branchState}-checkout`);
    git(root, 'clone', originBare, reviewCheckout);
    git(
      reviewCheckout,
      'config',
      `url.${path.join(root, 'upstream.git')}.insteadOf`,
      trustedUpstream,
    );
    const resultPath = path.join(root, `squash-${branchState}-result.json`);
    const bodyPath = path.join(root, `squash-${branchState}-pr.md`);
    const result = runTracking(reviewCheckout, resultPath, ['--body', bodyPath]);
    assert.equal(result.status, 0, result.stderr);
    outcomes.push({
      branchState,
      bodyExists: existsSync(bodyPath),
      outcome: JSON.parse(readFileSync(resultPath, 'utf8')),
    });
  }

  for (const { bodyExists, outcome } of outcomes) {
    assert.equal(outcome.status, 'no-change');
    assert.equal(outcome.mainSha, mergedMainSha);
    assert.equal('syncSha' in outcome, false);
    assert.equal('prTitle' in outcome, false);
    assert.equal(bodyExists, false);
  }
});

test('updates the same review branch when trusted upstream main advances again', (t) => {
  const { root, upstreamWork, checkout } = createFixture(t);
  write(upstreamWork, 'src/first-feature.txt', 'first upstream change\n');
  git(upstreamWork, 'add', 'src/first-feature.txt');
  git(upstreamWork, 'commit', '-m', 'first upstream change');
  git(upstreamWork, 'push', 'origin', 'main');
  const firstResultPath = path.join(root, 'first-result.json');
  const first = runTracking(checkout, firstResultPath);
  assert.equal(first.status, 0, first.stderr);
  const firstReviewSha = git(checkout, 'rev-parse', 'HEAD');
  git(checkout, 'push', 'origin', 'upstream-tracking/main');

  write(upstreamWork, 'src/second-feature.txt', 'second upstream change\n');
  git(upstreamWork, 'add', 'src/second-feature.txt');
  git(upstreamWork, 'commit', '-m', 'second upstream change');
  git(upstreamWork, 'push', 'origin', 'main');
  const latestUpstreamSha = git(upstreamWork, 'rev-parse', 'HEAD');
  const secondResultPath = path.join(root, 'second-result.json');

  const second = runTracking(checkout, secondResultPath);

  assert.equal(second.status, 0, second.stderr);
  const outcome = JSON.parse(readFileSync(secondResultPath, 'utf8'));
  assert.equal(outcome.status, 'review-ready');
  assert.equal(outcome.syncBranch, 'upstream-tracking/main');
  assert.equal(outcome.previousSyncSha, firstReviewSha);
  assert.equal(outcome.upstream.sha, latestUpstreamSha);
  assert.notEqual(outcome.syncSha, firstReviewSha);
  assert.equal(read(checkout, 'src/first-feature.txt'), 'first upstream change\n');
  assert.equal(read(checkout, 'src/second-feature.txt'), 'second upstream change\n');
  assert.equal(git(checkout, 'rev-parse', 'refs/heads/main'), outcome.mainSha);
});
