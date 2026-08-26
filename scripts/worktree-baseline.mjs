#!/usr/bin/env node
import { diagnose } from './worktree-baseline/diagnose.mjs';

function renderHuman(report) {
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
  command === 'diagnose' && args.every((argument) => ['--json', '--offline'].includes(argument));

try {
  if (!validArguments) {
    throw new Error('用法：node scripts/worktree-baseline.mjs diagnose [--json] [--offline]');
  }
  const report = diagnose(process.cwd(), { offline });
  process.stdout.write(json ? `${JSON.stringify(report)}\n` : `${renderHuman(report)}\n`);
  process.exitCode = report.exitCode;
} catch (error) {
  const report = errorReport(
    error,
    command,
    validArguments ? 'diagnosis-failed' : 'invalid-arguments',
  );
  if (json) process.stdout.write(`${JSON.stringify(report)}\n`);
  else process.stderr.write(`无法完成工作树基线诊断：${report.error.message}\n`);
  process.exitCode = report.exitCode;
}
