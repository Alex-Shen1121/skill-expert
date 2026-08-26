import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { diagnose } from './diagnose.mjs';
import { git, parseStatus, runGit, withGitHooksDisabled } from './git.mjs';

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const PLAN_ID_PATTERN = /^[0-9a-f]{64}$/;
const RECOVERY_METADATA_FIELDS = [
  'commonDir',
  'createdAt',
  'integrity',
  'oldMainSha',
  'planId',
  'primaryWorktree',
  'recoveryBranch',
  'recoveryHeadSha',
  'recoveryRef',
  'remoteRef',
  'schemaVersion',
  'snapshotCommitSha',
  'snapshotLimitation',
  'stagedBefore',
  'targetRemoteSha',
  'trackedContentDigest',
  'trackedPaths',
  'unstagedBefore',
  'untrackedBefore',
].sort();

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

function resolveCommit(cwd, ref) {
  const result = runGit(cwd, ['rev-parse', '--verify', `${ref}^{commit}`], {
    allowFailure: true,
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

function normalizePath(value) {
  return realpathSync.native(path.resolve(value));
}

function sortedUniqueStrings(value) {
  return Array.isArray(value) &&
    value.every((item) => typeof item === 'string') &&
    new Set(value).size === value.length &&
    JSON.stringify(value) === JSON.stringify([...value].sort());
}

function readRecoveryMetadata(commonDir, planId) {
  if (!PLAN_ID_PATTERN.test(planId)) {
    blocked('recovery 计划确认值格式无效，已安全停止。');
  }
  const metadataPath = path.join(commonDir, 'skill-expert-recovery', `${planId}.json`);
  let metadata;
  try {
    const stat = lstatSync(metadataPath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      blocked('recovery 元数据不是可验证的常规文件，已安全停止。');
    }
    metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
  } catch (error) {
    if (error.kind === 'sync-blocked') throw error;
    blocked('未找到由 recovery 命令创建的完整元数据，legacy/unverified 恢复分支不能自动同步 main。');
  }
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    blocked('recovery 元数据格式无效，已安全停止。');
  }
  const { integrity, ...payload } = metadata;
  const calculatedIntegrity = createHash('sha256')
    .update(JSON.stringify(payload))
    .digest('hex');
  if (integrity !== calculatedIntegrity) {
    blocked('recovery 元数据完整性校验失败，已安全停止。');
  }
  const validShape =
    JSON.stringify(Object.keys(metadata).sort()) === JSON.stringify(RECOVERY_METADATA_FIELDS) &&
    metadata.schemaVersion === 1 &&
    metadata.planId === planId &&
    typeof metadata.createdAt === 'string' &&
    !Number.isNaN(Date.parse(metadata.createdAt)) &&
    typeof metadata.commonDir === 'string' &&
    typeof metadata.primaryWorktree === 'string' &&
    SHA_PATTERN.test(metadata.oldMainSha) &&
    SHA_PATTERN.test(metadata.targetRemoteSha) &&
    metadata.remoteRef === 'refs/remotes/origin/main' &&
    /^codex\/local-main-recovery-\d{8}(?:-\d+)?$/.test(metadata.recoveryBranch) &&
    metadata.recoveryRef === `refs/heads/${metadata.recoveryBranch}` &&
    (metadata.snapshotCommitSha === null || SHA_PATTERN.test(metadata.snapshotCommitSha)) &&
    SHA_PATTERN.test(metadata.recoveryHeadSha) &&
    sortedUniqueStrings(metadata.trackedPaths) &&
    /^[0-9a-f]{64}$/.test(metadata.trackedContentDigest) &&
    sortedUniqueStrings(metadata.stagedBefore) &&
    sortedUniqueStrings(metadata.unstagedBefore) &&
    sortedUniqueStrings(metadata.untrackedBefore) &&
    typeof metadata.snapshotLimitation === 'string';
  if (!validShape) {
    blocked('recovery 元数据缺少必要字段或字段格式无效，已安全停止。');
  }
  return { metadata, metadataPath };
}

function diffDigest(cwd, leftSha, rightSha) {
  return createHash('sha256').update(runGit(cwd, [
    'diff',
    '--binary',
    '--full-index',
    '--no-ext-diff',
    '--no-textconv',
    '--no-renames',
    leftSha,
    rightSha,
    '--',
  ], { encoding: null }).stdout).digest('hex');
}

function verifyRecovery(cwd, metadata, { requireCheckedOut = false } = {}) {
  let metadataCommonDir;
  let metadataPrimary;
  try {
    metadataCommonDir = normalizePath(metadata.commonDir);
    metadataPrimary = normalizePath(metadata.primaryWorktree);
  } catch {
    blocked('recovery 元数据中的仓库路径已无法解析，已安全停止。');
  }
  if (metadataCommonDir !== normalizePath(cwd)) {
    blocked('recovery 元数据不属于当前仓库，已安全停止。');
  }
  const recoveryHeadSha = resolveCommit(metadataPrimary, metadata.recoveryRef);
  if (recoveryHeadSha !== metadata.recoveryHeadSha) {
    blocked('recovery 分支已缺失或指向发生变化，已安全停止。');
  }
  const upstream = runGit(
    metadataPrimary,
    ['rev-parse', '--abbrev-ref', `${metadata.recoveryBranch}@{upstream}`],
    { allowFailure: true },
  );
  if (upstream.status === 0) {
    blocked('recovery 分支意外设置了 upstream，已安全停止。');
  }
  if (metadata.snapshotCommitSha === null) {
    if (
      metadata.recoveryHeadSha !== metadata.oldMainSha ||
      metadata.trackedPaths.length > 0 ||
      metadata.stagedBefore.length > 0 ||
      metadata.unstagedBefore.length > 0
    ) {
      blocked('无快照 recovery 的元数据与恢复分支不一致，已安全停止。');
    }
  } else {
    const parentSha = resolveCommit(metadataPrimary, `${metadata.snapshotCommitSha}^`);
    const snapshotPaths = runGit(metadataPrimary, [
      'diff-tree',
      '--no-commit-id',
      '--name-only',
      '--no-renames',
      '-r',
      '-z',
      metadata.oldMainSha,
      metadata.snapshotCommitSha,
    ]).stdout.split('\0').filter(Boolean).sort();
    if (
      metadata.snapshotCommitSha !== metadata.recoveryHeadSha ||
      parentSha !== metadata.oldMainSha ||
      JSON.stringify(snapshotPaths) !== JSON.stringify(metadata.trackedPaths) ||
      diffDigest(metadataPrimary, metadata.oldMainSha, metadata.snapshotCommitSha) !==
        metadata.trackedContentDigest
    ) {
      blocked('recovery 快照提交无法完整验证，已安全停止。');
    }
  }
  if (requireCheckedOut) {
    const primaryBranch = git(metadataPrimary, ['branch', '--show-current']) || null;
    const primaryHead = resolveCommit(metadataPrimary, 'HEAD');
    if (primaryBranch !== metadata.recoveryBranch || primaryHead !== metadata.recoveryHeadSha) {
      blocked('主工作目录未停留在已验证的 recovery 现场，已安全停止。');
    }
  }
  return { metadataPrimary, recoveryHeadSha };
}

function ongoingOperation(cwd) {
  const markers = [
    ['MERGE_HEAD', 'merge'],
    ['CHERRY_PICK_HEAD', 'cherry-pick'],
    ['REVERT_HEAD', 'revert'],
    ['BISECT_LOG', 'bisect'],
    ['rebase-merge', 'rebase'],
    ['rebase-apply', 'rebase'],
    ['sequencer', 'sequencer'],
  ];
  for (const [marker, operation] of markers) {
    const gitPath = git(cwd, ['rev-parse', '--git-path', marker]);
    const absolutePath = path.isAbsolute(gitPath) ? gitPath : path.resolve(cwd, gitPath);
    if (existsSync(absolutePath)) return operation;
  }
  return null;
}

function untrackedFingerprint(cwd) {
  const status = parseStatus(
    runGit(cwd, ['status', '--porcelain=v2', '-z', '--untracked-files=all']).stdout,
  );
  return Object.fromEntries([...status.untracked].sort().map((relativePath) => {
    const absolutePath = path.join(cwd, relativePath);
    const stat = lstatSync(absolutePath);
    const digest = createHash('sha256');
    if (stat.isSymbolicLink()) digest.update(readlinkSync(absolutePath));
    else if (stat.isFile()) digest.update(readFileSync(absolutePath));
    else digest.update(`${stat.mode}:${stat.size}`);
    return [relativePath, `${stat.mode}:${digest.digest('hex')}`];
  }));
}

function captureWorktrees(worktrees) {
  return Object.fromEntries(worktrees.filter((item) => !item.bare).map((item) => [item.path, {
    head: resolveCommit(item.path, 'HEAD'),
    branch: git(item.path, ['branch', '--show-current']) || null,
    untracked: untrackedFingerprint(item.path),
  }]));
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

function allUntrackedPaths(cwd) {
  const ordinary = runGit(cwd, [
    'ls-files',
    '--others',
    '--exclude-standard',
    '-z',
  ]).stdout.split('\0').filter(Boolean);
  const ignored = runGit(cwd, [
    'ls-files',
    '--others',
    '--ignored',
    '--exclude-standard',
    '-z',
  ]).stdout.split('\0').filter(Boolean);
  return [...new Set([...ordinary, ...ignored])].sort();
}

function targetCheckoutCollision(cwd, targetSha) {
  const targetPaths = runGit(cwd, [
    'ls-tree',
    '-r',
    '--name-only',
    '-z',
    targetSha,
  ]).stdout.split('\0').filter(Boolean);
  const untrackedPaths = allUntrackedPaths(cwd);
  return untrackedPaths.find((untrackedPath) => targetPaths.some((targetPath) =>
    targetPath === untrackedPath ||
    targetPath.startsWith(`${untrackedPath}/`) ||
    untrackedPath.startsWith(`${targetPath}/`),
  )) ?? null;
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
    return verifyRecovery(cwd, metadata, options);
  } catch (error) {
    if (error.kind === 'sync-blocked') {
      error.details = {
        ...error.details,
        ...preservedRecoveryDetails(metadata),
      };
    }
    throw error;
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
  const { metadata, metadataPath } = readRecoveryMetadata(commonDir, confirmation);
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
    confirmedPrimary !== diagnosis.repository.primaryWorktree ||
    confirmedPrimary !== normalizePath(metadata.primaryWorktree)
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
  if (recoveryOwners.length !== 1 || recoveryOwners[0].path !== confirmedPrimary) {
    blockedWithRecovery(
      '无法唯一确认主工作目录中的 recovery 现场，已安全停止。',
      metadata,
    );
  }
  for (const worktree of diagnosis.worktrees.filter((item) => !item.bare)) {
    const operation = ongoingOperation(worktree.path);
    if (operation) {
      blockedWithRecovery(
        `${worktree.path} 存在进行中的 ${operation} 操作，已安全停止。`,
        metadata,
      );
    }
  }
  const primaryStatus = parseStatus(
    runGit(confirmedPrimary, ['status', '--porcelain=v2', '-z', '--untracked-files=all']).stdout,
  );
  if (primaryStatus.staged.length > 0 || primaryStatus.unstaged.length > 0) {
    blockedWithRecovery(
      '主工作目录在 recovery 后出现 tracked 变化，已安全停止。',
      metadata,
    );
  }
  if (JSON.stringify([...primaryStatus.untracked].sort()) !== JSON.stringify(metadata.untrackedBefore)) {
    blockedWithRecovery(
      '主工作目录的 untracked 路径在 recovery 后发生变化，已安全停止。',
      metadata,
    );
  }
  const conflictingUntrackedPath = targetCheckoutCollision(
    confirmedPrimary,
    metadata.targetRemoteSha,
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

  const worktreesBefore = captureWorktrees(diagnosis.worktrees);
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
    verifyRecovery(diagnosis.repository.commonDir, metadata);
    const finalWorktreeRecords = diagnose(cwd, { offline: true }).worktrees;
    const worktreesAfter = captureWorktrees(finalWorktreeRecords);
    if (JSON.stringify(Object.keys(worktreesAfter).sort()) !==
      JSON.stringify(Object.keys(worktreesBefore).sort())) {
      throw new Error('同步期间 worktree 集合发生变化。');
    }
    for (const [worktreePath, before] of Object.entries(worktreesBefore)) {
      const after = worktreesAfter[worktreePath];
      if (worktreePath === confirmedPrimary) {
        if (after.head !== metadata.targetRemoteSha || after.branch !== 'main') {
          throw new Error('主工作目录未正确切回 main。');
        }
      } else if (after.head !== before.head || after.branch !== before.branch) {
        throw new Error(`同步意外改变了 worktree ${worktreePath} 的上下文。`);
      }
      if (JSON.stringify(after.untracked) !== JSON.stringify(before.untracked)) {
        throw new Error(`同步意外改变了 worktree ${worktreePath} 的 untracked 内容。`);
      }
    }
    if (!compareProtectedRefs(protectedRefsBefore, captureProtectedRefs(confirmedPrimary))) {
      throw new Error('同步意外改变了 main 以外的本地或远端跟踪引用。');
    }
    const finalStatus = parseStatus(
      runGit(confirmedPrimary, ['status', '--porcelain=v2', '-z', '--untracked-files=all']).stdout,
    );
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
