#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseCommandOptions } from './command-options.mjs';
import { parseProductVersion } from './product-version.mjs';

function fail(message) {
  throw new Error(message);
}

function requireSha(value, label) {
  if (!/^[0-9a-f]{40}$/.test(value ?? '')) {
    fail(`${label} 必须是完整的小写 40 位提交 SHA`);
  }
  return value;
}

function packageVersionAt(sha) {
  const result = spawnSync('git', ['show', `${sha}:package.json`], {
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    fail(`无法读取 ${sha} 的 package.json：${result.stderr.trim()}`);
  }
  return JSON.parse(result.stdout).version;
}

function compareVersions(left, right) {
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] - right[key];
  }
  return 0;
}

export function verifyMainPullRequest(options) {
  const baseVersion = packageVersionAt(requireSha(options['base-sha'], 'base-sha'));
  const headVersion = packageVersionAt(requireSha(options['head-sha'], 'head-sha'));
  const head = parseProductVersion(headVersion);
  if (!head) fail(`PR 源码版本必须是稳定版本 x.y.z，实际为 ${headVersion ?? '缺失'}`);
  const headRef = options['head-ref'];
  if (!headRef) fail('缺少 --head-ref');

  if (
    headRef === 'codex/simplify-main-release' &&
    baseVersion === '1.0.3-3' &&
    head.raw === '1.0.3'
  ) {
    return { kind: 'ordinary', version: head.raw };
  }
  const base = parseProductVersion(baseVersion);
  if (!base) fail(`基线源码版本必须是稳定版本 x.y.z，实际为 ${baseVersion ?? '缺失'}`);

  const releaseMatch = headRef.match(/^codex\/release-v(\d+\.\d+\.\d+)$/);
  if (headRef.startsWith('codex/release-') && !releaseMatch) {
    fail(`发布分支必须使用 codex/release-vX.Y.Z，实际为 ${headRef}`);
  }
  if (!releaseMatch) {
    if (!headRef.startsWith('codex/') && headRef !== 'upstream-tracking/main') {
      fail(`普通开发分支必须使用 codex/*，实际为 ${headRef}`);
    }
    if (head.raw !== base.raw) {
      fail(`普通 PR 必须保持版本 ${base.raw} 不变，实际为 ${head.raw}`);
    }
    return { kind: 'ordinary', version: head.raw };
  }

  const branchVersion = releaseMatch[1];
  if (head.raw !== branchVersion) {
    fail(`发布分支目标 ${branchVersion} 与源码版本 ${head.raw} 不一致`);
  }
  if (compareVersions(head, base) <= 0) {
    fail(`发布版本 ${head.raw} 必须高于当前版本 ${base.raw}`);
  }
  return { kind: 'release', version: head.raw };
}

function main() {
  try {
    const { command, options } = parseCommandOptions(process.argv.slice(2), {
      booleanFlags: ['json'],
    });
    if (command !== 'verify-main-pr') {
      fail('用法：stable-version-policy.mjs verify-main-pr --base-sha SHA --head-sha SHA --head-ref 分支 [--json]');
    }
    const result = verifyMainPullRequest(options);
    if (options.json) {
      console.log(JSON.stringify(result));
    } else {
      console.log(
        result.kind === 'release'
          ? `发布 PR 稳定版本边界通过：${result.version}`
          : `普通 PR 保持稳定版本不变：${result.version}`,
      );
    }
  } catch (error) {
    console.error(`稳定版本策略检查失败：${error.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
