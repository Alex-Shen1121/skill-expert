import { realpathSync } from 'node:fs';
import path from 'node:path';

import { git, parseStatus, parseWorktrees, runGit } from './git.mjs';
import { findVerifiedRecoveryMetadata } from './recovery-records.mjs';

function normalizePath(value) {
  return realpathSync.native(path.resolve(value));
}

function resolveCachedDefaultBranch(cwd) {
  const cached = runGit(cwd, [
    'symbolic-ref',
    '--quiet',
    '--short',
    'refs/remotes/origin/HEAD',
  ], { allowFailure: true });
  if (cached.status !== 0 || !cached.stdout.trim().startsWith('origin/')) return null;
  return cached.stdout.trim().slice('origin/'.length);
}

function resolveRemoteDefaultBranch(cwd) {
  const lookup = runGit(cwd, ['ls-remote', '--symref', 'origin', 'HEAD'], {
    allowFailure: true,
  });
  const match = /^ref:\s+(refs\/heads\/(.+))\s+HEAD$/m.exec(lookup.stdout);
  if (lookup.status === 0 && match) {
    return { branch: match[2], remoteHeadRef: match[1], lookupError: null };
  }
  const cachedBranch = resolveCachedDefaultBranch(cwd);
  if (!cachedBranch) {
    throw new Error(
      `无法安全判断远端默认分支：${
        lookup.stderr.trim() || 'origin 没有可解析的符号引用，且本地不存在默认分支缓存'
      }`,
    );
  }
  return {
    branch: cachedBranch,
    remoteHeadRef: `refs/heads/${cachedBranch}`,
    lookupError: lookup.stderr.trim() || 'origin 没有返回可解析的默认分支',
  };
}

function blobAt(cwd, commitSha, relativePath) {
  const result = runGit(cwd, ['rev-parse', '--verify', `${commitSha}:${relativePath}`], {
    allowFailure: true,
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

function findMatchingRemoteChangeSet(cwd, leftSha, rightSha, mergeBase) {
  const changedPaths = runGit(cwd, [
    'diff',
    '--name-only',
    '-z',
    mergeBase,
    leftSha,
  ]).stdout
    .split('\0')
    .filter(Boolean);
  if (changedPaths.length === 0) return null;
  const candidates = git(cwd, ['rev-list', '--reverse', `${mergeBase}..${rightSha}`])
    .split(/\r?\n/)
    .filter(Boolean);
  return candidates.find((candidate) =>
    changedPaths.every(
      (relativePath) => blobAt(cwd, candidate, relativePath) === blobAt(cwd, leftSha, relativePath),
    ),
  ) ?? null;
}

function compareCommits(cwd, leftSha, rightSha) {
  if (!leftSha || !rightSha) {
    return { mergeBase: null, ahead: null, behind: null, relation: 'unknown' };
  }
  const [ahead, behind] = git(cwd, [
    'rev-list',
    '--left-right',
    '--count',
    `${leftSha}...${rightSha}`,
  ])
    .split(/\s+/)
    .map(Number);
  const relation =
    ahead === 0 && behind === 0
      ? 'in-sync'
      : ahead > 0 && behind === 0
        ? 'ahead'
        : ahead === 0 && behind > 0
          ? 'behind'
          : 'diverged';
  const mergeBaseResult = runGit(cwd, ['merge-base', leftSha, rightSha], {
    allowFailure: true,
  });
  const mergeBase = mergeBaseResult.status === 0 ? mergeBaseResult.stdout.trim() : null;
  let divergence;
  if (relation === 'diverged') {
    const localTree = git(cwd, ['rev-parse', `${leftSha}^{tree}`]);
    const remoteTree = git(cwd, ['rev-parse', `${rightSha}^{tree}`]);
    if (localTree === remoteTree) {
      divergence = { kind: 'possible-squash', evidence: 'identical-trees' };
    } else if (mergeBase) {
      const matchedRemoteSha = findMatchingRemoteChangeSet(cwd, leftSha, rightSha, mergeBase);
      divergence = matchedRemoteSha
        ? { kind: 'possible-squash', evidence: 'matching-local-change-set', matchedRemoteSha }
        : { kind: 'ordinary', evidence: 'different-trees' };
    } else {
      divergence = { kind: 'ordinary', evidence: 'unrelated-histories' };
    }
  }
  return {
    mergeBase,
    ahead,
    behind,
    relation,
    ...(divergence ? { divergence } : {}),
  };
}

function compareDevelopmentIntegration(cwd, branch, localSha, remoteSha) {
  return {
    localRef: `refs/heads/${branch}`,
    remoteRef: `refs/remotes/origin/${branch}`,
    localSha,
    remoteSha,
    ...compareCommits(cwd, localSha, remoteSha),
  };
}

function readRecoveryRecords(cwd, commonDir) {
  const verifiedMetadata = findVerifiedRecoveryMetadata(commonDir);
  return runGit(cwd, [
    'for-each-ref',
    '--format=%(refname)%00%(objectname)',
    'refs/heads/codex/local-main-recovery-*',
  ]).stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((record) => {
      const [ref, head] = record.split('\0');
      const branch = ref.slice('refs/heads/'.length);
      const metadata = verifiedMetadata.get(branch);
      return {
        branch,
        ref,
        head,
        verification: metadata ? 'verified' : 'legacy/unverified',
        planId: metadata?.planId ?? null,
      };
    });
}

export function diagnose(cwd, { offline = false } = {}) {
  const currentWorktree = normalizePath(git(cwd, ['rev-parse', '--show-toplevel']));
  const commonDir = normalizePath(git(cwd, [
    'rev-parse',
    '--path-format=absolute',
    '--git-common-dir',
  ]));
  const primaryWorktree = normalizePath(path.dirname(commonDir));
  const worktreeRecords = parseWorktrees(git(cwd, ['worktree', 'list', '--porcelain', '-z']));
  const remote = offline
    ? {
        branch: resolveCachedDefaultBranch(cwd),
        remoteHeadRef: null,
        lookupError: null,
      }
    : resolveRemoteDefaultBranch(cwd);
  if (!remote.branch) throw new Error('本地不存在 origin 默认分支缓存，无法离线诊断');
  const { branch, remoteHeadRef, lookupError } = remote;
  const remoteRef = `refs/remotes/origin/${branch}`;
  const previousRemoteResult = runGit(cwd, ['rev-parse', '--verify', `${remoteRef}^{commit}`], {
    allowFailure: true,
  });
  const previousRemoteSha =
    previousRemoteResult.status === 0 ? previousRemoteResult.stdout.trim() : null;
  let refresh = offline
    ? {
        status: 'skipped',
        latest: false,
        previousSha: previousRemoteSha,
        updated: false,
        reason: 'offline-requested',
      }
    : { status: 'refreshed', latest: true };
  if (!offline) {
    if (lookupError) {
      refresh = { status: 'failed', latest: false, reason: lookupError };
    } else {
      const fetch = runGit(cwd, [
        'fetch',
        '--no-tags',
        '--no-write-fetch-head',
        'origin',
        `+${remoteHeadRef}:${remoteRef}`,
      ], { allowFailure: true });
      if (fetch.status !== 0) {
        refresh = {
          status: 'failed',
          latest: false,
          reason: fetch.stderr.trim() || '无法刷新远端跟踪引用',
        };
      }
    }
  }
  const localResult = runGit(cwd, ['rev-parse', '--verify', `refs/heads/${branch}^{commit}`], {
    allowFailure: true,
  });
  const localSha = localResult.status === 0 ? localResult.stdout.trim() : null;
  const remoteResult = runGit(cwd, ['rev-parse', '--verify', `${remoteRef}^{commit}`], {
    allowFailure: true,
  });
  const remoteSha = remoteResult.status === 0 ? remoteResult.stdout.trim() : null;
  if (refresh.status === 'refreshed') {
    refresh = {
      ...refresh,
      previousSha: previousRemoteSha,
      updated: previousRemoteSha !== remoteSha,
    };
  }
  const currentBranch = git(cwd, ['branch', '--show-current']) || null;
  const currentHead = git(cwd, ['rev-parse', 'HEAD^{commit}']);
  const currentRelationship = compareCommits(cwd, currentHead, remoteSha);
  const worktrees = worktreeRecords.map((worktree) => ({
    ...worktree,
    suitability: worktree.detached || worktree.bare ? 'read-only' : 'named-branch',
    relationshipToRemote: compareCommits(cwd, worktree.head, remoteSha),
  }));
  const workingTree = parseStatus(
    runGit(cwd, ['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all']).stdout,
  );
  const developmentIntegration = compareDevelopmentIntegration(
    cwd,
    branch,
    localSha,
    remoteSha,
  );
  const recoveryRecords = readRecoveryRecords(cwd, commonDir);
  const expectedBranch = 'main';
  const branchIsExpected = branch === expectedBranch;
  const statuses = [refresh.latest
    ? 'remote-baseline-confirmed'
    : refresh.status === 'skipped'
      ? 'remote-baseline-cached'
      : 'remote-baseline-unconfirmed'];
  if (branchIsExpected) {
    if (!localSha) {
      statuses.push('main-missing', 'unable-to-determine');
    } else if (!remoteSha) {
      statuses.push('remote-baseline-missing', 'unable-to-determine');
    } else {
      statuses.push(`main-${developmentIntegration.relation}`);
      if (developmentIntegration.divergence) {
        statuses.push(`main-divergence-${developmentIntegration.divergence.kind}`);
      }
    }
  } else {
    statuses.push('remote-default-branch-unexpected');
  }
  if (!currentBranch) statuses.push('detached-head');
  const otherReadOnlyWorktrees = worktrees.filter(
    (worktree) => worktree.path !== currentWorktree && worktree.suitability === 'read-only',
  );
  if (otherReadOnlyWorktrees.length > 0) statuses.push('linked-worktree-read-only');
  for (const category of ['staged', 'unstaged', 'untracked']) {
    if (workingTree[category].length > 0) statuses.push(`working-tree-${category}`);
  }
  if (recoveryRecords.length > 0) statuses.push('recovery-records-present');
  if (recoveryRecords.some((record) => record.verification === 'verified')) {
    statuses.push('recovery-verified');
  }
  if (recoveryRecords.some((record) => record.verification === 'legacy/unverified')) {
    statuses.push('recovery-legacy-unverified');
  }
  const conclusions = refresh.latest
    ? [`已确认 origin 的默认分支为 ${branch}，并刷新远端跟踪引用。`]
    : refresh.status === 'skipped'
      ? [`已按离线模式读取 origin/${branch} 缓存，未确认最新远端基线。`]
      : [
        `无法确认最新远端基线：${refresh.reason}。以下结论仅使用本地缓存的 origin/${branch}。`,
      ];
  if (!branchIsExpected) {
    conclusions.push(`远端实际默认分支为 ${branch}；Skill Expert 的开发集成分支必须为 main。`);
  }
  if (!localSha) {
    conclusions.push('本地 main 不存在，无法安全判断开发集成分支状态。');
  } else if (developmentIntegration.relation === 'in-sync') {
    conclusions.push(`本地 ${branch} 与 origin/${branch} 完全同步。`);
  } else if (developmentIntegration.relation === 'ahead') {
    conclusions.push(`本地 ${branch} 领先 origin/${branch} ${developmentIntegration.ahead} 个提交。`);
  } else if (developmentIntegration.relation === 'behind') {
    conclusions.push(`本地 ${branch} 落后 origin/${branch} ${developmentIntegration.behind} 个提交。`);
  } else if (developmentIntegration.divergence?.kind === 'possible-squash') {
    conclusions.push(developmentIntegration.divergence.evidence === 'identical-trees'
      ? `本地 ${branch} 与 origin/${branch} 历史分叉，但最终文件树相同；本地提交可能已通过 squash 等方式纳入，仍需人工核对。`
      : `本地 ${branch} 与 origin/${branch} 历史分叉；远端历史中存在匹配本地变更内容的提交，本地提交可能已通过 squash 等方式纳入，且远端后来继续前进，仍需人工核对。`);
  } else if (developmentIntegration.relation === 'diverged') {
    conclusions.push(`本地 ${branch} 与 origin/${branch} 是普通双向分叉，最终文件树不同。`);
  }
  if (!currentBranch) conclusions.push('当前工作树处于 detached HEAD，只适合只读检查。');
  for (const worktree of otherReadOnlyWorktrees) {
    conclusions.push(`关联 worktree ${worktree.path} 处于 detached HEAD，只适合只读审查。`);
  }
  if (workingTree.staged.length > 0) conclusions.push('当前工作树存在已暂存变更。');
  if (workingTree.unstaged.length > 0) conclusions.push('当前工作树存在未暂存变更。');
  if (workingTree.untracked.length > 0) conclusions.push('当前工作树存在未跟踪内容，诊断不会修改它们。');
  if (
    currentRelationship.relation === 'diverged' &&
    workingTree.staged.length === 0 &&
    workingTree.unstaged.length === 0 &&
    workingTree.untracked.length === 0
  ) {
    conclusions.push('当前 HEAD 与远端的分支差异不是未提交修改，不应据此重复提交审查。');
  }
  for (const record of recoveryRecords) {
    conclusions.push(record.verification === 'verified'
      ? `发现本地恢复分支 ${record.branch}，工具元数据完整且恢复引用已验证。`
      : `发现本地恢复分支 ${record.branch}，但缺少工具完整元数据，状态为 legacy/unverified，不能用于自动同步。`);
  }

  return {
    schemaVersion: 1,
    command: 'diagnose',
    exitCode:
      refresh.status === 'failed' || !branchIsExpected || !localSha || !remoteSha ? 1 : 0,
    statuses,
    conclusions,
    repository: { primaryWorktree, currentWorktree, commonDir },
    remoteBaseline: {
      remote: 'origin',
      branch,
      expectedBranch,
      ref: remoteRef,
      sha: remoteSha,
      refresh,
    },
    current: {
      path: currentWorktree,
      head: currentHead,
      branch: currentBranch,
      detached: !currentBranch,
      relationshipToRemote: currentRelationship,
    },
    worktrees,
    recoveryRecords,
    workingTree,
    developmentIntegration,
  };
}
