#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import {
  nextDevelopmentVersion,
  nextPatchVersion,
  parseProductVersion,
} from './product-version.mjs';

function fail(message) {
  throw new Error(message);
}

function parseArguments(argv) {
  const [command, ...rest] = argv;
  const options = { json: false };
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (argument === '--json') {
      options.json = true;
      continue;
    }
    if (!argument.startsWith('--') || index + 1 >= rest.length) {
      fail(`无效参数：${argument}`);
    }
    options[argument.slice(2).replaceAll('-', '_')] = rest[index + 1];
    index += 1;
  }
  return { command, options };
}

function git(args) {
  const result = spawnSync('git', args, { encoding: 'utf8' });
  if (result.status !== 0) {
    fail(result.stderr.trim() || `git ${args.join(' ')} 执行失败`);
  }
  return result.stdout.trim();
}

function versionAt(ref, label) {
  let parsed;
  try {
    parsed = JSON.parse(git(['show', `${ref}:package.json`]));
  } catch (error) {
    fail(`无法读取${label} ${ref} 的 package.json：${error.message}`);
  }
  return parseVersion(parsed.version, label);
}

function parseVersion(value, label) {
  const parsed = parseProductVersion(value);
  if (!parsed) {
    fail(`${label}版本必须是 x.y.z 或开发序号 x.y.z-N，实际为 ${value ?? '缺失'}`);
  }
  return parsed;
}

function expectedDevelopmentVersion(base, release) {
  if (release.development !== null) {
    fail(`release 必须使用正式版本，实际为 ${release.raw}`);
  }
  if (base.stable !== release.raw) {
    fail(
      `普通 main PR 的版本线必须基于当前 release ${release.raw}，实际基线为 ${base.raw}`,
    );
  }
  return nextDevelopmentVersion(base);
}

function verifyReleaseVersionTransition(base, head, release) {
  if (release.development !== null) {
    fail(`release 必须使用正式版本，实际为 ${release.raw}`);
  }
  if (base.stable !== release.raw || base.development === null) {
    fail(
      `发布准备 PR 必须从当前 release ${release.raw} 的开发序号进入正式版本，实际基线为 ${base.raw}`,
    );
  }
  const expectedVersion = nextPatchVersion(release);
  if (head.raw !== expectedVersion || head.development !== null) {
    fail(`发布准备 PR 必须把版本从 ${base.raw} 升级为 ${expectedVersion}，实际为 ${head.raw}`);
  }
  return expectedVersion;
}

function verifyReleasePreparation(base, head, release, headRef) {
  const expectedVersion = verifyReleaseVersionTransition(base, head, release);
  const expectedRef = `release-prep/v${expectedVersion}`;
  if (headRef !== expectedRef) {
    fail(`发布准备分支必须是 ${expectedRef}，实际为 ${headRef}`);
  }
  return expectedVersion;
}

function verifyReleasePreparationSource(headRef, headRepository, expectedRepository) {
  if (headRef.startsWith('release-prep/') && headRepository !== expectedRepository) {
    fail(
      `发布准备 PR 必须来自当前仓库 ${expectedRepository}，实际来自 ${headRepository}`,
    );
  }
}

function verifyMainPr(options) {
  const {
    base_sha: baseSha,
    head_sha: headSha,
    head_ref: headRef,
    head_repository: headRepository,
    expected_repository: expectedRepository,
    release_ref: releaseRef,
  } = options;
  if (
    !baseSha ||
    !headSha ||
    !headRef ||
    !headRepository ||
    !expectedRepository ||
    !releaseRef
  ) {
    fail(
      'verify-main-pr 需要 --base-sha、--head-sha、--head-ref、--head-repository、--expected-repository 和 --release-ref',
    );
  }
  const base = versionAt(baseSha, 'main 基线');
  const head = versionAt(headSha, 'PR');
  const release = versionAt(releaseRef, 'release');
  verifyReleasePreparationSource(headRef, headRepository, expectedRepository);
  if (headRef.startsWith('release-prep/')) {
    const expectedVersion = verifyReleasePreparation(base, head, release, headRef);
    return {
      schemaVersion: 1,
      command: 'verify-main-pr',
      channel: 'release',
      baseVersion: base.raw,
      headVersion: head.raw,
      releaseVersion: release.raw,
      expectedVersion,
      releaseCandidate: true,
    };
  }

  const expectedVersion = expectedDevelopmentVersion(base, release);
  if (head.raw !== expectedVersion) {
    fail(`普通 main PR 必须把版本从 ${base.raw} 递增为 ${expectedVersion}，实际为 ${head.raw}`);
  }

  return {
    schemaVersion: 1,
    command: 'verify-main-pr',
    channel: 'development',
    baseVersion: base.raw,
    headVersion: head.raw,
    releaseVersion: release.raw,
    expectedVersion,
    releaseCandidate: false,
  };
}

function verifyMainPush(options) {
  const { before_sha: beforeSha, head_sha: headSha, release_ref: releaseRef } = options;
  if (!beforeSha || !headSha || !releaseRef) {
    fail('verify-main-push 需要 --before-sha、--head-sha 和 --release-ref');
  }
  const base = versionAt(beforeSha, 'main 合入前');
  const head = versionAt(headSha, 'main 合入后');
  const release = versionAt(releaseRef, 'release');
  if (head.development === null) {
    const expectedVersion = verifyReleaseVersionTransition(base, head, release);
    return {
      schemaVersion: 1,
      command: 'verify-main-push',
      channel: 'release',
      baseVersion: base.raw,
      headVersion: head.raw,
      releaseVersion: release.raw,
      expectedVersion,
      releaseCandidate: true,
    };
  }
  const expectedVersion = expectedDevelopmentVersion(base, release);
  if (head.raw !== expectedVersion) {
    fail(`main 必须把版本从 ${base.raw} 递增为 ${expectedVersion}，实际为 ${head.raw}`);
  }
  return {
    schemaVersion: 1,
    command: 'verify-main-push',
    channel: 'development',
    baseVersion: base.raw,
    headVersion: head.raw,
    releaseVersion: release.raw,
    expectedVersion,
    releaseCandidate: false,
  };
}

function renderHuman(report) {
  if (report.releaseCandidate) {
    return [
      `正式版本准备校验通过：${report.baseVersion} → ${report.headVersion}。`,
      `合入 main 后将触发 Skill Expert ${report.headVersion} 的四平台候选构建。`,
    ].join('\n');
  }
  return [
    `版本通道校验通过：${report.baseVersion} → ${report.headVersion}。`,
    `当前 release 为 ${report.releaseVersion}；本次不会触发正式候选构建。`,
  ].join('\n');
}

function main() {
  try {
    const { command, options } = parseArguments(process.argv.slice(2));
    const report =
      command === 'verify-main-pr'
        ? verifyMainPr(options)
        : command === 'verify-main-push'
          ? verifyMainPush(options)
          : fail(
              '用法：version-policy.mjs <verify-main-pr|verify-main-push> [参数] [--json]',
            );
    console.log(options.json ? JSON.stringify(report) : renderHuman(report));
  } catch (error) {
    console.error(`版本通道校验失败：${error.message}`);
    process.exitCode = 1;
  }
}

main();
