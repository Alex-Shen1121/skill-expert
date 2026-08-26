#!/usr/bin/env node
import { diagnose } from './worktree-baseline/diagnose.mjs';
import { recovery } from './worktree-baseline/recovery.mjs';

function renderPathSection(title, paths) {
  return [
    `${title}：`,
    ...(paths.length > 0
      ? paths.map((relativePath) => `- ${relativePath.replaceAll('\n', '\\n')}`)
      : ['- （无）']),
  ];
}

function renderHuman(report) {
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
      `主工作目录：${report.plan.primaryWorktree}`,
      `恢复分支：${report.plan.recoveryBranch}`,
      `计划确认值：${report.plan.id}`,
      `原本地 main：${report.plan.oldMainSha}`,
      `目标 origin/main：${report.plan.targetRemoteSha}`,
      ...renderPathSection('已暂存路径', report.plan.trackedChanges.staged),
      ...renderPathSection('未暂存路径', report.plan.trackedChanges.unstaged),
      ...renderPathSection('未跟踪路径', report.plan.untrackedPaths),
      ...report.conclusions.map((message) => `- ${message}`),
    ].join('\n');
  }
  return [
    '工作树基线诊断完成。',
    `主工作目录：${report.repository.primaryWorktree}`,
    `当前工作树：${report.repository.currentWorktree}`,
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

const [command, ...args] = process.argv.slice(2);
const json = args.includes('--json');
const offline = args.includes('--offline');
function parseRecoveryArguments(values) {
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
const recoveryOptions = command === 'recovery' ? parseRecoveryArguments(args) : null;
const validArguments =
  (command === 'diagnose' && args.every((argument) => ['--json', '--offline'].includes(argument))) ||
  (command === 'recovery' && recoveryOptions !== null);

try {
  if (!validArguments) {
    throw new Error(command === 'recovery'
      ? '用法：node scripts/worktree-baseline.mjs recovery [--json] [--apply --confirm <计划确认值> --primary-worktree <路径>]'
      : '用法：node scripts/worktree-baseline.mjs diagnose [--json] [--offline]');
  }
  const report = command === 'diagnose'
    ? diagnose(process.cwd(), { offline })
    : recovery(process.cwd(), recoveryOptions);
  process.stdout.write(json ? `${JSON.stringify(report)}\n` : `${renderHuman(report)}\n`);
  process.exitCode = report.exitCode;
} catch (error) {
  const report = errorReport(
    error,
    command,
    validArguments
      ? command === 'recovery' ? 'recovery-failed' : 'diagnosis-failed'
      : 'invalid-arguments',
  );
  if (json) process.stdout.write(`${JSON.stringify(report)}\n`);
  else process.stderr.write(
    `${command === 'recovery' ? '无法完成本地 main 恢复点' : '无法完成工作树基线诊断'}：${report.error.message}\n`,
  );
  process.exitCode = report.exitCode;
}
