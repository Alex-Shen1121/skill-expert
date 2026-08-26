import { createHash } from 'node:crypto';
import {
  linkSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { diagnose } from './diagnose.mjs';
import { git, runGit, withGitHooksDisabled } from './git.mjs';
import {
  captureUntrackedState,
  findOngoingOperation,
  readWorkingTreeStatus,
  repositoryPathsEqual,
  resolveCommit,
} from './safety.mjs';

const SNAPSHOT_LIMITATION = '快照保存 tracked 文件最终内容，不保留原先已暂存与未暂存内容的分界。';

function blocked(message) {
  const error = new Error(message);
  error.kind = 'recovery-blocked';
  error.exitCode = 1;
  throw error;
}

function trackedContentDigest(cwd, { cached = false } = {}) {
  return createHash('sha256').update(runGit(cwd, [
    'diff',
    ...(cached ? ['--cached'] : []),
    '--binary',
    '--full-index',
    '--no-ext-diff',
    '--no-textconv',
    '--no-renames',
    'HEAD',
    '--',
  ], { encoding: null }).stdout).digest('hex');
}

function stoppedAfterMutation(error, plan, { snapshotCommitSha, stage }) {
  const recoveryRefSha = resolveCommit(
    plan.primaryWorktree,
    `refs/heads/${plan.recoveryBranch}`,
  );
  const recoveryPreserved = recoveryRefSha !== null;
  const primaryBranchResult = runGit(
    plan.primaryWorktree,
    ['branch', '--show-current'],
    { allowFailure: true },
  );
  const stopped = new Error(error.message);
  stopped.kind = 'recovery-stopped';
  stopped.exitCode = 1;
  stopped.details = {
    stage,
    primaryWorktree: plan.primaryWorktree,
    primaryBranch: primaryBranchResult.status === 0
      ? primaryBranchResult.stdout.trim() || null
      : null,
    mainRefSha: resolveCommit(plan.primaryWorktree, 'refs/heads/main'),
    recoveryRefSha,
    recoveryPreserved,
    retryWithSameConfirmation: false,
    guidance: recoveryPreserved
      ? snapshotCommitSha === null
        ? `恢复分支 ${plan.recoveryBranch} 已保留；本地 main 未由本阶段移动。核验现场后，可手动切回 main、删除这个未完成的 recovery，再重新生成计划重试。`
        : `恢复分支 ${plan.recoveryBranch} 及快照 ${snapshotCommitSha} 已保留；本地 main 未由本阶段移动。`
      : '文件内容已保留；请重新生成并确认恢复计划后重试。',
  };
  throw stopped;
}

function dateStamp(date = new Date()) {
  const year = String(date.getFullYear()).padStart(4, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}

function refExists(cwd, ref) {
  return runGit(cwd, ['show-ref', '--verify', '--quiet', ref], { allowFailure: true }).status === 0;
}

function selectRecoveryBranch(cwd) {
  const base = `codex/local-main-recovery-${dateStamp()}`;
  let candidate = base;
  let suffix = 2;
  while (refExists(cwd, `refs/heads/${candidate}`)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

function planIdentity(plan) {
  return createHash('sha256')
    .update(JSON.stringify({
      commonDir: plan.commonDir,
      primaryWorktree: plan.primaryWorktree,
      oldMainSha: plan.oldMainSha,
      targetRemoteSha: plan.targetRemoteSha,
      remoteRef: plan.remoteRef,
      recoveryBranch: plan.recoveryBranch,
      trackedChanges: plan.trackedChanges,
      trackedContentDigest: plan.trackedContentDigest,
      untrackedPaths: plan.untrackedPaths,
      untrackedState: plan.untrackedState,
      snapshotLimitation: plan.snapshotLimitation,
    }))
    .digest('hex');
}

function writeMetadata(plan, snapshotCommitSha, recoveryHeadSha) {
  const metadataDirectory = path.join(plan.commonDir, 'skill-expert-recovery');
  mkdirSync(metadataDirectory, { recursive: true });
  const metadataPath = path.join(metadataDirectory, `${plan.id}.json`);
  const temporaryPath = `${metadataPath}.${process.pid}.tmp`;
  const payload = {
    schemaVersion: 2,
    planId: plan.id,
    createdAt: new Date().toISOString(),
    commonDir: plan.commonDir,
    primaryWorktree: plan.primaryWorktree,
    oldMainSha: plan.oldMainSha,
    targetRemoteSha: plan.targetRemoteSha,
    remoteRef: plan.remoteRef,
    recoveryBranch: plan.recoveryBranch,
    recoveryRef: `refs/heads/${plan.recoveryBranch}`,
    snapshotCommitSha,
    recoveryHeadSha,
    trackedPaths: plan.trackedChanges.paths,
    trackedContentDigest: plan.trackedContentDigest,
    stagedBefore: plan.trackedChanges.staged,
    unstagedBefore: plan.trackedChanges.unstaged,
    untrackedBefore: plan.untrackedPaths,
    untrackedStateBefore: plan.untrackedState,
    snapshotLimitation: plan.snapshotLimitation,
  };
  const metadata = {
    ...payload,
    integrity: createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
  };
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(metadata, null, 2)}\n`, { flag: 'wx' });
    linkSync(temporaryPath, metadataPath);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
  return metadataPath;
}

function createPlan(cwd) {
  const diagnosis = diagnose(cwd);
  if (!diagnosis.remoteBaseline.refresh.latest) {
    blocked('无法确认最新远端基线，已安全停止且未创建 recovery。');
  }
  if (diagnosis.remoteBaseline.branch !== 'main') {
    blocked('远端默认分支不是 main，已安全停止且未创建 recovery。');
  }
  const mainOwners = diagnosis.worktrees.filter((worktree) => worktree.branch === 'main');
  if (
    mainOwners.length !== 1 ||
    !repositoryPathsEqual(
      diagnosis.repository.primaryWorktree,
      mainOwners[0].path,
      diagnosis.repository.primaryWorktree,
    )
  ) {
    blocked('无法唯一确认由主工作目录持有 main，已安全停止且未创建 recovery。');
  }
  const primary = diagnosis.repository.primaryWorktree;
  const ongoingOperation = findOngoingOperation(primary);
  if (ongoingOperation) {
    blocked(`${ongoingOperation} 操作进行中，已安全停止且未创建 recovery。`);
  }
  const status = readWorkingTreeStatus(primary);
  const untrackedState = captureUntrackedState(primary);
  const trackedPaths = runGit(primary, [
    'diff',
    '--name-only',
    '--no-renames',
    '-z',
    'HEAD',
    '--',
  ]).stdout.split('\0').filter(Boolean).sort();
  const contentDigest = trackedContentDigest(primary);
  const plan = {
    commonDir: diagnosis.repository.commonDir,
    primaryWorktree: primary,
    oldMainSha: diagnosis.developmentIntegration.localSha,
    targetRemoteSha: diagnosis.remoteBaseline.sha,
    remoteRef: diagnosis.remoteBaseline.ref,
    recoveryBranch: selectRecoveryBranch(primary),
    trackedChanges: {
      staged: [...status.staged].sort(),
      unstaged: [...status.unstaged].sort(),
      paths: trackedPaths,
    },
    trackedContentDigest: contentDigest,
    untrackedPaths: untrackedState.untrackedPaths,
    untrackedState,
    snapshotLimitation: SNAPSHOT_LIMITATION,
  };
  return { id: planIdentity(plan), ...plan };
}

function performRecovery(cwd, {
  apply = false,
  confirmation = null,
  primaryWorktree = null,
} = {}) {
  const plan = createPlan(cwd);
  if (apply) {
    if (confirmation !== plan.id) {
      blocked('确认值与当前恢复计划不匹配，已安全停止且未创建 recovery。');
    }
    if (!primaryWorktree) {
      blocked('显式执行 recovery 时必须确认主工作目录路径。');
    }
    let primaryMatchesPlan;
    try {
      primaryMatchesPlan = repositoryPathsEqual(
        plan.primaryWorktree,
        primaryWorktree,
        plan.primaryWorktree,
      );
    } catch {
      blocked('确认的主工作目录不存在，已安全停止且未创建 recovery。');
    }
    if (!primaryMatchesPlan) {
      blocked('确认的主工作目录与当前计划不匹配，已安全停止且未创建 recovery。');
    }
    let snapshotCommitSha = null;
    let stage = 'branch-create';
    try {
      git(plan.primaryWorktree, ['switch', '--no-track', '-c', plan.recoveryBranch]);
      if (plan.trackedChanges.paths.length > 0) {
        stage = 'snapshot-stage';
        const indexPaths = new Set(
          runGit(plan.primaryWorktree, ['ls-files', '-z']).stdout.split('\0').filter(Boolean),
        );
        const pathsNeedingUpdate = plan.trackedChanges.paths.filter((relativePath) =>
          indexPaths.has(relativePath),
        );
        if (pathsNeedingUpdate.length > 0) {
          runGit(plan.primaryWorktree, [
            'add',
            '-u',
            '--pathspec-from-file=-',
            '--pathspec-file-nul',
          ], { input: `${pathsNeedingUpdate.join('\0')}\0` });
        }
        const stagedPaths = runGit(plan.primaryWorktree, [
          'diff',
          '--cached',
          '--name-only',
          '--no-renames',
          '-z',
          'HEAD',
          '--',
        ]).stdout.split('\0').filter(Boolean).sort();
        if (JSON.stringify(stagedPaths) !== JSON.stringify(plan.trackedChanges.paths)) {
          blocked('快照暂存路径与计划不一致，已安全停止；本地 main 未移动。');
        }
        if (trackedContentDigest(plan.primaryWorktree, { cached: true }) !== plan.trackedContentDigest) {
          blocked('tracked 最终内容与已确认计划不一致，已安全停止；本地 main 未移动。');
        }
        stage = 'snapshot-commit';
        const snapshotTreeSha = git(plan.primaryWorktree, ['write-tree']);
        const candidateSnapshotSha = runGit(plan.primaryWorktree, [
          'commit-tree',
          snapshotTreeSha,
          '-p',
          plan.oldMainSha,
          '-F',
          '-',
        ], { input: '恢复：保存本地 main 同步前的 tracked 最终内容\n' }).stdout.trim();
        const snapshotPaths = runGit(plan.primaryWorktree, [
          'diff-tree',
          '--no-commit-id',
          '--name-only',
          '--no-renames',
          '-r',
          '-z',
          plan.oldMainSha,
          candidateSnapshotSha,
        ]).stdout.split('\0').filter(Boolean).sort();
        if (JSON.stringify(snapshotPaths) !== JSON.stringify(plan.trackedChanges.paths)) {
          blocked('快照提交路径与计划不一致，已安全停止；本地 main 未移动。');
        }
        stage = 'recovery-ref-update';
        git(plan.primaryWorktree, [
          'update-ref',
          `refs/heads/${plan.recoveryBranch}`,
          candidateSnapshotSha,
          plan.oldMainSha,
        ]);
        snapshotCommitSha = candidateSnapshotSha;
      }
      const recoveryHeadSha = git(plan.primaryWorktree, ['rev-parse', 'HEAD^{commit}']);
      if (git(plan.primaryWorktree, ['rev-parse', 'refs/heads/main^{commit}']) !== plan.oldMainSha) {
        blocked('本地 main 在创建恢复点期间发生变化，已安全停止。');
      }
      if (snapshotCommitSha === null && recoveryHeadSha !== plan.oldMainSha) {
        blocked('创建的 recovery 未指向原本地 main，已安全停止。');
      }
      stage = 'metadata-write';
      const metadataPath = writeMetadata(plan, snapshotCommitSha, recoveryHeadSha);
      return {
        schemaVersion: 1,
        command: 'recovery',
        exitCode: 0,
        statuses: ['recovery-created'],
        applied: true,
        plan,
        result: {
          recoveryBranch: plan.recoveryBranch,
          recoveryHeadSha,
          snapshotCommitSha,
          metadataPath,
          mainRefUnchanged: true,
        },
        conclusions: [
          `已创建本地恢复分支 ${plan.recoveryBranch}，未设置 upstream。`,
          `本地 main 仍指向 ${plan.oldMainSha}，本阶段没有移动该引用。`,
        ],
      };
    } catch (error) {
      stoppedAfterMutation(error, plan, { snapshotCommitSha, stage });
    }
  }
  return {
    schemaVersion: 1,
    command: 'recovery',
    exitCode: 0,
    statuses: ['recovery-planned'],
    applied: false,
    plan,
    conclusions: [
      `将从本地 main ${plan.oldMainSha} 创建 ${plan.recoveryBranch}。`,
      `目标远端基线为 ${plan.targetRemoteSha}；本阶段不会移动 main。`,
      plan.snapshotLimitation,
    ],
  };
}

export function recovery(cwd, options = {}) {
  const emptyHooksDirectory = mkdtempSync(path.join(tmpdir(), 'skill-expert-hooks-disabled-'));
  try {
    return withGitHooksDisabled(emptyHooksDirectory, () => performRecovery(cwd, options));
  } finally {
    rmSync(emptyHooksDirectory, { recursive: true, force: true });
  }
}
