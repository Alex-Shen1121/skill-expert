import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baselineCli = path.join(repositoryRoot, 'scripts/worktree-baseline.mjs');

function runGit(repository, args, { allowFailure = false } = {}) {
  const result = spawnSync('git', args, {
    cwd: repository,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  if (!allowFailure) {
    assert.equal(result.status, 0, result.stderr || `git ${args.join(' ')} 执行失败`);
  }
  return result;
}

function git(repository, ...args) {
  return runGit(repository, args).stdout.trim();
}

function write(repository, relativePath, contents) {
  const filePath = path.join(repository, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, contents);
}

function createFixture(t, { defaultBranch = 'main' } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'skill-expert-worktree-baseline-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const seed = path.join(root, '远端种子');
  const origin = path.join(root, 'origin.git');
  const primary = path.join(root, '主工作目录');
  const linked = path.join(root, 'linked worktree\n第二行');

  mkdirSync(seed);
  git(seed, 'init', '-b', defaultBranch);
  git(seed, 'config', 'user.name', '基线测试');
  git(seed, 'config', 'user.email', 'baseline@example.com');
  write(seed, 'tracked.txt', '初始内容\n');
  git(seed, 'add', 'tracked.txt');
  git(seed, 'commit', '-m', '建立远端基线');
  git(root, 'init', '--bare', `--initial-branch=${defaultBranch}`, origin);
  git(seed, 'remote', 'add', 'origin', origin);
  git(seed, 'push', '-u', 'origin', defaultBranch);

  git(root, 'clone', origin, primary);
  git(primary, 'config', 'user.name', '基线测试');
  git(primary, 'config', 'user.email', 'baseline@example.com');
  git(primary, 'worktree', 'add', '-b', 'codex/诊断测试', linked, `origin/${defaultBranch}`);

  return {
    root,
    seed,
    origin,
    primary: realpathSync.native(primary),
    linked: realpathSync.native(linked),
  };
}

function runBaseline(repository, ...args) {
  return spawnSync(process.execPath, [baselineCli, ...args], {
    cwd: repository,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
}

function commitFile(repository, relativePath, contents, message) {
  write(repository, relativePath, contents);
  git(repository, 'add', '--', relativePath);
  git(repository, 'commit', '-m', message);
  return git(repository, 'rev-parse', 'HEAD');
}

test('从 linked worktree 以 JSON 报告真实远端 main 和干净基线', (t) => {
  const { primary, linked } = createFixture(t);

  const result = runBaseline(linked, 'diagnose', '--json');

  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.command, 'diagnose');
  assert.equal(report.exitCode, 0);
  assert.deepEqual(report.statuses, ['remote-baseline-confirmed', 'main-in-sync']);
  assert.equal(report.repository.primaryWorktree, primary);
  assert.equal(report.repository.currentWorktree, linked);
  assert.equal(report.remoteBaseline.branch, 'main');
  assert.equal(report.remoteBaseline.ref, 'refs/remotes/origin/main');
  assert.equal(report.remoteBaseline.refresh.status, 'refreshed');
  assert.equal(report.current.branch, 'codex/诊断测试');
  assert.equal(report.current.detached, false);
  assert.equal(report.worktrees.length, 2);
  assert.deepEqual(report.workingTree, { staged: [], unstaged: [], untracked: [] });
  assert.equal(report.developmentIntegration.relation, 'in-sync');
  assert.equal(report.developmentIntegration.ahead, 0);
  assert.equal(report.developmentIntegration.behind, 0);
});

test('准确报告 detached 与含换行路径的三类工作区状态', (t) => {
  const { linked } = createFixture(t);
  git(linked, 'switch', '--detach');
  write(linked, '已暂存\n文件.txt', '暂存内容\n');
  git(linked, 'add', '已暂存\n文件.txt');
  write(linked, 'tracked.txt', '未暂存修改\n');
  write(linked, '.superpowers/未跟踪 文件.txt', '不得修改\n');
  write(linked, '.worktrees/嵌套\n目录.txt', '同样不得修改\n');

  const result = runBaseline(linked, 'diagnose', '--json');

  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.current.branch, null);
  assert.equal(report.current.detached, true);
  assert.equal(report.worktrees.find((item) => item.path === linked).detached, true);
  assert.deepEqual(report.workingTree.staged, ['已暂存\n文件.txt']);
  assert.deepEqual(report.workingTree.unstaged, ['tracked.txt']);
  assert.deepEqual(report.workingTree.untracked, [
    '.superpowers/未跟踪 文件.txt',
    '.worktrees/嵌套\n目录.txt',
  ]);
  assert.deepEqual(report.statuses, [
    'remote-baseline-confirmed',
    'main-in-sync',
    'detached-head',
    'working-tree-staged',
    'working-tree-unstaged',
    'working-tree-untracked',
  ]);
});

test('把本地和远端各自前进识别为普通双向分叉', (t) => {
  const { seed, primary, linked } = createFixture(t);
  commitFile(primary, '仅本地.txt', '本地内容\n', '本地提交');
  commitFile(seed, '仅远端.txt', '远端内容\n', '远端提交');
  git(seed, 'push', 'origin', 'main');

  const result = runBaseline(linked, 'diagnose', '--json');

  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.developmentIntegration.relation, 'diverged');
  assert.equal(report.developmentIntegration.ahead, 1);
  assert.equal(report.developmentIntegration.behind, 1);
  assert.deepEqual(report.developmentIntegration.divergence, {
    kind: 'ordinary',
    evidence: 'different-trees',
  });
  assert.ok(report.statuses.includes('main-diverged'));
  assert.ok(report.statuses.includes('main-divergence-ordinary'));
});

test('相同最终树的不同历史只提示可能存在 squash 纳入', (t) => {
  const { seed, primary, linked } = createFixture(t);
  commitFile(primary, 'tracked.txt', '第一步\n', '本地第一步');
  const localSha = commitFile(primary, 'tracked.txt', '相同最终内容\n', '本地第二步');
  git(linked, 'switch', '--detach', localSha);
  const squashSha = commitFile(seed, 'tracked.txt', '相同最终内容\n', '远端 squash 结果');
  commitFile(seed, 'squash 后新增.txt', '远端继续前进\n', '远端后续提交');
  git(seed, 'push', 'origin', 'main');

  const jsonResult = runBaseline(linked, 'diagnose', '--json');

  assert.equal(jsonResult.status, 0, jsonResult.stderr);
  const report = JSON.parse(jsonResult.stdout);
  assert.equal(report.developmentIntegration.relation, 'diverged');
  assert.equal(report.developmentIntegration.ahead, 2);
  assert.equal(report.developmentIntegration.behind, 2);
  assert.deepEqual(report.developmentIntegration.divergence, {
    kind: 'possible-squash',
    evidence: 'matching-local-change-set',
    matchedRemoteSha: squashSha,
  });
  assert.ok(report.statuses.includes('main-divergence-possible-squash'));
  assert.ok(report.conclusions.some((message) => message.includes('可能已通过 squash 等方式纳入')));
  assert.equal(report.current.detached, true);
  assert.equal(report.current.relationshipToRemote.relation, 'diverged');
  assert.equal(report.current.relationshipToRemote.ahead, 2);
  assert.equal(report.current.relationshipToRemote.behind, 2);
  assert.match(report.current.relationshipToRemote.mergeBase, /^[0-9a-f]{40}$/);
  assert.deepEqual(report.current.relationshipToRemote.divergence, {
    kind: 'possible-squash',
    evidence: 'matching-local-change-set',
    matchedRemoteSha: squashSha,
  });
  assert.deepEqual(report.workingTree, { staged: [], unstaged: [], untracked: [] });
  assert.ok(report.conclusions.some((message) => message.includes('分支差异不是未提交修改')));

  const humanResult = runBaseline(linked, 'diagnose');
  assert.equal(humanResult.status, 0, humanResult.stderr);
  assert.match(humanResult.stdout, /可能已通过 squash 等方式纳入/);
  assert.doesNotMatch(humanResult.stdout, /创建.*PR|pull request/i);
});

test('远端不可用时输出缓存事实并以非零状态声明无法确认最新基线', (t) => {
  const { root, primary, linked } = createFixture(t);
  write(linked, '.superpowers/cache.bin', Buffer.from([0, 1, 2, 255]));
  const refsBefore = git(
    linked,
    'for-each-ref',
    '--format=%(refname):%(objectname)',
    'refs/heads',
    'refs/remotes',
    'refs/tags',
  );
  const indexBefore = runGit(linked, ['ls-files', '--stage', '-z']).stdout;
  const statusBefore = runGit(linked, [
    'status',
    '--porcelain=v2',
    '-z',
    '--untracked-files=all',
  ]).stdout;
  const trackedBefore = readFileSync(path.join(linked, 'tracked.txt'));
  const untrackedBefore = readFileSync(path.join(linked, '.superpowers/cache.bin'));
  git(primary, 'remote', 'set-url', 'origin', path.join(root, '不存在的远端.git'));

  const result = runBaseline(linked, 'diagnose', '--json');

  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stderr, '');
  const report = JSON.parse(result.stdout);
  assert.equal(report.exitCode, 1);
  assert.equal(report.remoteBaseline.branch, 'main');
  assert.equal(report.remoteBaseline.refresh.status, 'failed');
  assert.equal(report.remoteBaseline.refresh.latest, false);
  assert.match(report.remoteBaseline.refresh.reason, /无法|不存在|does not appear|not a git repository/i);
  assert.ok(report.statuses.includes('remote-baseline-unconfirmed'));
  assert.ok(report.conclusions.some((message) => message.includes('无法确认最新远端基线')));
  assert.equal(report.developmentIntegration.relation, 'in-sync');

  assert.equal(
    git(
      linked,
      'for-each-ref',
      '--format=%(refname):%(objectname)',
      'refs/heads',
      'refs/remotes',
      'refs/tags',
    ),
    refsBefore,
  );
  assert.equal(runGit(linked, ['ls-files', '--stage', '-z']).stdout, indexBefore);
  assert.equal(
    runGit(linked, ['status', '--porcelain=v2', '-z', '--untracked-files=all']).stdout,
    statusBefore,
  );
  assert.deepEqual(readFileSync(path.join(linked, 'tracked.txt')), trackedBefore);
  assert.deepEqual(readFileSync(path.join(linked, '.superpowers/cache.bin')), untrackedBefore);
});

test('在线诊断只刷新远端跟踪引用并报告本地 main 落后', (t) => {
  const { seed, origin, primary, linked } = createFixture(t);
  write(linked, '.superpowers/online.bin', Buffer.from([9, 8, 7, 0]));
  const cachedSha = git(linked, 'rev-parse', 'refs/remotes/origin/main');
  const remoteSha = commitFile(seed, '远端新增.txt', '远端前移\n', '远端前移');
  git(seed, 'push', 'origin', 'main');
  const localHeadsBefore = git(
    linked,
    'for-each-ref',
    '--format=%(refname):%(objectname)',
    'refs/heads',
    'refs/tags',
  );
  const remoteBareBefore = git(
    origin,
    'for-each-ref',
    '--format=%(refname):%(objectname)',
  );
  const worktreesBefore = runGit(linked, ['worktree', 'list', '--porcelain', '-z']).stdout;
  const indexBefore = runGit(linked, ['ls-files', '--stage', '-z']).stdout;
  const statusBefore = runGit(linked, [
    'status',
    '--porcelain=v2',
    '-z',
    '--untracked-files=all',
  ]).stdout;
  const trackedBefore = readFileSync(path.join(linked, 'tracked.txt'));
  const untrackedBefore = readFileSync(path.join(linked, '.superpowers/online.bin'));
  const primaryHeadBefore = git(primary, 'rev-parse', 'HEAD');
  const linkedHeadBefore = git(linked, 'rev-parse', 'HEAD');

  const result = runBaseline(linked, 'diagnose', '--json');

  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.remoteBaseline.refresh, {
    status: 'refreshed',
    latest: true,
    previousSha: cachedSha,
    updated: true,
  });
  assert.equal(report.remoteBaseline.sha, remoteSha);
  assert.equal(report.developmentIntegration.relation, 'behind');
  assert.equal(report.developmentIntegration.ahead, 0);
  assert.equal(report.developmentIntegration.behind, 1);
  assert.ok(report.statuses.includes('main-behind'));
  assert.ok(report.conclusions.some((message) => message.includes('落后 origin/main 1 个提交')));

  assert.equal(
    git(
      linked,
      'for-each-ref',
      '--format=%(refname):%(objectname)',
      'refs/heads',
      'refs/tags',
    ),
    localHeadsBefore,
  );
  assert.equal(
    git(origin, 'for-each-ref', '--format=%(refname):%(objectname)'),
    remoteBareBefore,
  );
  assert.equal(runGit(linked, ['worktree', 'list', '--porcelain', '-z']).stdout, worktreesBefore);
  assert.equal(runGit(linked, ['ls-files', '--stage', '-z']).stdout, indexBefore);
  assert.equal(
    runGit(linked, ['status', '--porcelain=v2', '-z', '--untracked-files=all']).stdout,
    statusBefore,
  );
  assert.equal(git(primary, 'rev-parse', 'HEAD'), primaryHeadBefore);
  assert.equal(git(linked, 'rev-parse', 'HEAD'), linkedHeadBefore);
  assert.deepEqual(readFileSync(path.join(linked, 'tracked.txt')), trackedBefore);
  assert.deepEqual(readFileSync(path.join(linked, '.superpowers/online.bin')), untrackedBefore);
});

test('本地 main 单独前进时报告领先且保留完整引用身份', (t) => {
  const { primary, linked } = createFixture(t);
  const localSha = commitFile(primary, '本地新增.txt', '只在本地\n', '本地 main 前移');
  const linkedSha = git(linked, 'rev-parse', 'HEAD');

  const result = runBaseline(linked, 'diagnose', '--json');

  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.current.head, linkedSha);
  assert.equal(report.developmentIntegration.localRef, 'refs/heads/main');
  assert.equal(report.developmentIntegration.remoteRef, 'refs/remotes/origin/main');
  assert.equal(report.developmentIntegration.localSha, localSha);
  assert.equal(report.developmentIntegration.relation, 'ahead');
  assert.equal(report.developmentIntegration.ahead, 1);
  assert.equal(report.developmentIntegration.behind, 0);
  assert.ok(report.statuses.includes('main-ahead'));
  assert.ok(report.conclusions.some((message) => message.includes('领先 origin/main 1 个提交')));
});

test('显式离线诊断只读缓存且不把缓存伪装成最新远端状态', (t) => {
  const { root, primary, linked } = createFixture(t);
  const cachedSha = git(linked, 'rev-parse', 'refs/remotes/origin/main');
  git(primary, 'remote', 'set-url', 'origin', path.join(root, '离线时不得访问.git'));

  const result = runBaseline(linked, 'diagnose', '--offline', '--json');

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const report = JSON.parse(result.stdout);
  assert.equal(report.exitCode, 0);
  assert.equal(report.remoteBaseline.sha, cachedSha);
  assert.deepEqual(report.remoteBaseline.refresh, {
    status: 'skipped',
    latest: false,
    previousSha: cachedSha,
    updated: false,
    reason: 'offline-requested',
  });
  assert.ok(report.statuses.includes('remote-baseline-cached'));
  assert.ok(report.conclusions.some((message) => message.includes('离线')));
  assert.ok(report.conclusions.some((message) => message.includes('未确认最新远端基线')));
});

test('非法命令在 JSON 模式返回稳定错误文档和退出码 2', (t) => {
  const { linked } = createFixture(t);

  const result = runBaseline(linked, '未知命令', '--json');

  assert.equal(result.status, 2);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), {
    schemaVersion: 1,
    command: '未知命令',
    exitCode: 2,
    statuses: ['invalid-arguments'],
    error: {
      kind: 'invalid-arguments',
      message: '用法：node scripts/worktree-baseline.mjs diagnose [--json] [--offline]',
    },
  });
});

test('从远端符号引用识别 master 并因不符合 main 契约而告警', (t) => {
  const { linked } = createFixture(t, { defaultBranch: 'master' });

  const result = runBaseline(linked, 'diagnose', '--json');

  assert.equal(result.status, 1, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.exitCode, 1);
  assert.equal(report.remoteBaseline.branch, 'master');
  assert.equal(report.remoteBaseline.expectedBranch, 'main');
  assert.equal(report.remoteBaseline.refresh.status, 'refreshed');
  assert.ok(report.statuses.includes('remote-default-branch-unexpected'));
  assert.ok(report.conclusions.some((message) => message.includes('实际默认分支为 master')));
  assert.ok(report.conclusions.some((message) => message.includes('开发集成分支必须为 main')));
});

test('远端默认分支和本地缓存均缺失时拒绝猜测', (t) => {
  const { origin, linked } = createFixture(t);
  git(origin, 'symbolic-ref', 'HEAD', 'refs/heads/不存在');
  git(linked, 'symbolic-ref', '--delete', 'refs/remotes/origin/HEAD');

  const result = runBaseline(linked, 'diagnose', '--json');

  assert.equal(result.status, 2);
  assert.equal(result.stderr, '');
  const report = JSON.parse(result.stdout);
  assert.equal(report.exitCode, 2);
  assert.deepEqual(report.statuses, ['diagnosis-failed']);
  assert.equal(report.error.kind, 'diagnosis-failed');
  assert.match(report.error.message, /无法安全判断远端默认分支/);
  assert.doesNotMatch(report.error.message, /假定|猜测.*(?:main|master)/);
});

test('为所有旧 detached worktree 报告远端关系和只读用途', (t) => {
  const { root, seed, primary, linked } = createFixture(t);
  const oldReviewPath = path.join(root, '旧 detached\n审查');
  git(primary, 'worktree', 'add', '--detach', oldReviewPath, 'origin/main');
  const normalizedOldReviewPath = realpathSync.native(oldReviewPath);
  commitFile(seed, '远端后续.txt', '新内容\n', '远端继续前进');
  git(seed, 'push', 'origin', 'main');

  const result = runBaseline(linked, 'diagnose', '--json');

  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  const oldReview = report.worktrees.find((item) => item.path === normalizedOldReviewPath);
  assert.ok(oldReview);
  assert.equal(oldReview.detached, true);
  assert.equal(oldReview.suitability, 'read-only');
  assert.equal(oldReview.relationshipToRemote.relation, 'behind');
  assert.equal(oldReview.relationshipToRemote.ahead, 0);
  assert.equal(oldReview.relationshipToRemote.behind, 1);
  assert.ok(report.statuses.includes('linked-worktree-read-only'));
  assert.ok(
    report.conclusions.some(
      (message) => message.includes(normalizedOldReviewPath) && message.includes('只读审查'),
    ),
  );
});

test('识别缺少工具元数据的人工 recovery 为 legacy/unverified', (t) => {
  const { primary, linked } = createFixture(t);
  const legacyBranch = 'codex/local-main-recovery-20260827';
  git(primary, 'branch', legacyBranch, 'main');
  const legacySha = git(primary, 'rev-parse', `refs/heads/${legacyBranch}`);

  const result = runBaseline(linked, 'diagnose', '--offline', '--json');

  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.recoveryRecords, [{
    branch: legacyBranch,
    ref: `refs/heads/${legacyBranch}`,
    head: legacySha,
    verification: 'legacy-unverified',
    planId: null,
  }]);
  assert.ok(report.statuses.includes('recovery-records-present'));
  assert.ok(report.statuses.includes('recovery-legacy-unverified'));
  assert.ok(
    report.conclusions.some(
      (message) => message.includes(legacyBranch) && message.includes('legacy/unverified'),
    ),
  );
});

test('本地 main 缺失时报告无法安全判断并以非零状态结束', (t) => {
  const { primary, linked } = createFixture(t);
  git(primary, 'switch', '-c', 'codex/主目录临时分支');
  git(primary, 'branch', '-D', 'main');

  const result = runBaseline(linked, 'diagnose', '--json');

  assert.equal(result.status, 1, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.exitCode, 1);
  assert.equal(report.developmentIntegration.localSha, null);
  assert.equal(report.developmentIntegration.relation, 'unknown');
  assert.ok(report.statuses.includes('main-missing'));
  assert.ok(report.statuses.includes('unable-to-determine'));
  assert.ok(report.conclusions.some((message) => message.includes('本地 main 不存在')));
});
