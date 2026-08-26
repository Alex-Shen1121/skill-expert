import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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

function refs(repository, prefix = '') {
  return git(
    repository,
    'for-each-ref',
    '--format=%(refname):%(objectname)',
    ...(prefix ? [prefix] : []),
  );
}

function createFixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'skill-expert-sync-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const seed = path.join(root, '远端种子');
  const origin = path.join(root, 'origin.git');
  const primary = path.join(root, '主工作目录');
  const linked = path.join(root, 'linked worktree');
  const detached = path.join(root, '旧 detached worktree');

  mkdirSync(seed);
  git(seed, 'init', '-b', 'main');
  git(seed, 'config', 'user.name', '同步测试');
  git(seed, 'config', 'user.email', 'sync@example.com');
  write(seed, 'tracked.txt', '初始内容\n');
  write(seed, '.gitignore', '.worktrees/\n');
  git(seed, 'add', 'tracked.txt', '.gitignore');
  git(seed, 'commit', '-m', '建立远端基线');
  git(root, 'init', '--bare', '--initial-branch=main', origin);
  git(seed, 'remote', 'add', 'origin', origin);
  git(seed, 'push', '-u', 'origin', 'main');

  git(root, 'clone', origin, primary);
  git(primary, 'config', 'user.name', '同步测试');
  git(primary, 'config', 'user.email', 'sync@example.com');
  git(primary, 'branch', 'release', 'origin/main');
  git(primary, 'tag', 'v-test-before-sync', 'origin/main');
  git(primary, 'worktree', 'add', '-b', 'codex/同步调用', linked, 'origin/main');

  commitFile(primary, 'tracked.txt', '本地第一步\n', '本地第一步');
  const oldMainSha = commitFile(
    primary,
    'tracked.txt',
    '相同最终内容\n',
    '本地第二步',
  );
  git(primary, 'worktree', 'add', '--detach', detached, oldMainSha);

  const squashSha = commitFile(seed, 'tracked.txt', '相同最终内容\n', '远端 squash 结果');
  const targetSha = commitFile(seed, '远端后续.txt', '远端继续前进\n', '远端后续提交');
  git(seed, 'push', 'origin', 'main');

  write(primary, '.superpowers/cache.bin', Buffer.from([0, 1, 2, 255]));
  write(primary, '.worktrees/nested/cache.bin', Buffer.from([8, 7, 0, 6]));
  write(primary, '普通未跟踪.bin', Buffer.from([5, 0, 4, 3]));

  return {
    root,
    seed,
    origin,
    primary: realpathSync.native(primary),
    linked: realpathSync.native(linked),
    detached: realpathSync.native(detached),
    oldMainSha,
    squashSha,
    targetSha,
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

function createRecovery(linked, primary) {
  const planned = runBaseline(linked, 'recovery', '--json');
  assert.equal(planned.status, 0, planned.stderr || planned.stdout);
  const plan = JSON.parse(planned.stdout).plan;
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
  assert.equal(applied.status, 0, applied.stderr || applied.stdout);
  return JSON.parse(applied.stdout);
}

test('从 linked worktree 验证 recovery 后事务性同步分叉的本地 main', (t) => {
  const {
    origin,
    primary,
    linked,
    detached,
    oldMainSha,
    targetSha,
  } = createFixture(t);
  const recovery = createRecovery(linked, primary);
  const untrackedPaths = [
    '.superpowers/cache.bin',
    '.worktrees/nested/cache.bin',
    '普通未跟踪.bin',
  ];
  const untrackedHashes = Object.fromEntries(
    untrackedPaths.map((relativePath) => [relativePath, fileHash(primary, relativePath)]),
  );
  const detachedHeadBefore = git(detached, 'rev-parse', 'HEAD');
  const linkedHeadBefore = git(linked, 'rev-parse', 'HEAD');
  const releaseBefore = git(primary, 'rev-parse', 'refs/heads/release');
  const tagsBefore = refs(primary, 'refs/tags');
  const remoteTrackingBefore = refs(primary, 'refs/remotes');
  const bareRemoteBefore = refs(origin);
  const divergedDiffBefore = git(
    primary,
    'diff',
    '--shortstat',
    'refs/heads/main...refs/remotes/origin/main',
  );
  assert.notEqual(divergedDiffBefore, '');
  assert.equal(git(primary, 'rev-parse', 'refs/heads/main'), oldMainSha);
  assert.equal(git(primary, 'branch', '--show-current'), recovery.result.recoveryBranch);

  const result = runBaseline(
    linked,
    'sync',
    '--apply',
    '--confirm',
    recovery.plan.id,
    '--primary-worktree',
    primary,
    '--json',
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stderr, '');
  const report = JSON.parse(result.stdout);
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.command, 'sync');
  assert.equal(report.exitCode, 0);
  assert.deepEqual(report.statuses, ['sync-completed']);
  assert.equal(report.result.stage, 'verified');
  assert.equal(report.result.mainSha, targetSha);
  assert.equal(report.result.remoteSha, targetSha);
  assert.equal(report.result.ahead, 0);
  assert.equal(report.result.behind, 0);
  assert.equal(report.result.upstream, 'origin/main');
  assert.equal(report.result.recoveryBranch, recovery.result.recoveryBranch);
  assert.equal(report.result.recoveryHeadSha, recovery.result.recoveryHeadSha);
  assert.deepEqual(report.result.verifiedUntrackedPaths, [
    '.superpowers/cache.bin',
    '.worktrees/nested/cache.bin',
    '普通未跟踪.bin',
  ].sort());
  assert.equal(git(primary, 'branch', '--show-current'), 'main');
  assert.equal(git(primary, 'rev-parse', 'HEAD'), targetSha);
  assert.equal(git(primary, 'rev-parse', 'refs/heads/main'), targetSha);
  assert.equal(git(primary, 'rev-parse', 'refs/remotes/origin/main'), targetSha);
  assert.equal(git(primary, 'rev-list', '--left-right', '--count', 'main...origin/main'), '0\t0');
  assert.equal(git(primary, 'rev-parse', '--abbrev-ref', 'main@{upstream}'), 'origin/main');
  assert.equal(git(primary, 'diff', '--shortstat', 'main...origin/main'), '');
  assert.equal(
    git(primary, 'rev-parse', `refs/heads/${recovery.result.recoveryBranch}`),
    recovery.result.recoveryHeadSha,
  );
  assert.notEqual(
    runGit(primary, ['rev-parse', '--abbrev-ref', `${recovery.result.recoveryBranch}@{upstream}`], {
      allowFailure: true,
    }).status,
    0,
  );
  assert.equal(git(detached, 'rev-parse', 'HEAD'), detachedHeadBefore);
  assert.equal(git(detached, 'branch', '--show-current'), '');
  assert.equal(git(linked, 'rev-parse', 'HEAD'), linkedHeadBefore);
  assert.equal(git(linked, 'branch', '--show-current'), 'codex/同步调用');
  for (const relativePath of untrackedPaths) {
    assert.equal(fileHash(primary, relativePath), untrackedHashes[relativePath]);
  }
  assert.equal(git(primary, 'rev-parse', 'refs/heads/release'), releaseBefore);
  assert.equal(refs(primary, 'refs/tags'), tagsBefore);
  assert.equal(refs(primary, 'refs/remotes'), remoteTrackingBefore);
  assert.equal(refs(origin), bareRemoteBefore);
});

test('重算摘要也不能让含额外字段的伪造 recovery 元数据通过', (t) => {
  const { primary, linked, oldMainSha } = createFixture(t);
  const recovery = createRecovery(linked, primary);
  const metadataPath = recovery.result.metadataPath;
  const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
  const { integrity: _originalIntegrity, ...payload } = metadata;
  const forgedPayload = { ...payload, forgedApproval: true };
  const forgedMetadata = {
    ...forgedPayload,
    integrity: createHash('sha256').update(JSON.stringify(forgedPayload)).digest('hex'),
  };
  writeFileSync(metadataPath, `${JSON.stringify(forgedMetadata, null, 2)}\n`);

  const result = runBaseline(
    linked,
    'sync',
    '--apply',
    '--confirm',
    recovery.plan.id,
    '--primary-worktree',
    primary,
    '--json',
  );

  assert.equal(result.status, 1, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.statuses, ['sync-blocked']);
  assert.equal(report.error.kind, 'sync-blocked');
  assert.match(report.error.message, /元数据.*字段/);
  assert.equal(report.error.details.stage, 'revalidate');
  assert.equal(report.error.details.mainMoved, false);
  assert.equal(git(primary, 'rev-parse', 'refs/heads/main'), oldMainSha);
  assert.equal(git(primary, 'branch', '--show-current'), recovery.result.recoveryBranch);
});

test('即使重算元数据摘要也不能改写 recovery 计划字段', (t) => {
  const { primary, linked, oldMainSha } = createFixture(t);
  const recovery = createRecovery(linked, primary);
  const metadataPath = recovery.result.metadataPath;
  const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
  const { integrity: _originalIntegrity, ...payload } = metadata;
  const rewrittenPayload = {
    ...payload,
    snapshotLimitation: '伪造的快照语义',
  };
  const rewrittenMetadata = {
    ...rewrittenPayload,
    integrity: createHash('sha256').update(JSON.stringify(rewrittenPayload)).digest('hex'),
  };
  writeFileSync(metadataPath, `${JSON.stringify(rewrittenMetadata, null, 2)}\n`);

  const result = runBaseline(
    linked,
    'sync',
    '--apply',
    '--confirm',
    recovery.plan.id,
    '--primary-worktree',
    primary,
    '--json',
  );

  assert.equal(result.status, 1, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.statuses, ['sync-blocked']);
  assert.match(report.error.message, /recovery 计划确认值.*重算.*不匹配/);
  assert.equal(report.error.details.stage, 'revalidate');
  assert.equal(report.error.details.mainMoved, false);
  assert.equal(git(primary, 'rev-parse', 'refs/heads/main'), oldMainSha);
  assert.equal(git(primary, 'branch', '--show-current'), recovery.result.recoveryBranch);
});

test('带 tracked 快照的 recovery 同步后仍能完整取回本地最终内容', (t) => {
  const { primary, linked, targetSha } = createFixture(t);
  write(primary, 'tracked.txt', '已暂存草稿\n');
  git(primary, 'add', '--', 'tracked.txt');
  write(primary, 'tracked.txt', '需要恢复的最终内容\n');
  const recovery = createRecovery(linked, primary);
  const snapshotSha = recovery.result.snapshotCommitSha;
  assert.match(snapshotSha, /^[0-9a-f]{40}$/);

  const result = runBaseline(
    linked,
    'sync',
    '--apply',
    '--confirm',
    recovery.plan.id,
    '--primary-worktree',
    primary,
    '--json',
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(git(primary, 'rev-parse', 'HEAD'), targetSha);
  assert.equal(readFileSync(path.join(primary, 'tracked.txt'), 'utf8'), '相同最终内容\n');
  assert.equal(git(primary, 'show', `${snapshotSha}:tracked.txt`), '需要恢复的最终内容');
  assert.equal(git(primary, 'rev-parse', `${snapshotSha}^`), recovery.plan.oldMainSha);
  assert.equal(
    git(primary, 'rev-parse', `refs/heads/${recovery.result.recoveryBranch}`),
    snapshotSha,
  );
});

test('recovery 后远端目标前进时在移动 main 前停止并报告恢复入口', (t) => {
  const { seed, primary, linked, oldMainSha } = createFixture(t);
  const recovery = createRecovery(linked, primary);
  const advancedRemoteSha = commitFile(
    seed,
    '批准后前进.txt',
    '超出原批准范围\n',
    '远端在 recovery 后前进',
  );
  git(seed, 'push', 'origin', 'main');

  const result = runBaseline(
    linked,
    'sync',
    '--apply',
    '--confirm',
    recovery.plan.id,
    '--primary-worktree',
    primary,
    '--json',
  );

  assert.equal(result.status, 1, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.statuses, ['sync-blocked']);
  assert.match(report.error.message, /origin\/main.*变化.*确认范围.*失效/);
  assert.equal(report.error.details.stage, 'revalidate');
  assert.equal(report.error.details.mainMoved, false);
  assert.equal(report.error.details.expectedTargetSha, recovery.plan.targetRemoteSha);
  assert.equal(report.error.details.actualTargetSha, advancedRemoteSha);
  assert.equal(report.error.details.recoveryBranch, recovery.result.recoveryBranch);
  assert.equal(report.error.details.recoveryRefSha, recovery.result.recoveryHeadSha);
  assert.equal(report.error.details.recoveryPreserved, true);
  assert.match(report.error.details.guidance, /main 未.*移动.*恢复分支.*仍保留/);
  assert.equal(git(primary, 'rev-parse', 'refs/heads/main'), oldMainSha);
  assert.equal(git(primary, 'branch', '--show-current'), recovery.result.recoveryBranch);
  assert.equal(
    git(primary, 'rev-parse', `refs/heads/${recovery.result.recoveryBranch}`),
    recovery.result.recoveryHeadSha,
  );
});

test('recovery 后 untracked 路径集变化时不移动 main 且不改写文件', (t) => {
  const { primary, linked, oldMainSha } = createFixture(t);
  const recovery = createRecovery(linked, primary);
  write(primary, '恢复后新增.bin', Buffer.from([11, 0, 12, 255]));
  const addedHash = fileHash(primary, '恢复后新增.bin');
  const existingHash = fileHash(primary, '普通未跟踪.bin');

  const result = runBaseline(
    linked,
    'sync',
    '--apply',
    '--confirm',
    recovery.plan.id,
    '--primary-worktree',
    primary,
    '--json',
  );

  assert.equal(result.status, 1, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.statuses, ['sync-blocked']);
  assert.match(report.error.message, /untracked 路径.*发生变化/);
  assert.equal(report.error.details.stage, 'revalidate');
  assert.equal(report.error.details.mainMoved, false);
  assert.equal(report.error.details.recoveryBranch, recovery.result.recoveryBranch);
  assert.equal(report.error.details.recoveryPreserved, true);
  assert.match(report.error.details.guidance, /恢复分支.*仍保留/);
  assert.equal(git(primary, 'rev-parse', 'refs/heads/main'), oldMainSha);
  assert.equal(git(primary, 'branch', '--show-current'), recovery.result.recoveryBranch);
  assert.equal(fileHash(primary, '恢复后新增.bin'), addedHash);
  assert.equal(fileHash(primary, '普通未跟踪.bin'), existingHash);
});

test('fetch 失败时不用缓存基线放行并报告已验证 recovery', (t) => {
  const { root, primary, linked, oldMainSha } = createFixture(t);
  const recovery = createRecovery(linked, primary);
  git(primary, 'remote', 'set-url', 'origin', path.join(root, '已不存在-origin.git'));

  const result = runBaseline(
    linked,
    'sync',
    '--apply',
    '--confirm',
    recovery.plan.id,
    '--primary-worktree',
    primary,
    '--json',
  );

  assert.equal(result.status, 1, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.statuses, ['sync-blocked']);
  assert.match(report.error.message, /无法确认最新远端基线/);
  assert.equal(report.error.details.stage, 'revalidate');
  assert.equal(report.error.details.mainMoved, false);
  assert.equal(report.error.details.recoveryBranch, recovery.result.recoveryBranch);
  assert.equal(report.error.details.recoveryRefSha, recovery.result.recoveryHeadSha);
  assert.equal(report.error.details.recoveryPreserved, true);
  assert.match(report.error.details.guidance, /恢复分支.*仍保留/);
  assert.equal(git(primary, 'rev-parse', 'refs/heads/main'), oldMainSha);
  assert.equal(git(primary, 'branch', '--show-current'), recovery.result.recoveryBranch);
});

test('CAS 后切回 main 失败时人类输出报告真实阶段和 recovery 指引', (t) => {
  const { primary, linked, targetSha } = createFixture(t);
  const recovery = createRecovery(linked, primary);
  const indexPath = git(primary, 'rev-parse', '--git-path', 'index');
  const indexLockPath = `${path.isAbsolute(indexPath) ? indexPath : path.resolve(primary, indexPath)}.lock`;
  writeFileSync(indexLockPath, '模拟另一个 Git 进程占用索引\n');

  const result = runBaseline(
    linked,
    'sync',
    '--apply',
    '--confirm',
    recovery.plan.id,
    '--primary-worktree',
    primary,
  );

  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /失败阶段：switch-main/);
  assert.match(result.stderr, /main 已移动/);
  assert.match(result.stderr, new RegExp(`恢复分支 ${recovery.result.recoveryBranch}`));
  assert.match(result.stderr, new RegExp(recovery.result.recoveryHeadSha));
  assert.equal(git(primary, 'rev-parse', 'refs/heads/main'), targetSha);
  assert.equal(git(primary, 'branch', '--show-current'), recovery.result.recoveryBranch);
  assert.equal(
    git(primary, 'rev-parse', `refs/heads/${recovery.result.recoveryBranch}`),
    recovery.result.recoveryHeadSha,
  );
});

test('recovery 引用被移动时拒绝同步且不再声称恢复点已验证', (t) => {
  const { primary, linked, oldMainSha, targetSha } = createFixture(t);
  const recovery = createRecovery(linked, primary);
  git(
    primary,
    'update-ref',
    `refs/heads/${recovery.result.recoveryBranch}`,
    targetSha,
    recovery.result.recoveryHeadSha,
  );

  const result = runBaseline(
    linked,
    'sync',
    '--apply',
    '--confirm',
    recovery.plan.id,
    '--primary-worktree',
    primary,
    '--json',
  );

  assert.equal(result.status, 1, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.statuses, ['sync-blocked']);
  assert.match(report.error.message, /recovery 分支.*指向发生变化/);
  assert.equal(report.error.details.stage, 'revalidate');
  assert.equal(report.error.details.mainMoved, false);
  assert.equal(report.error.details.recoveryBranch, recovery.result.recoveryBranch);
  assert.equal(report.error.details.recoveryRefSha, targetSha);
  assert.equal(report.error.details.recoveryPreserved, false);
  assert.match(report.error.details.guidance, /recovery.*不再匹配.*人工核验/i);
  assert.doesNotMatch(report.error.details.guidance, /已验证.*仍保留/);
  assert.equal(git(primary, 'rev-parse', 'refs/heads/main'), oldMainSha);
});

test('从主工作目录调用也会切回 main 并保留 linked worktree 上下文', (t) => {
  const { primary, linked, targetSha } = createFixture(t);
  const recovery = createRecovery(linked, primary);
  const linkedHeadBefore = git(linked, 'rev-parse', 'HEAD');

  const result = runBaseline(
    primary,
    'sync',
    '--apply',
    '--confirm',
    recovery.plan.id,
    '--primary-worktree',
    primary,
    '--json',
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.statuses, ['sync-completed']);
  assert.equal(git(primary, 'branch', '--show-current'), 'main');
  assert.equal(git(primary, 'rev-parse', 'HEAD'), targetSha);
  assert.equal(git(linked, 'branch', '--show-current'), 'codex/同步调用');
  assert.equal(git(linked, 'rev-parse', 'HEAD'), linkedHeadBefore);
});

test('只有 legacy recovery 分支而没有 #52 元数据时不允许自动同步', (t) => {
  const { primary, linked, oldMainSha } = createFixture(t);
  const legacyBranch = 'codex/local-main-recovery-20260827';
  git(primary, 'switch', '--no-track', '-c', legacyBranch);
  const headsBefore = refs(primary, 'refs/heads');

  const result = runBaseline(
    linked,
    'sync',
    '--apply',
    '--confirm',
    'a'.repeat(64),
    '--primary-worktree',
    primary,
    '--json',
  );

  assert.equal(result.status, 1, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.statuses, ['sync-blocked']);
  assert.match(report.error.message, /legacy\/unverified.*不能自动同步 main/);
  assert.equal(report.error.details.stage, 'revalidate');
  assert.equal(report.error.details.mainMoved, false);
  assert.equal(git(primary, 'rev-parse', 'refs/heads/main'), oldMainSha);
  assert.equal(git(primary, 'branch', '--show-current'), legacyBranch);
  assert.equal(refs(primary, 'refs/heads'), headsBefore);
});

test('sync 缺少显式 apply 时只返回用法且不读写恢复现场', (t) => {
  const { primary, linked, oldMainSha } = createFixture(t);
  const recovery = createRecovery(linked, primary);
  const headsBefore = refs(primary, 'refs/heads');

  const result = runBaseline(
    linked,
    'sync',
    '--confirm',
    recovery.plan.id,
    '--primary-worktree',
    primary,
    '--json',
  );

  assert.equal(result.status, 2, result.stderr || result.stdout);
  assert.equal(result.stderr, '');
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.statuses, ['invalid-arguments']);
  assert.equal(report.error.kind, 'invalid-arguments');
  assert.match(report.error.message, /sync --apply --confirm/);
  assert.equal(git(primary, 'rev-parse', 'refs/heads/main'), oldMainSha);
  assert.equal(git(primary, 'branch', '--show-current'), recovery.result.recoveryBranch);
  assert.equal(refs(primary, 'refs/heads'), headsBefore);
});

test('目标 main 会覆盖 untracked 路径时在 CAS 前停止', (t) => {
  const { primary, linked, oldMainSha } = createFixture(t);
  write(primary, '远端后续.txt', '本地未跟踪内容，不得覆盖\n');
  const untrackedHash = fileHash(primary, '远端后续.txt');
  const recovery = createRecovery(linked, primary);

  const result = runBaseline(
    linked,
    'sync',
    '--apply',
    '--confirm',
    recovery.plan.id,
    '--primary-worktree',
    primary,
    '--json',
  );

  assert.equal(result.status, 1, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.statuses, ['sync-blocked']);
  assert.match(report.error.message, /untracked 路径 远端后续\.txt.*目标 main 冲突/);
  assert.equal(report.error.details.stage, 'revalidate');
  assert.equal(report.error.details.mainMoved, false);
  assert.equal(git(primary, 'rev-parse', 'refs/heads/main'), oldMainSha);
  assert.equal(fileHash(primary, '远端后续.txt'), untrackedHash);
});

test('不区分大小写的仓库会拦截仅大小写不同的 untracked 冲突', (t) => {
  const { primary, linked, oldMainSha } = createFixture(t);
  git(primary, 'config', 'core.ignoreCase', 'true');
  write(primary, '远端后续.TXT', '大小写不同但仍不得覆盖\n');
  const untrackedHash = fileHash(primary, '远端后续.TXT');
  const recovery = createRecovery(linked, primary);

  const result = runBaseline(
    linked,
    'sync',
    '--apply',
    '--confirm',
    recovery.plan.id,
    '--primary-worktree',
    primary,
    '--json',
  );

  assert.equal(result.status, 1, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.statuses, ['sync-blocked']);
  assert.match(report.error.message, /untracked 路径 远端后续\.TXT.*目标 main 冲突/);
  assert.equal(report.error.details.stage, 'revalidate');
  assert.equal(report.error.details.mainMoved, false);
  assert.equal(git(primary, 'rev-parse', 'refs/heads/main'), oldMainSha);
  assert.equal(fileHash(primary, '远端后续.TXT'), untrackedHash);
});

test('main 被新的 linked worktree 占用时拒绝绕过 Git 的分支保护', (t) => {
  const { root, primary, linked, oldMainSha } = createFixture(t);
  const recovery = createRecovery(linked, primary);
  const unexpectedMainWorktree = path.join(root, '意外 main worktree');
  git(primary, 'worktree', 'add', unexpectedMainWorktree, 'main');
  const unexpectedHead = git(unexpectedMainWorktree, 'rev-parse', 'HEAD');

  const result = runBaseline(
    linked,
    'sync',
    '--apply',
    '--confirm',
    recovery.plan.id,
    '--primary-worktree',
    primary,
    '--json',
  );

  assert.equal(result.status, 1, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.statuses, ['sync-blocked']);
  assert.match(report.error.message, /main 被其他 worktree 占用/);
  assert.equal(report.error.details.stage, 'revalidate');
  assert.equal(report.error.details.mainMoved, false);
  assert.equal(git(primary, 'rev-parse', 'refs/heads/main'), oldMainSha);
  assert.equal(git(unexpectedMainWorktree, 'branch', '--show-current'), 'main');
  assert.equal(git(unexpectedMainWorktree, 'rev-parse', 'HEAD'), unexpectedHead);
});

test('任一 linked worktree 存在进行中的 Git 操作时拒绝同步', (t) => {
  const { primary, linked, oldMainSha } = createFixture(t);
  const recovery = createRecovery(linked, primary);
  git(linked, 'merge', '--no-ff', '--no-commit', oldMainSha);
  const mergeHead = git(linked, 'rev-parse', '--verify', 'MERGE_HEAD');

  const result = runBaseline(
    linked,
    'sync',
    '--apply',
    '--confirm',
    recovery.plan.id,
    '--primary-worktree',
    primary,
    '--json',
  );

  assert.equal(result.status, 1, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.statuses, ['sync-blocked']);
  assert.match(report.error.message, /linked worktree.*进行中的 merge 操作/);
  assert.equal(report.error.details.stage, 'revalidate');
  assert.equal(report.error.details.mainMoved, false);
  assert.equal(git(primary, 'rev-parse', 'refs/heads/main'), oldMainSha);
  assert.equal(git(linked, 'rev-parse', '--verify', 'MERGE_HEAD'), mergeHead);
});
