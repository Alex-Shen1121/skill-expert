#!/usr/bin/env node
import { diagnose } from './worktree-baseline/diagnose.mjs';
import { preflight } from './worktree-baseline/preflight.mjs';

function renderHuman(report) {
  if (report.command === 'preflight') {
    return [
      report.exitCode === 0 ? '实现阶段基线校验通过。' : '实现阶段基线校验未通过。',
      `当前工作树：${report.repository.currentWorktree}`,
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
  return {
    schemaVersion: 1,
    command: command ?? null,
    exitCode: 2,
    statuses: [kind],
    error: { kind, message: error.message },
  };
}

const [command, ...args] = process.argv.slice(2);
const json = args.includes('--json');
const offline = args.includes('--offline');
const validArguments =
  (command === 'diagnose' && args.every((argument) => ['--json', '--offline'].includes(argument))) ||
  (command === 'preflight' && args.every((argument) => argument === '--json'));

function usageFor(requestedCommand) {
  return requestedCommand === 'preflight'
    ? '用法：node scripts/worktree-baseline.mjs preflight [--json]'
    : '用法：node scripts/worktree-baseline.mjs diagnose [--json] [--offline]';
}

try {
  if (!validArguments) {
    throw new Error(usageFor(command));
  }
  const report = command === 'diagnose'
    ? diagnose(process.cwd(), { offline })
    : preflight(process.cwd());
  process.stdout.write(json ? `${JSON.stringify(report)}\n` : `${renderHuman(report)}\n`);
  process.exitCode = report.exitCode;
} catch (error) {
  const report = errorReport(
    error,
    command,
    validArguments
      ? command === 'preflight' ? 'preflight-failed' : 'diagnosis-failed'
      : 'invalid-arguments',
  );
  if (json) process.stdout.write(`${JSON.stringify(report)}\n`);
  else process.stderr.write(
    command === 'preflight'
      ? `无法完成实现阶段基线校验：${report.error.message}\n`
      : `无法完成工作树基线诊断：${report.error.message}\n`,
  );
  process.exitCode = report.exitCode;
}
