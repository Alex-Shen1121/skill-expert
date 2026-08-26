import { createHash } from 'node:crypto';
import {
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from 'node:fs';
import path from 'node:path';

import { git, runGit } from './git.mjs';

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

function normalizePath(value) {
  return realpathSync.native(path.resolve(value));
}

function resolveCommit(cwd, ref) {
  const result = runGit(cwd, ['rev-parse', '--verify', `${ref}^{commit}`], {
    allowFailure: true,
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

function sortedUniqueStrings(value) {
  return Array.isArray(value) &&
    value.every((item) => typeof item === 'string') &&
    new Set(value).size === value.length &&
    JSON.stringify(value) === JSON.stringify([...value].sort());
}

function recoveryPlanIdentity(metadata) {
  return createHash('sha256').update(JSON.stringify({
    commonDir: metadata.commonDir,
    primaryWorktree: metadata.primaryWorktree,
    oldMainSha: metadata.oldMainSha,
    targetRemoteSha: metadata.targetRemoteSha,
    remoteRef: metadata.remoteRef,
    recoveryBranch: metadata.recoveryBranch,
    trackedChanges: {
      staged: metadata.stagedBefore,
      unstaged: metadata.unstagedBefore,
      paths: metadata.trackedPaths,
    },
    trackedContentDigest: metadata.trackedContentDigest,
    untrackedPaths: metadata.untrackedBefore,
    snapshotLimitation: metadata.snapshotLimitation,
  })).digest('hex');
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

export function readRecoveryMetadata(commonDir, planId) {
  if (!PLAN_ID_PATTERN.test(planId)) {
    throw new Error('recovery 计划确认值格式无效，已安全停止。');
  }
  const metadataPath = path.join(commonDir, 'skill-expert-recovery', `${planId}.json`);
  let metadata;
  try {
    const stat = lstatSync(metadataPath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error('recovery 元数据不是可验证的常规文件，已安全停止。');
    }
    metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
  } catch (error) {
    if (error.message === 'recovery 元数据不是可验证的常规文件，已安全停止。') {
      throw error;
    }
    throw new Error(
      '未找到由 recovery 命令创建的完整元数据，legacy/unverified 恢复分支不能自动同步 main。',
    );
  }
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new Error('recovery 元数据格式无效，已安全停止。');
  }
  const { integrity, ...payload } = metadata;
  const calculatedIntegrity = createHash('sha256')
    .update(JSON.stringify(payload))
    .digest('hex');
  if (integrity !== calculatedIntegrity) {
    throw new Error('recovery 元数据完整性校验失败，已安全停止。');
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
    throw new Error('recovery 元数据缺少必要字段或字段格式无效，已安全停止。');
  }
  if (recoveryPlanIdentity(metadata) !== metadata.planId) {
    throw new Error('recovery 计划确认值重算后与元数据不匹配，已安全停止。');
  }
  return { metadata, metadataPath };
}

export function verifyRecoveryMetadata(commonDir, metadata, { requireCheckedOut = false } = {}) {
  let metadataCommonDir;
  let metadataPrimary;
  try {
    metadataCommonDir = normalizePath(metadata.commonDir);
    metadataPrimary = normalizePath(metadata.primaryWorktree);
  } catch {
    throw new Error('recovery 元数据中的仓库路径已无法解析，已安全停止。');
  }
  if (metadataCommonDir !== normalizePath(commonDir)) {
    throw new Error('recovery 元数据不属于当前仓库，已安全停止。');
  }
  const recoveryHeadSha = resolveCommit(metadataPrimary, metadata.recoveryRef);
  if (recoveryHeadSha !== metadata.recoveryHeadSha) {
    throw new Error('recovery 分支已缺失或指向发生变化，已安全停止。');
  }
  const upstream = runGit(
    metadataPrimary,
    ['rev-parse', '--abbrev-ref', `${metadata.recoveryBranch}@{upstream}`],
    { allowFailure: true },
  );
  if (upstream.status === 0) {
    throw new Error('recovery 分支意外设置了 upstream，已安全停止。');
  }
  if (metadata.snapshotCommitSha === null) {
    if (
      metadata.recoveryHeadSha !== metadata.oldMainSha ||
      metadata.trackedPaths.length > 0 ||
      metadata.stagedBefore.length > 0 ||
      metadata.unstagedBefore.length > 0
    ) {
      throw new Error('无快照 recovery 的元数据与恢复分支不一致，已安全停止。');
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
      throw new Error('recovery 快照提交无法完整验证，已安全停止。');
    }
  }
  if (requireCheckedOut) {
    const primaryBranch = git(metadataPrimary, ['branch', '--show-current']) || null;
    const primaryHead = resolveCommit(metadataPrimary, 'HEAD');
    if (primaryBranch !== metadata.recoveryBranch || primaryHead !== metadata.recoveryHeadSha) {
      throw new Error('主工作目录未停留在已验证的 recovery 现场，已安全停止。');
    }
  }
  return { metadataPrimary, recoveryHeadSha };
}

export function findVerifiedRecoveryMetadata(commonDir) {
  const metadataDirectory = path.join(commonDir, 'skill-expert-recovery');
  let entries;
  try {
    entries = readdirSync(metadataDirectory, { withFileTypes: true });
  } catch {
    return new Map();
  }
  const verified = new Map();
  for (const entry of entries) {
    const match = /^([0-9a-f]{64})\.json$/.exec(entry.name);
    if (!entry.isFile() || !match) continue;
    try {
      const { metadata } = readRecoveryMetadata(commonDir, match[1]);
      verifyRecoveryMetadata(commonDir, metadata);
      verified.set(metadata.recoveryBranch, metadata);
    } catch {
      // 无效或被篡改的元数据不会把恢复分支提升为 verified。
    }
  }
  return verified;
}
