import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import { diagnose } from './diagnose.mjs';
import { runGit } from './git.mjs';

const BASELINE_KEY = 'skill-expert.implementationBaseline';
const BRANCH_KEY = 'skill-expert.implementationBranch';
const INTEGRITY_KEY = 'skill-expert.implementationIntegrity';
const STARTED_KEY = 'skill-expert.implementationStarted';
const STARTED_MARKER = 'skill-expert-implementation-started';

function isAncestor(cwd, ancestor, descendant) {
  return runGit(cwd, ['merge-base', '--is-ancestor', ancestor, descendant], {
    allowFailure: true,
  }).status === 0;
}

function readWorktreeValue(cwd, key) {
  const result = runGit(cwd, ['config', '--worktree', '--get', key], {
    allowFailure: true,
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

function baselineIntegrity(worktreePath, branch, sha) {
  return createHash('sha256')
    .update(['1', worktreePath, branch, sha].join('\0'))
    .digest('hex');
}

function startedMarkerPath(cwd) {
  return runGit(cwd, [
    'rev-parse',
    '--path-format=absolute',
    '--git-path',
    STARTED_MARKER,
  ]).stdout.trim();
}

function readStartedMarker(cwd) {
  const markerPath = startedMarkerPath(cwd);
  return existsSync(markerPath) ? readFileSync(markerPath, 'utf8').trim() : null;
}

function readBaselineState(cwd, diagnosis) {
  const marker = readStartedMarker(cwd);
  const enabled = runGit(cwd, ['config', '--bool', '--get', 'extensions.worktreeConfig'], {
    allowFailure: true,
  });
  if (enabled.status !== 0 || enabled.stdout.trim() !== 'true') {
    return marker ? { kind: 'missing' } : { kind: 'new' };
  }
  const baseline = readWorktreeValue(cwd, BASELINE_KEY);
  const branch = readWorktreeValue(cwd, BRANCH_KEY);
  const integrity = readWorktreeValue(cwd, INTEGRITY_KEY);
  const started = readWorktreeValue(cwd, STARTED_KEY);
  if (!baseline && !branch && !integrity && !started) {
    return marker ? { kind: 'missing' } : { kind: 'new' };
  }
  if (!marker) return { kind: 'tampered', baseline };
  if (started === 'true' && !baseline) return { kind: 'missing' };
  if (!baseline || !branch || !integrity || started !== 'true') return { kind: 'tampered' };
  if (branch !== diagnosis.current.branch) {
    return { kind: 'branch-mismatch', baseline, branch };
  }
  const expectedIntegrity = baselineIntegrity(
    diagnosis.repository.currentWorktree,
    branch,
    baseline,
  );
  if (integrity !== expectedIntegrity || marker !== integrity) {
    return { kind: 'tampered', baseline };
  }
  return { kind: 'recorded', baseline, branch };
}

function block(diagnosis, status, message, baseline = null) {
  const specificStatuses = Array.isArray(status) ? status : [status];
  return {
    schemaVersion: 1,
    command: 'preflight',
    exitCode: 1,
    mode: 'blocked',
    statuses: [...specificStatuses, 'implementation-preflight-blocked'],
    conclusions: [message],
    repository: diagnosis.repository,
    remoteBaseline: diagnosis.remoteBaseline,
    current: diagnosis.current,
    workingTree: diagnosis.workingTree,
    implementationBaseline: {
      sha: baseline,
      scope: 'worktree',
      worktree: diagnosis.repository.currentWorktree,
    },
  };
}

function writeBaseline(cwd, diagnosis) {
  const sha = diagnosis.remoteBaseline.sha;
  const branch = diagnosis.current.branch;
  runGit(cwd, ['config', 'extensions.worktreeConfig', 'true']);
  runGit(cwd, ['config', '--worktree', BASELINE_KEY, sha]);
  runGit(cwd, ['config', '--worktree', BRANCH_KEY, branch]);
  const integrity = baselineIntegrity(diagnosis.repository.currentWorktree, branch, sha);
  runGit(cwd, [
    'config',
    '--worktree',
    INTEGRITY_KEY,
    integrity,
  ]);
  runGit(cwd, ['config', '--worktree', STARTED_KEY, 'true']);
  writeFileSync(startedMarkerPath(cwd), `${integrity}\n`, { encoding: 'utf8', flag: 'wx' });
}

export function preflight(cwd) {
  const diagnosis = diagnose(cwd);
  if (!diagnosis.remoteBaseline.refresh.latest) {
    return block(diagnosis, 'remote-baseline-unconfirmed', '无法确认最新远端基线，已阻止进入实现阶段。');
  }
  if (diagnosis.remoteBaseline.branch !== diagnosis.remoteBaseline.expectedBranch) {
    return block(
      diagnosis,
      'remote-default-branch-unexpected',
      `远端默认分支为 ${diagnosis.remoteBaseline.branch}；开发集成分支必须为 main。`,
    );
  }
  if (diagnosis.current.detached) {
    return block(
      diagnosis,
      'detached-head',
      'detached worktree 只允许只读检查、Spec 和拆票；请切换到基于最新 origin/main 的干净 codex/* worktree 再实现。',
    );
  }
  if (!diagnosis.current.branch.startsWith('codex/')) {
    return block(diagnosis, 'implementation-branch-disallowed', '实现阶段必须使用 codex/* 命名分支。');
  }
  const dirtyStatuses = Object.entries(diagnosis.workingTree)
    .filter(([, paths]) => paths.length > 0)
    .map(([category]) => `working-tree-${category}`);
  if (dirtyStatuses.length > 0) {
    return block(
      diagnosis,
      [...dirtyStatuses, 'working-tree-dirty'],
      '当前工作树不干净；请先妥善处理全部变更，再进入实现阶段。',
    );
  }

  const baselineState = readBaselineState(cwd, diagnosis);
  if (baselineState.kind === 'missing') {
    return block(
      diagnosis,
      'implementation-baseline-missing',
      '当前 worktree 的实现基线记录缺失，已阻止继续实现。',
    );
  }
  if (baselineState.kind === 'tampered') {
    return block(
      diagnosis,
      'implementation-baseline-tampered',
      '当前 worktree 的实现基线记录完整性校验失败，已阻止继续实现。',
      baselineState.baseline ?? null,
    );
  }
  if (baselineState.kind === 'branch-mismatch') {
    return block(
      diagnosis,
      'implementation-baseline-branch-mismatch',
      `实现基线属于 ${baselineState.branch}，不能用于当前分支。`,
      baselineState.baseline,
    );
  }
  if (baselineState.kind === 'recorded') {
    const recordedBaseline = baselineState.baseline;
    if (!isAncestor(cwd, recordedBaseline, diagnosis.current.head)) {
      return block(
        diagnosis,
        'implementation-baseline-not-ancestor',
        '已记录的实现基线不是当前分支历史的祖先，已阻止继续实现。',
        recordedBaseline,
      );
    }
    const remoteAdvanced = recordedBaseline !== diagnosis.remoteBaseline.sha;
    if (remoteAdvanced && !isAncestor(cwd, recordedBaseline, diagnosis.remoteBaseline.sha)) {
      return block(
        diagnosis,
        'remote-baseline-history-rewritten',
        '远端 main 不再包含已记录的实现基线，已阻止继续实现。',
        recordedBaseline,
      );
    }
    return {
      schemaVersion: 1,
      command: 'preflight',
      exitCode: 0,
      mode: 'continued',
      statuses: [
        'remote-baseline-confirmed',
        ...(remoteAdvanced ? ['remote-baseline-advanced'] : []),
        'implementation-baseline-verified',
        'implementation-preflight-passed',
      ],
      conclusions: [
        ...(remoteAdvanced
          ? ['远端 main 已前移；当前 worktree 仍保持已记录的实现基线，可以继续实现。']
          : []),
        '已验证当前 worktree 的实现基线，可以继续实现。',
      ],
      repository: diagnosis.repository,
      remoteBaseline: diagnosis.remoteBaseline,
      current: diagnosis.current,
      workingTree: diagnosis.workingTree,
      implementationBaseline: {
        sha: recordedBaseline,
        scope: 'worktree',
        worktree: diagnosis.repository.currentWorktree,
      },
    };
  }

  if (!isAncestor(cwd, diagnosis.remoteBaseline.sha, diagnosis.current.head)) {
    return block(
      diagnosis,
      'implementation-start-outdated',
      '当前分支不是基于最新 origin/main 创建；请从最新 origin/main 创建新的干净 codex/* worktree 后重试。',
    );
  }

  writeBaseline(cwd, diagnosis);
  return {
    schemaVersion: 1,
    command: 'preflight',
    exitCode: 0,
    mode: 'initial',
    statuses: [
      'remote-baseline-confirmed',
      'implementation-baseline-recorded',
      'implementation-preflight-passed',
    ],
    conclusions: ['已记录当前 worktree 的实现基线，可以进入实现阶段。'],
    repository: diagnosis.repository,
    remoteBaseline: diagnosis.remoteBaseline,
    current: diagnosis.current,
    workingTree: diagnosis.workingTree,
    implementationBaseline: {
      sha: diagnosis.remoteBaseline.sha,
      scope: 'worktree',
      worktree: diagnosis.repository.currentWorktree,
    },
  };
}
