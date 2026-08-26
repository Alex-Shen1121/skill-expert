import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  chmodSync,
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
    shell: false,
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

function commitFile(repository, relativePath, contents, message) {
  write(repository, relativePath, contents);
  git(repository, 'add', '--', relativePath);
  git(repository, 'commit', '-m', message);
  return git(repository, 'rev-parse', 'HEAD');
}

function fileHash(repository, relativePath) {
  return createHash('sha256')
    .update(readFileSync(path.join(repository, relativePath)))
    .digest('hex');
}

function createFixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'skill-expert-recovery-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const seed = path.join(root, '远端种子');
  const origin = path.join(root, 'origin.git');
  const primary = path.join(root, '主工作目录');
  const linked = path.join(root, 'linked worktree');

  mkdirSync(seed);
  git(seed, 'init', '-b', 'main');
  git(seed, 'config', 'user.name', '恢复测试');
  git(seed, 'config', 'user.email', 'recovery@example.com');
  write(seed, 'tracked.txt', '初始内容\n');
  git(seed, 'add', 'tracked.txt');
  git(seed, 'commit', '-m', '建立远端基线');
  git(root, 'init', '--bare', '--initial-branch=main', origin);
  git(seed, 'remote', 'add', 'origin', origin);
  git(seed, 'push', '-u', 'origin', 'main');

  git(root, 'clone', origin, primary);
  git(primary, 'config', 'user.name', '恢复测试');
  git(primary, 'config', 'user.email', 'recovery@example.com');
  git(primary, 'worktree', 'add', '-b', 'codex/恢复调用', linked, 'origin/main');

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
    shell: false,
  });
}

test('默认 recovery 只生成绑定仓库事实的计划', (t) => {
  const { origin, primary, linked } = createFixture(t);
  const mainBefore = git(primary, 'rev-parse', 'refs/heads/main');
  const headsBefore = git(primary, 'for-each-ref', '--format=%(refname):%(objectname)', 'refs/heads');
  const remoteBefore = git(origin, 'for-each-ref', '--format=%(refname):%(objectname)');

  const result = runBaseline(linked, 'recovery', '--json');

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stderr, '');
  const report = JSON.parse(result.stdout);
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.command, 'recovery');
  assert.equal(report.exitCode, 0);
  assert.deepEqual(report.statuses, ['recovery-planned']);
  assert.equal(report.applied, false);
  assert.match(report.plan.id, /^[0-9a-f]{64}$/);
  assert.equal(report.plan.primaryWorktree, primary);
  assert.match(report.plan.commonDir, /[\\/].git$/);
  assert.equal(report.plan.oldMainSha, mainBefore);
  assert.equal(report.plan.targetRemoteSha, mainBefore);
  assert.equal(report.plan.remoteRef, 'refs/remotes/origin/main');
  assert.match(report.plan.recoveryBranch, /^codex\/local-main-recovery-\d{8}$/);
  assert.deepEqual(report.plan.trackedChanges, { staged: [], unstaged: [], paths: [] });
  assert.deepEqual(report.plan.untrackedPaths, []);
  assert.match(report.plan.snapshotLimitation, /不保留.*已暂存.*未暂存.*分界/);
  assert.equal(git(primary, 'rev-parse', 'refs/heads/main'), mainBefore);
  assert.equal(git(primary, 'branch', '--show-current'), 'main');
  assert.equal(
    git(primary, 'for-each-ref', '--format=%(refname):%(objectname)', 'refs/heads'),
    headsBefore,
  );
  assert.equal(git(origin, 'for-each-ref', '--format=%(refname):%(objectname)'), remoteBefore);
});

test('显式确认计划后创建无 upstream 的本地恢复点且不移动 main', (t) => {
  const { origin, primary, linked } = createFixture(t);
  const planResult = runBaseline(linked, 'recovery', '--json');
  assert.equal(planResult.status, 0, planResult.stderr);
  const plan = JSON.parse(planResult.stdout).plan;
  const mainBefore = git(primary, 'rev-parse', 'refs/heads/main');
  const remoteBefore = git(origin, 'for-each-ref', '--format=%(refname):%(objectname)');

  const result = runBaseline(
    linked,
    'recovery',
    '--apply',
    '--confirm',
    plan.id,
    '--primary-worktree',
    primary,
    '--json',
  );

  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.exitCode, 0);
  assert.deepEqual(report.statuses, ['recovery-created']);
  assert.equal(report.applied, true);
  assert.equal(report.plan.id, plan.id);
  assert.equal(report.result.recoveryBranch, plan.recoveryBranch);
  assert.equal(report.result.snapshotCommitSha, null);
  assert.equal(report.result.recoveryHeadSha, mainBefore);
  assert.equal(git(primary, 'branch', '--show-current'), plan.recoveryBranch);
  assert.equal(git(primary, 'rev-parse', 'refs/heads/main'), mainBefore);
  assert.equal(git(primary, 'rev-parse', `refs/heads/${plan.recoveryBranch}`), mainBefore);
  assert.notEqual(
    runGit(primary, ['rev-parse', '--abbrev-ref', `${plan.recoveryBranch}@{upstream}`], {
      allowFailure: true,
    }).status,
    0,
  );
  assert.match(report.result.metadataPath, /skill-expert-recovery/);
  const metadata = JSON.parse(readFileSync(report.result.metadataPath, 'utf8'));
  assert.equal(metadata.schemaVersion, 1);
  assert.equal(metadata.planId, plan.id);
  assert.equal(metadata.recoveryBranch, plan.recoveryBranch);
  assert.equal(metadata.oldMainSha, mainBefore);
  assert.equal(metadata.targetRemoteSha, plan.targetRemoteSha);
  assert.equal(metadata.snapshotCommitSha, null);
  assert.equal(metadata.recoveryHeadSha, mainBefore);
  assert.match(metadata.integrity, /^[0-9a-f]{64}$/);
  assert.equal(git(origin, 'for-each-ref', '--format=%(refname):%(objectname)'), remoteBefore);
});

test('缺少计划确认值时安全阻止显式执行且不创建恢复分支', (t) => {
  const { origin, primary, linked } = createFixture(t);
  const mainBefore = git(primary, 'rev-parse', 'refs/heads/main');
  const headsBefore = git(primary, 'for-each-ref', '--format=%(refname):%(objectname)', 'refs/heads');
  const remoteBefore = git(origin, 'for-each-ref', '--format=%(refname):%(objectname)');

  const result = runBaseline(
    linked,
    'recovery',
    '--apply',
    '--primary-worktree',
    primary,
    '--json',
  );

  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stderr, '');
  const report = JSON.parse(result.stdout);
  assert.equal(report.exitCode, 1);
  assert.deepEqual(report.statuses, ['recovery-blocked']);
  assert.equal(report.error.kind, 'recovery-blocked');
  assert.match(report.error.message, /确认值.*不匹配/);
  assert.equal(git(primary, 'rev-parse', 'refs/heads/main'), mainBefore);
  assert.equal(git(primary, 'branch', '--show-current'), 'main');
  assert.equal(
    git(primary, 'for-each-ref', '--format=%(refname):%(objectname)', 'refs/heads'),
    headsBefore,
  );
  assert.equal(git(origin, 'for-each-ref', '--format=%(refname):%(objectname)'), remoteBefore);
});

test('快照提交保存 tracked 最终内容并保持所有 untracked 字节不变', (t) => {
  const { origin, primary, linked } = createFixture(t);
  write(primary, '待删除.txt', '删除前\n');
  write(primary, '待重命名.txt', '重命名前\n');
  write(primary, '换行\n路径.txt', '换行路径初始内容\n');
  git(primary, 'add', '--', '待删除.txt', '待重命名.txt', '换行\n路径.txt');
  git(primary, 'commit', '-m', '建立本地 main 独有历史');
  const oldMainSha = git(primary, 'rev-parse', 'HEAD');

  write(primary, 'tracked.txt', '暂存版本\n');
  git(primary, 'add', '--', 'tracked.txt');
  write(primary, 'tracked.txt', '最终版本\n');
  git(primary, 'rm', '--', '待删除.txt');
  git(primary, 'mv', '待重命名.txt', '已重命名.txt');
  write(primary, '已重命名.txt', '重命名后的最终版本\n');
  write(primary, '已暂存新增.txt', '新增暂存版本\n');
  git(primary, 'add', '--', '已暂存新增.txt');
  write(primary, '已暂存新增.txt', '新增最终版本\n');
  write(primary, '换行\n路径.txt', '换行路径最终内容\n');
  write(primary, '.superpowers/cache.bin', Buffer.from([0, 1, 2, 255]));
  write(primary, '.worktrees/nested/cache.bin', Buffer.from([8, 7, 0, 6]));
  write(primary, '普通未跟踪.bin', Buffer.from([5, 0, 4, 3]));
  const untrackedPaths = ['.superpowers/cache.bin', '.worktrees/nested/cache.bin', '普通未跟踪.bin'];
  const untrackedHashes = Object.fromEntries(
    untrackedPaths.map((relativePath) => [relativePath, fileHash(primary, relativePath)]),
  );
  const remoteBefore = git(origin, 'for-each-ref', '--format=%(refname):%(objectname)');

  const planResult = runBaseline(linked, 'recovery', '--json');
  assert.equal(planResult.status, 0, planResult.stderr);
  const plan = JSON.parse(planResult.stdout).plan;
  assert.equal(plan.oldMainSha, oldMainSha);
  assert.deepEqual(plan.trackedChanges.paths, [
    'tracked.txt',
    '已暂存新增.txt',
    '已重命名.txt',
    '待删除.txt',
    '待重命名.txt',
    '换行\n路径.txt',
  ].sort());

  const result = runBaseline(
    linked,
    'recovery',
    '--apply',
    '--confirm',
    plan.id,
    '--primary-worktree',
    primary,
    '--json',
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  const snapshotSha = report.result.snapshotCommitSha;
  assert.match(snapshotSha, /^[0-9a-f]{40}$/);
  assert.equal(report.result.recoveryHeadSha, snapshotSha);
  assert.equal(git(primary, 'rev-parse', `${snapshotSha}^`), oldMainSha);
  assert.equal(git(primary, 'show', `${snapshotSha}:tracked.txt`), '最终版本');
  assert.equal(git(primary, 'show', `${snapshotSha}:已重命名.txt`), '重命名后的最终版本');
  assert.equal(git(primary, 'show', `${snapshotSha}:已暂存新增.txt`), '新增最终版本');
  assert.equal(git(primary, 'show', `${snapshotSha}:换行\n路径.txt`), '换行路径最终内容');
  assert.notEqual(
    runGit(primary, ['cat-file', '-e', `${snapshotSha}:待删除.txt`], { allowFailure: true }).status,
    0,
  );
  assert.notEqual(
    runGit(primary, ['cat-file', '-e', `${snapshotSha}:待重命名.txt`], { allowFailure: true }).status,
    0,
  );
  for (const relativePath of untrackedPaths) {
    assert.equal(fileHash(primary, relativePath), untrackedHashes[relativePath]);
    assert.notEqual(
      runGit(primary, ['cat-file', '-e', `${snapshotSha}:${relativePath}`], { allowFailure: true }).status,
      0,
    );
  }
  assert.equal(git(primary, 'rev-parse', 'refs/heads/main'), oldMainSha);
  assert.equal(git(primary, 'status', '--porcelain', '--untracked-files=all').split(/\r?\n/).filter(Boolean).length, 3);
  const metadata = JSON.parse(readFileSync(report.result.metadataPath, 'utf8'));
  assert.equal(metadata.snapshotCommitSha, snapshotSha);
  assert.deepEqual(metadata.trackedPaths, plan.trackedChanges.paths);
  assert.equal(git(origin, 'for-each-ref', '--format=%(refname):%(objectname)'), remoteBefore);
});

test('快照提交失败后回滚临时分支并可重新计划安全重试', (t) => {
  const { root, primary, linked } = createFixture(t);
  write(primary, 'tracked.txt', '需要恢复的最终内容\n');
  write(primary, '未跟踪.bin', Buffer.from([1, 0, 2, 255]));
  const untrackedHash = fileHash(primary, '未跟踪.bin');
  const hooks = path.join(root, '拒绝提交 hooks');
  const hook = path.join(hooks, 'pre-commit');
  mkdirSync(hooks);
  writeFileSync(hook, '#!/bin/sh\necho 快照提交被测试钩子拒绝 >&2\nexit 1\n');
  chmodSync(hook, 0o755);
  git(primary, 'config', 'core.hooksPath', hooks);
  const planResult = runBaseline(linked, 'recovery', '--json');
  assert.equal(planResult.status, 0, planResult.stderr);
  const plan = JSON.parse(planResult.stdout).plan;
  const mainBefore = git(primary, 'rev-parse', 'refs/heads/main');

  const failed = runBaseline(
    linked,
    'recovery',
    '--apply',
    '--confirm',
    plan.id,
    '--primary-worktree',
    primary,
    '--json',
  );

  assert.equal(failed.status, 1, failed.stderr || failed.stdout);
  const failure = JSON.parse(failed.stdout);
  assert.deepEqual(failure.statuses, ['recovery-stopped']);
  assert.equal(failure.error.kind, 'recovery-stopped');
  assert.match(failure.error.message, /快照提交被测试钩子拒绝/);
  assert.equal(failure.error.details.mainRefSha, mainBefore);
  assert.equal(failure.error.details.primaryBranch, 'main');
  assert.equal(failure.error.details.recoveryPreserved, false);
  assert.equal(failure.error.details.retryWithSameConfirmation, false);
  assert.match(failure.error.details.guidance, /重新生成并确认恢复计划/);
  assert.equal(git(primary, 'branch', '--show-current'), 'main');
  assert.equal(git(primary, 'rev-parse', 'refs/heads/main'), mainBefore);
  assert.notEqual(
    runGit(primary, ['show-ref', '--verify', '--quiet', `refs/heads/${plan.recoveryBranch}`], {
      allowFailure: true,
    }).status,
    0,
  );
  assert.equal(readFileSync(path.join(primary, 'tracked.txt'), 'utf8'), '需要恢复的最终内容\n');
  assert.equal(fileHash(primary, '未跟踪.bin'), untrackedHash);

  rmSync(hook);
  const retryPlanResult = runBaseline(linked, 'recovery', '--json');
  assert.equal(retryPlanResult.status, 0, retryPlanResult.stderr);
  const retryPlan = JSON.parse(retryPlanResult.stdout).plan;
  assert.notEqual(retryPlan.id, plan.id);
  const retried = runBaseline(
    linked,
    'recovery',
    '--apply',
    '--confirm',
    retryPlan.id,
    '--primary-worktree',
    primary,
    '--json',
  );
  assert.equal(retried.status, 0, retried.stderr || retried.stdout);
  const result = JSON.parse(retried.stdout);
  assert.match(result.result.snapshotCommitSha, /^[0-9a-f]{40}$/);
  assert.equal(git(primary, 'rev-parse', 'refs/heads/main'), mainBefore);
  assert.equal(fileHash(primary, '未跟踪.bin'), untrackedHash);
});

test('已有同名恢复分支时选择无冲突后缀且不覆盖旧恢复点', (t) => {
  const { primary, linked } = createFixture(t);
  const initialPlanResult = runBaseline(linked, 'recovery', '--json');
  assert.equal(initialPlanResult.status, 0, initialPlanResult.stderr);
  const initialPlan = JSON.parse(initialPlanResult.stdout).plan;
  git(primary, 'branch', initialPlan.recoveryBranch, 'refs/heads/main');
  const existingRecoverySha = git(primary, 'rev-parse', `refs/heads/${initialPlan.recoveryBranch}`);

  const nextPlanResult = runBaseline(linked, 'recovery', '--json');
  assert.equal(nextPlanResult.status, 0, nextPlanResult.stderr);
  const nextPlan = JSON.parse(nextPlanResult.stdout).plan;
  assert.equal(nextPlan.recoveryBranch, `${initialPlan.recoveryBranch}-2`);
  assert.notEqual(nextPlan.id, initialPlan.id);

  const applied = runBaseline(
    linked,
    'recovery',
    '--apply',
    '--confirm',
    nextPlan.id,
    '--primary-worktree',
    primary,
    '--json',
  );

  assert.equal(applied.status, 0, applied.stderr || applied.stdout);
  assert.equal(
    git(primary, 'rev-parse', `refs/heads/${initialPlan.recoveryBranch}`),
    existingRecoverySha,
  );
  assert.equal(
    git(primary, 'rev-parse', `refs/heads/${nextPlan.recoveryBranch}`),
    nextPlan.oldMainSha,
  );
  assert.equal(git(primary, 'rev-parse', 'refs/heads/main'), nextPlan.oldMainSha);
});

test('远端目标在计划后变化时旧确认值失效且不会创建 recovery', (t) => {
  const { seed, primary, linked } = createFixture(t);
  const planResult = runBaseline(linked, 'recovery', '--json');
  assert.equal(planResult.status, 0, planResult.stderr);
  const plan = JSON.parse(planResult.stdout).plan;
  const mainBefore = git(primary, 'rev-parse', 'refs/heads/main');
  const newRemoteSha = commitFile(seed, '远端前移.txt', '计划后变化\n', '远端计划后前移');
  git(seed, 'push', 'origin', 'main');

  const applied = runBaseline(
    linked,
    'recovery',
    '--apply',
    '--confirm',
    plan.id,
    '--primary-worktree',
    primary,
    '--json',
  );

  assert.equal(applied.status, 1, applied.stderr || applied.stdout);
  const report = JSON.parse(applied.stdout);
  assert.deepEqual(report.statuses, ['recovery-blocked']);
  assert.match(report.error.message, /确认值.*不匹配/);
  assert.equal(git(primary, 'rev-parse', 'refs/heads/main'), mainBefore);
  assert.equal(git(primary, 'rev-parse', 'refs/remotes/origin/main'), newRemoteSha);
  assert.notEqual(
    runGit(primary, ['show-ref', '--verify', '--quiet', `refs/heads/${plan.recoveryBranch}`], {
      allowFailure: true,
    }).status,
    0,
  );
});

test('tracked 与 untracked 路径集合在计划后变化时旧确认值失效', (t) => {
  const { primary, linked } = createFixture(t);
  write(primary, 'tracked.txt', '计划内修改\n');
  const planResult = runBaseline(linked, 'recovery', '--json');
  assert.equal(planResult.status, 0, planResult.stderr);
  const plan = JSON.parse(planResult.stdout).plan;

  write(primary, '计划外新增.txt', '计划后才出现\n');
  git(primary, 'add', '--', '计划外新增.txt');
  write(primary, '计划外未跟踪.txt', '同样在计划后出现\n');

  const applied = runBaseline(
    linked,
    'recovery',
    '--apply',
    '--confirm',
    plan.id,
    '--primary-worktree',
    primary,
    '--json',
  );

  assert.equal(applied.status, 1, applied.stderr || applied.stdout);
  const report = JSON.parse(applied.stdout);
  assert.deepEqual(report.statuses, ['recovery-blocked']);
  assert.match(report.error.message, /确认值.*不匹配/);
  assert.equal(git(primary, 'branch', '--show-current'), 'main');
  assert.notEqual(
    runGit(primary, ['show-ref', '--verify', '--quiet', `refs/heads/${plan.recoveryBranch}`], {
      allowFailure: true,
    }).status,
    0,
  );
});

test('人类计划明确展示确认值、目标 SHA 和三类文件路径', (t) => {
  const { primary, linked } = createFixture(t);
  write(primary, 'tracked.txt', '已暂存版本\n');
  git(primary, 'add', '--', 'tracked.txt');
  write(primary, 'tracked.txt', '未暂存最终版本\n');
  write(primary, '未跟踪说明.txt', '不得纳入快照\n');
  const mainSha = git(primary, 'rev-parse', 'refs/heads/main');

  const result = runBaseline(linked, 'recovery');

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /计划确认值：[0-9a-f]{64}/);
  assert.match(result.stdout, new RegExp(`原本地 main：${mainSha}`));
  assert.match(result.stdout, new RegExp(`目标 origin/main：${mainSha}`));
  assert.match(result.stdout, /已暂存路径：\n- tracked\.txt/);
  assert.match(result.stdout, /未暂存路径：\n- tracked\.txt/);
  assert.match(result.stdout, /未跟踪路径：\n- 未跟踪说明\.txt/);
  assert.match(result.stdout, /不保留.*已暂存.*未暂存.*分界/);
});

test('recovery 非法参数返回本命令的稳定中文用法', (t) => {
  const { linked } = createFixture(t);

  const result = runBaseline(linked, 'recovery', '--apply', '--未知参数', '--json');

  assert.equal(result.status, 2);
  assert.equal(result.stderr, '');
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.statuses, ['invalid-arguments']);
  assert.equal(report.error.kind, 'invalid-arguments');
  assert.equal(
    report.error.message,
    '用法：node scripts/worktree-baseline.mjs recovery [--json] [--apply --confirm <计划确认值> --primary-worktree <路径>]',
  );
});

test('已有同计划元数据时拒绝覆盖并回滚未提交的临时恢复分支', (t) => {
  const { primary, linked } = createFixture(t);
  const planResult = runBaseline(linked, 'recovery', '--json');
  assert.equal(planResult.status, 0, planResult.stderr);
  const plan = JSON.parse(planResult.stdout).plan;
  const metadataDirectory = path.join(plan.commonDir, 'skill-expert-recovery');
  const metadataPath = path.join(metadataDirectory, `${plan.id}.json`);
  mkdirSync(metadataDirectory);
  writeFileSync(metadataPath, '不得覆盖的旧记录\n');

  const result = runBaseline(
    linked,
    'recovery',
    '--apply',
    '--confirm',
    plan.id,
    '--primary-worktree',
    primary,
    '--json',
  );

  assert.equal(result.status, 1, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.statuses, ['recovery-stopped']);
  assert.equal(report.error.details.stage, 'metadata-write');
  assert.equal(report.error.details.primaryBranch, 'main');
  assert.equal(report.error.details.recoveryPreserved, false);
  assert.equal(report.error.details.retryWithSameConfirmation, true);
  assert.equal(readFileSync(metadataPath, 'utf8'), '不得覆盖的旧记录\n');
  assert.equal(git(primary, 'branch', '--show-current'), 'main');
  assert.notEqual(
    runGit(primary, ['show-ref', '--verify', '--quiet', `refs/heads/${plan.recoveryBranch}`], {
      allowFailure: true,
    }).status,
    0,
  );
});
