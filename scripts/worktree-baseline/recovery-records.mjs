import { createHash } from 'node:crypto';
import {
  lstatSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import path from 'node:path';

import { git, runGit } from './git.mjs';
import { calculateRecoveryPlanId } from './recovery-plan.mjs';
import {
  normalizePath,
  repositoryPathsEqual,
  resolveCommit,
} from './safety.mjs';

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
  'untrackedStateBefore',
].sort();

function sortedUniqueStrings(value) {
  return Array.isArray(value) &&
    value.every((item) => typeof item === 'string') &&
    new Set(value).size === value.length &&
    JSON.stringify(value) === JSON.stringify([...value].sort());
}

function validUntrackedState(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    JSON.stringify(Object.keys(value).sort()) !==
      JSON.stringify(['digest', 'entries', 'ignoredPaths', 'untrackedPaths']) ||
    !sortedUniqueStrings(value.untrackedPaths) ||
    !sortedUniqueStrings(value.ignoredPaths) ||
    !Array.isArray(value.entries) ||
    !/^[0-9a-f]{64}$/.test(value.digest)
  ) return false;
  const keys = [];
  for (const entry of value.entries) {
    if (
      !entry ||
      typeof entry !== 'object' ||
      Array.isArray(entry) ||
      JSON.stringify(Object.keys(entry).sort()) !==
        JSON.stringify(['digest', 'mode', 'path', 'size', 'source', 'type']) ||
      typeof entry.path !== 'string' ||
      entry.path.length === 0 ||
      !['untracked', 'ignored'].includes(entry.source) ||
      !['file', 'directory', 'symlink', 'other'].includes(entry.type) ||
      !Number.isInteger(entry.mode) ||
      !Number.isInteger(entry.size) ||
      entry.size < 0 ||
      !/^[0-9a-f]{64}$/.test(entry.digest)
    ) return false;
    keys.push(`${entry.path}\0${entry.source}`);
  }
  if (new Set(keys).size !== keys.length || JSON.stringify(keys) !== JSON.stringify([...keys].sort())) {
    return false;
  }
  return value.digest === createHash('sha256')
    .update(JSON.stringify(value.entries))
    .digest('hex');
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
    metadata.schemaVersion === 2 &&
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
    validUntrackedState(metadata.untrackedStateBefore) &&
    JSON.stringify(metadata.untrackedBefore) ===
      JSON.stringify(metadata.untrackedStateBefore.untrackedPaths) &&
    typeof metadata.snapshotLimitation === 'string';
  if (!validShape) {
    throw new Error('recovery 元数据缺少必要字段或字段格式无效，已安全停止。');
  }
  if (calculateRecoveryPlanId(metadata) !== metadata.planId) {
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
  if (!repositoryPathsEqual(metadataPrimary, metadataCommonDir, commonDir)) {
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
