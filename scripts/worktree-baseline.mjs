#!/usr/bin/env node
import { diagnose } from './worktree-baseline/diagnose.mjs';
import { recovery } from './worktree-baseline/recovery.mjs';
import { preflight } from './worktree-baseline/preflight.mjs';
import { sync } from './worktree-baseline/sync.mjs';

function renderPathSection(title, paths) {
  return [
    `${title}：`,
    ...(paths.length > 0
      ? paths.map((relativePath) => `- ${relativePath.replaceAll('\n', '\\n')}`)
      : ['- （无）']),
  ];
}

function renderDisplayPath(value) {
  return value.replaceAll('\n', '\\n');
}

function renderWorktrees(worktrees, remoteBranch) {
  return [
    '全部 worktree：',
    ...worktrees.map((worktree) => {
      const escapedPath = renderDisplayPath(worktree.path);
      const context = worktree.bare
        ? 'bare'
        : worktree.detached
          ? 'detached HEAD'
          : `分支 ${worktree.branch}`;
      return `- ${escapedPath} | ${context} | HEAD ${worktree.head ?? '未知'} | 相对 origin/${remoteBranch} ${worktree.relationshipToRemote.relation}`;
    }),
  ];
}

function renderHuman(report) {
  if (report.command === 'sync') {
    return [
      '本地 main 安全同步已完成。',
      `开发集成分支提交：${report.result.mainSha}`,
      `恢复分支：${report.result.recoveryBranch}`,
      ...report.conclusions.map((message) => `- ${message}`),
    ].join('\n');
  }
  if (report.command === 'recovery') {
    if (report.applied) {
      return [
        '本地 main 恢复点已创建。',
        `恢复分支：${report.result.recoveryBranch}`,
        `恢复点提交：${report.result.recoveryHeadSha}`,
        ...report.conclusions.map((message) => `- ${message}`),
      ].join('\n');
    }
    return [
      '本地 main 恢复计划已生成，尚未执行。',
      `主工作目录：${renderDisplayPath(report.plan.primaryWorktree)}`,
      `恢复分支：${report.plan.recoveryBranch}`,
      `计划确认值：${report.plan.id}`,
      `原本地 main：${report.plan.oldMainSha}`,
      `目标 origin/main：${report.plan.targetRemoteSha}`,
      ...renderPathSection('已暂存路径', report.plan.trackedChanges.staged),
      ...renderPathSection('未暂存路径', report.plan.trackedChanges.unstaged),
      ...renderPathSection('未跟踪路径', report.plan.untrackedPaths),
      ...renderPathSection('ignored 路径', report.plan.untrackedState.ignoredPaths),
      ...report.conclusions.map((message) => `- ${message}`),
    ].join('\n');
  }
  if (report.command === 'preflight') {
    return [
      report.exitCode === 0 ? '实现阶段基线校验通过。' : '实现阶段基线校验未通过。',
      `当前工作树：${renderDisplayPath(report.repository.currentWorktree)}`,
      ...report.conclusions.map((message) => `- ${message}`),
    ].join('\n');
  }
  return [
    '工作树基线诊断完成。',
    `主工作目录：${renderDisplayPath(report.repository.primaryWorktree)}`,
    `当前工作树：${renderDisplayPath(report.repository.currentWorktree)}`,
    `${report.remoteBaseline.branch} 提交：${report.developmentIntegration.localSha ?? '未知'}`,
    `origin/${report.remoteBaseline.branch} 提交：${report.developmentIntegration.remoteSha ?? '未知'}`,
    `merge base：${report.developmentIntegration.mergeBase ?? '未知'}`,
    `ahead/behind：${report.developmentIntegration.ahead ?? '未知'}/${report.developmentIntegration.behind ?? '未知'}`,
    ...renderWorktrees(report.worktrees, report.remoteBaseline.branch),
    ...renderPathSection('已暂存路径', report.workingTree.staged),
    ...renderPathSection('未暂存路径', report.workingTree.unstaged),
    ...renderPathSection('未跟踪路径', report.workingTree.untracked),
    ...renderPathSection('ignored 路径', report.workingTree.ignored),
    ...report.conclusions.map((message) => `- ${message}`),
  ].join('\n');
}

function errorReport(error, command, kind) {
  const resolvedKind = error.kind ?? kind;
  return {
    schemaVersion: 1,
    command: command ?? null,
    exitCode: error.exitCode ?? 2,
    statuses: [resolvedKind],
    error: {
      kind: resolvedKind,
      message: error.message,
      ...(error.details ? { details: error.details } : {}),
    },
  };
}

function renderHumanError(report, command) {
  if (command === 'sync') {
    return [
      `无法完成本地 main 安全同步：${report.error.message}`,
      ...(report.error.details?.stage
        ? [`失败阶段：${report.error.details.stage}`]
        : []),
      ...(report.error.details?.guidance
        ? [report.error.details.guidance]
        : []),
    ].join('\n');
  }
  if (command === 'preflight') {
    return `无法完成实现阶段基线校验：${report.error.message}`;
  }
  if (command === 'recovery') {
    return [
      `无法完成本地 main 恢复点：${report.error.message}`,
      ...(report.error.details?.stage
        ? [`失败阶段：${report.error.details.stage}`]
        : []),
      ...(report.error.details?.guidance
        ? [report.error.details.guidance]
        : []),
    ].join('\n');
  }
  return `无法完成工作树基线诊断：${report.error.message}`;
}

const [command, ...args] = process.argv.slice(2);
const json = args.includes('--json');
const offline = args.includes('--offline');
function parseMutationArguments(values) {
  const options = { apply: false, confirmation: null, primaryWorktree: null };
  const seen = new Set();
  for (let index = 0; index < values.length; index += 1) {
    const argument = values[index];
    if (argument === '--json') continue;
    if (argument === '--apply') {
      if (seen.has(argument)) return null;
      seen.add(argument);
      options.apply = true;
      continue;
    }
    if (argument === '--confirm' || argument === '--primary-worktree') {
      if (seen.has(argument) || index + 1 >= values.length) return null;
      seen.add(argument);
      const value = values[index + 1];
      if (!value || value.startsWith('--')) return null;
      index += 1;
      if (argument === '--confirm') options.confirmation = value;
      else options.primaryWorktree = value;
      continue;
    }
    return null;
  }
  return options;
}
const mutationOptions = ['recovery', 'sync'].includes(command)
  ? parseMutationArguments(args)
  : null;
const validArguments =
  (command === 'diagnose' && args.every((argument) => ['--json', '--offline'].includes(argument))) ||
  (command === 'recovery' && mutationOptions !== null) ||
  (command === 'sync' && mutationOptions !== null && mutationOptions.apply &&
    mutationOptions.confirmation !== null && mutationOptions.primaryWorktree !== null) ||
  (command === 'preflight' && args.every((argument) => argument === '--json'));

function usageFor(requestedCommand) {
  if (requestedCommand === 'recovery') {
    return '用法：node scripts/worktree-baseline.mjs recovery [--json] [--apply --confirm <计划确认值> --primary-worktree <路径>]';
  }
  if (requestedCommand === 'preflight') {
    return '用法：node scripts/worktree-baseline.mjs preflight [--json]';
  }
  if (requestedCommand === 'sync') {
    return '用法：node scripts/worktree-baseline.mjs sync --apply --confirm <recovery 计划确认值> --primary-worktree <路径> [--json]';
  }
  return '用法：node scripts/worktree-baseline.mjs diagnose [--json] [--offline]';
}

function renderHelp() {
  return [
    'Skill Expert 工作树基线工具',
    '',
    '稳定入口：npm run worktree:baseline -- <命令> [选项]',
    '',
    '命令：',
    '  diagnose [--offline] [--json]  只读诊断；默认只刷新 origin/main 远端跟踪引用',
    '  preflight [--json]             实现前校验；失败时不得进入 /implement',
    '  recovery [--json]              计划预览；不会移动 main',
    '  recovery --apply --confirm <计划确认值> --primary-worktree <路径> [--json]',
    '                                  经人工确认后显式创建本地恢复点',
    '  sync --apply --confirm <计划确认值> --primary-worktree <路径> [--json]',
    '                                  基于 verified recovery 执行显式变更',
    '',
    '退出码：',
    '  0  请求完成且安全条件满足',
    '  1  已完成判断，但被安全门阻止',
    '  2  参数错误或无法安全判断',
  ].join('\n');
}

if (command === 'help' && args.length === 0) {
  process.stdout.write(`${renderHelp()}\n`);
  process.exit(0);
}

try {
  if (!validArguments) {
    throw new Error(usageFor(command));
  }
  const report = command === 'diagnose'
    ? diagnose(process.cwd(), { offline })
    : command === 'recovery'
      ? recovery(process.cwd(), mutationOptions)
      : command === 'sync'
        ? sync(process.cwd(), mutationOptions)
        : preflight(process.cwd());
  process.stdout.write(json ? `${JSON.stringify(report)}\n` : `${renderHuman(report)}\n`);
  process.exitCode = report.exitCode;
} catch (error) {
  const report = errorReport(
    error,
    command,
    validArguments
      ? command === 'recovery'
        ? 'recovery-failed'
        : command === 'sync'
          ? 'sync-failed'
        : command === 'preflight'
          ? 'preflight-failed'
          : 'diagnosis-failed'
      : 'invalid-arguments',
  );
  if (json) process.stdout.write(`${JSON.stringify(report)}\n`);
  else process.stderr.write(`${renderHumanError(report, command)}\n`);
  process.exitCode = report.exitCode;
}
