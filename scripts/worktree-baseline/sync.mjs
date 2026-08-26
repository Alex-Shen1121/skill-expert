import {
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { diagnose } from './diagnose.mjs';
import { git, runGit, withGitHooksDisabled } from './git.mjs';
import { readRecoveryMetadata, verifyRecoveryMetadata } from './recovery-records.mjs';
import {
  captureUntrackedState,
  findOngoingOperation,
  normalizePath,
  readWorkingTreeStatus,
  repositoryPathKey,
  repositoryPathsEqual,
  repositoryRelativePathKey,
  resolveCommit,
} from './safety.mjs';

function syncError(kind, message, details) {
  const error = new Error(message);
  error.kind = kind;
  error.exitCode = 1;
  if (details) error.details = details;
  return error;
}

function blocked(message, details = {}) {
  throw syncError('sync-blocked', message, {
    stage: 'revalidate',
    mainMoved: false,
    ...details,
  });
}

function captureWorktrees(worktrees, comparisonCwd) {
  return Object.fromEntries(worktrees.filter((item) => !item.bare).map((item) => {
    const worktreePath = normalizePath(item.path);
    return [repositoryPathKey(comparisonCwd, worktreePath), {
      path: worktreePath,
      head: resolveCommit(worktreePath, 'HEAD'),
      branch: git(worktreePath, ['branch', '--show-current']) || null,
      untrackedState: captureUntrackedState(worktreePath),
    }];
  }));
}

function captureProtectedRefs(cwd) {
  return git(cwd, [
    'for-each-ref',
    '--format=%(refname):%(objectname)',
    'refs/heads',
    'refs/tags',
    'refs/remotes',
  ]).split(/\r?\n/).filter(Boolean);
}

function compareProtectedRefs(before, after) {
  const allowedRef = 'refs/heads/main:';
  return JSON.stringify(before.filter((entry) => !entry.startsWith(allowedRef))) ===
    JSON.stringify(after.filter((entry) => !entry.startsWith(allowedRef)));
}

function targetCheckoutCollision(cwd, targetSha, untrackedState) {
  const targetPaths = runGit(cwd, [
    'ls-tree',
    '-r',
    '--name-only',
    '-z',
    targetSha,
  ]).stdout.split('\0').filter(Boolean);
  const untrackedPaths = untrackedState.entries.map((entry) => entry.path);
  return untrackedPaths.find((untrackedPath) => {
    const candidate = repositoryRelativePathKey(cwd, untrackedPath);
    return targetPaths.some((targetPath) => {
      const target = repositoryRelativePathKey(cwd, targetPath);
      return target === candidate ||
        target.startsWith(`${candidate}/`) ||
        candidate.startsWith(`${target}/`);
    });
  }) ?? null;
}

function preservedRecoveryDetails(metadata) {
  const recoveryRefSha = resolveCommit(metadata.primaryWorktree, metadata.recoveryRef);
  const recoveryPreserved = recoveryRefSha === metadata.recoveryHeadSha;
  return {
    recoveryBranch: metadata.recoveryBranch,
    recoveryRefSha,
    recoveryPreserved,
    guidance: recoveryPreserved
      ? `main 未由本次同步移动；已验证的恢复分支 ${metadata.recoveryBranch} 仍保留在 ${metadata.recoveryHeadSha}。`
      : `main 未由本次同步移动；recovery ${metadata.recoveryBranch} 当前引用不再匹配已记录的 ${metadata.recoveryHeadSha}，请先人工核验恢复入口。`,
  };
}

function blockedWithRecovery(message, metadata, details = {}) {
  blocked(message, { ...details, ...preservedRecoveryDetails(metadata) });
}

function verifyRecoveryWithGuidance(cwd, metadata, options) {
  try {
    return verifyRecoveryMetadata(cwd, metadata, options);
  } catch (error) {
    blockedWithRecovery(error.message, metadata);
  }
}

function stopAfterMutation(error, metadata, stage) {
  const mainRefSha = resolveCommit(metadata.primaryWorktree, 'refs/heads/main');
  const recoveryRefSha = resolveCommit(metadata.primaryWorktree, metadata.recoveryRef);
  const mainMoved = mainRefSha !== metadata.oldMainSha;
  const primaryBranchResult = runGit(
    metadata.primaryWorktree,
    ['branch', '--show-current'],
    { allowFailure: true },
  );
  throw syncError('sync-stopped', error.message, {
    stage,
    mainMoved,
    mainRefSha,
    primaryWorktree: metadata.primaryWorktree,
    primaryBranch: primaryBranchResult.status === 0
      ? primaryBranchResult.stdout.trim() || null
      : null,
    recoveryBranch: metadata.recoveryBranch,
    recoveryRefSha,
    recoveryPreserved: recoveryRefSha === metadata.recoveryHeadSha,
    guidance: mainMoved
      ? `main 已移动至 ${mainRefSha}；已验证的恢复分支 ${metadata.recoveryBranch} 仍保留在 ${metadata.recoveryHeadSha}，请先核验现场再恢复。`
      : `main 未由本次同步移动；已验证的恢复分支 ${metadata.recoveryBranch} 仍保留。`,
  });
}

function performSync(cwd, { confirmation, primaryWorktree }) {
  const commonDir = normalizePath(git(cwd, [
    'rev-parse',
    '--path-format=absolute',
    '--git-common-dir',
  ]));
  let metadata;
  let metadataPath;
  try {
    ({ metadata, metadataPath } = readRecoveryMetadata(commonDir, confirmation));
  } catch (error) {
    blocked(error.message);
  }
  const diagnosis = diagnose(cwd);
  if (!diagnosis.remoteBaseline.refresh.latest) {
    blockedWithRecovery(
      '无法确认最新远端基线，已安全停止且未移动 main。',
      metadata,
    );
  }
  if (diagnosis.remoteBaseline.branch !== 'main') {
    blockedWithRecovery(
      '远端默认分支不是 main，已安全停止且未移动 main。',
      metadata,
    );
  }
  let confirmedPrimary;
  try {
    confirmedPrimary = normalizePath(primaryWorktree);
  } catch {
    blocked('显式确认的主工作目录不存在，已安全停止。');
  }
  if (
    !repositoryPathsEqual(confirmedPrimary, confirmedPrimary, diagnosis.repository.primaryWorktree) ||
    !repositoryPathsEqual(confirmedPrimary, confirmedPrimary, metadata.primaryWorktree)
  ) {
    blockedWithRecovery(
      '显式确认的主工作目录与 recovery 或当前仓库不一致，已安全停止。',
      metadata,
    );
  }
  if (diagnosis.remoteBaseline.sha !== metadata.targetRemoteSha) {
    blockedWithRecovery('origin/main 已在 recovery 后变化，原确认范围已失效，已安全停止。', metadata, {
      expectedTargetSha: metadata.targetRemoteSha,
      actualTargetSha: diagnosis.remoteBaseline.sha,
    });
  }
  if (diagnosis.remoteBaseline.ref !== metadata.remoteRef) {
    blockedWithRecovery(
      '当前远端跟踪引用与 recovery 计划不一致，已安全停止。',
      metadata,
    );
  }
  verifyRecoveryWithGuidance(
    diagnosis.repository.commonDir,
    metadata,
    { requireCheckedOut: true },
  );
  if (resolveCommit(confirmedPrimary, 'refs/heads/main') !== metadata.oldMainSha) {
    blockedWithRecovery(
      '本地 main 已在 recovery 后发生变化，已安全停止。',
      metadata,
    );
  }
  const mainOwners = diagnosis.worktrees.filter((item) => item.branch === 'main');
  const recoveryOwners = diagnosis.worktrees.filter(
    (item) => item.branch === metadata.recoveryBranch,
  );
  if (mainOwners.length !== 0) {
    blockedWithRecovery('main 被其他 worktree 占用，已安全停止。', metadata);
  }
  if (
    recoveryOwners.length !== 1 ||
    !repositoryPathsEqual(confirmedPrimary, recoveryOwners[0].path, confirmedPrimary)
  ) {
    blockedWithRecovery(
      '无法唯一确认主工作目录中的 recovery 现场，已安全停止。',
      metadata,
    );
  }
  for (const worktree of diagnosis.worktrees.filter((item) => !item.bare)) {
    const operation = findOngoingOperation(worktree.path);
    if (operation) {
      blockedWithRecovery(
        `${worktree.path} 存在进行中的 ${operation} 操作，已安全停止。`,
        metadata,
      );
    }
  }
  const primaryStatus = readWorkingTreeStatus(confirmedPrimary);
  if (primaryStatus.staged.length > 0 || primaryStatus.unstaged.length > 0) {
    blockedWithRecovery(
      '主工作目录在 recovery 后出现 tracked 变化，已安全停止。',
      metadata,
    );
  }
  const currentUntrackedState = captureUntrackedState(confirmedPrimary);
  if (JSON.stringify(currentUntrackedState) !== JSON.stringify(metadata.untrackedStateBefore)) {
    blockedWithRecovery(
      '主工作目录的 untracked 与 ignored 完整状态在 recovery 后发生变化，已安全停止。',
      metadata,
    );
  }
  const conflictingUntrackedPath = targetCheckoutCollision(
    confirmedPrimary,
    metadata.targetRemoteSha,
    currentUntrackedState,
  );
  if (conflictingUntrackedPath) {
    blockedWithRecovery(
      `untracked 路径 ${conflictingUntrackedPath} 与目标 main 冲突，已安全停止。`,
      metadata,
    );
  }
  const mainUpstream = runGit(
    confirmedPrimary,
    ['rev-parse', '--abbrev-ref', 'main@{upstream}'],
    { allowFailure: true },
  );
  if (mainUpstream.status !== 0 || mainUpstream.stdout.trim() !== 'origin/main') {
    blockedWithRecovery(
      '本地 main 的 upstream 不是 origin/main，已安全停止。',
      metadata,
    );
  }

  const worktreesBefore = captureWorktrees(diagnosis.worktrees, confirmedPrimary);
  const primaryKey = repositoryPathKey(confirmedPrimary, confirmedPrimary);
  if (
    JSON.stringify(worktreesBefore[primaryKey].untrackedState) !==
    JSON.stringify(metadata.untrackedStateBefore)
  ) {
    blockedWithRecovery(
      '主工作目录的 untracked 与 ignored 完整状态在最终复核时发生变化，已安全停止。',
      metadata,
    );
  }
  const protectedRefsBefore = captureProtectedRefs(confirmedPrimary);
  let stage = 'main-ref-update';
  try {
    runGit(confirmedPrimary, [
      'update-ref',
      'refs/heads/main',
      metadata.targetRemoteSha,
      metadata.oldMainSha,
    ]);
    stage = 'switch-main';
    runGit(confirmedPrimary, ['switch', 'main']);
    stage = 'final-verify';

    const mainSha = resolveCommit(confirmedPrimary, 'refs/heads/main');
    const remoteSha = resolveCommit(confirmedPrimary, metadata.remoteRef);
    const headSha = resolveCommit(confirmedPrimary, 'HEAD');
    const primaryBranch = git(confirmedPrimary, ['branch', '--show-current']) || null;
    const [ahead, behind] = git(confirmedPrimary, [
      'rev-list',
      '--left-right',
      '--count',
      `refs/heads/main...${metadata.remoteRef}`,
    ]).split(/\s+/).map(Number);
    const upstream = git(confirmedPrimary, [
      'rev-parse',
      '--abbrev-ref',
      'main@{upstream}',
    ]);
    if (
      mainSha !== metadata.targetRemoteSha ||
      remoteSha !== metadata.targetRemoteSha ||
      headSha !== metadata.targetRemoteSha ||
      primaryBranch !== 'main' ||
      ahead !== 0 ||
      behind !== 0 ||
      upstream !== 'origin/main'
    ) {
      throw new Error('同步后 main 的 SHA、ahead/behind 或 upstream 验证失败。');
    }
    verifyRecoveryMetadata(diagnosis.repository.commonDir, metadata);
    const finalWorktreeRecords = diagnose(cwd, { offline: true }).worktrees;
    const worktreesAfter = captureWorktrees(finalWorktreeRecords, confirmedPrimary);
    if (JSON.stringify(Object.keys(worktreesAfter).sort()) !==
      JSON.stringify(Object.keys(worktreesBefore).sort())) {
      throw new Error('同步期间 worktree 集合发生变化。');
    }
    for (const [worktreeKey, before] of Object.entries(worktreesBefore)) {
      const after = worktreesAfter[worktreeKey];
      if (worktreeKey === primaryKey) {
        if (after.head !== metadata.targetRemoteSha || after.branch !== 'main') {
          throw new Error('主工作目录未正确切回 main。');
        }
      } else if (after.head !== before.head || after.branch !== before.branch) {
        throw new Error(`同步意外改变了 worktree ${before.path} 的上下文。`);
      }
      if (JSON.stringify(after.untrackedState) !== JSON.stringify(before.untrackedState)) {
        throw new Error(`同步意外改变了 worktree ${before.path} 的 untracked 或 ignored 内容。`);
      }
    }
    if (!compareProtectedRefs(protectedRefsBefore, captureProtectedRefs(confirmedPrimary))) {
      throw new Error('同步意外改变了 main 以外的本地或远端跟踪引用。');
    }
    const finalStatus = readWorkingTreeStatus(confirmedPrimary);
    if (finalStatus.staged.length > 0 || finalStatus.unstaged.length > 0) {
      throw new Error('同步后主工作目录出现意外的 tracked 变化。');
    }
    return {
      schemaVersion: 1,
      command: 'sync',
      exitCode: 0,
      statuses: ['sync-completed'],
      applied: true,
      recovery: {
        metadataPath,
        planId: metadata.planId,
        oldMainSha: metadata.oldMainSha,
        targetRemoteSha: metadata.targetRemoteSha,
      },
      result: {
        stage: 'verified',
        primaryWorktree: confirmedPrimary,
        mainSha,
        remoteSha,
        ahead,
        behind,
        upstream,
        recoveryBranch: metadata.recoveryBranch,
        recoveryHeadSha: metadata.recoveryHeadSha,
        verifiedUntrackedPaths: [
          ...worktreesBefore[primaryKey].untrackedState.untrackedPaths,
          ...worktreesBefore[primaryKey].untrackedState.ignoredPaths,
        ].sort(),
      },
      conclusions: [
        `本地 main 已精确同步至 origin/main ${mainSha}，ahead/behind 为 0/0。`,
        `已验证的恢复分支 ${metadata.recoveryBranch} 仍保留在 ${metadata.recoveryHeadSha}。`,
        '其他 linked/detached worktree、untracked 内容和受保护引用均未改变。',
      ],
    };
  } catch (error) {
    stopAfterMutation(error, metadata, stage);
  }
}

export function sync(cwd, options) {
  const emptyHooksDirectory = mkdtempSync(path.join(tmpdir(), 'skill-expert-hooks-disabled-'));
  try {
    return withGitHooksDisabled(emptyHooksDirectory, () => performSync(cwd, options));
  } finally {
    rmSync(emptyHooksDirectory, { recursive: true, force: true });
  }
}
