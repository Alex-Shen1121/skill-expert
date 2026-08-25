#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkVersionConsistency } from './check-version-consistency.mjs';

const FULL_SHA = /^[0-9a-f]{40}$/;
const GITHUB_RUN_ID = /^[1-9]\d*$/;

function fail(message) {
  throw new Error(message);
}

function git(args, { allowFailure = false } = {}) {
  const result = spawnSync('git', args, { encoding: 'utf8' });
  if (!allowFailure && result.status !== 0) {
    fail(result.stderr.trim() || `git ${args.join(' ')} 执行失败`);
  }
  return result;
}

function parseArguments(argv) {
  const [command, ...rest] = argv;
  const options = { json: false, allow_existing_tag: false };
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (argument === '--json') {
      options.json = true;
      continue;
    }
    if (argument === '--allow-existing-tag') {
      options.allow_existing_tag = true;
      continue;
    }
    if (!argument?.startsWith('--') || index + 1 >= rest.length) {
      fail(`无效参数：${argument ?? '空值'}`);
    }
    options[argument.slice(2).replaceAll('-', '_')] = rest[index + 1];
    index += 1;
  }
  return { command, options };
}

function requireSha(value, label) {
  if (!FULL_SHA.test(value ?? '')) fail(`${label} 必须是完整的小写 40 位 commit SHA`);
  const lookup = git(['rev-parse', '--verify', `${value}^{commit}`], { allowFailure: true });
  if (lookup.status !== 0) fail(`无法解析 ${label}：${value}`);
}

function releaseNotes(content, version) {
  const escapedVersion = version.replaceAll('.', '\\.');
  const heading = new RegExp(
    `^## \\[${escapedVersion}\\](?:\\s+-\\s+\\d{4}-\\d{2}-\\d{2})?\\s*$`,
    'm',
  ).exec(content);
  if (!heading) return '';
  const rest = content.slice(heading.index + heading[0].length);
  const next = /^## \[/m.exec(rest);
  return rest.slice(0, next?.index ?? rest.length).trim();
}

export function verifyReleaseMerge(options, root = process.cwd()) {
  const releaseSha = options.release_sha;
  const candidateSha = options.candidate_sha;
  const previousReleaseSha = options.previous_release_sha;
  requireSha(releaseSha, 'release SHA');
  requireSha(candidateSha, 'candidate SHA');
  requireSha(previousReleaseSha, 'previous release SHA');

  const checkoutSha = git(['rev-parse', 'HEAD^{commit}']).stdout.trim();
  if (checkoutSha !== releaseSha) {
    fail(`当前 checkout ${checkoutSha} 不等于 release SHA ${releaseSha}`);
  }

  const parents = git(['show', '-s', '--format=%P', releaseSha]).stdout.trim().split(/\s+/);
  if (parents.length !== 2) fail('release HEAD 必须是恰好包含两个父提交的 merge commit');
  if (parents[0] !== previousReleaseSha) {
    fail(`第一父提交必须是 previous release SHA ${previousReleaseSha}`);
  }
  if (parents[1] !== candidateSha) {
    fail(`第二父提交必须是 candidate SHA ${candidateSha}`);
  }

  const releaseTree = git(['rev-parse', `${releaseSha}^{tree}`]).stdout.trim();
  const candidateTree = git(['rev-parse', `${candidateSha}^{tree}`]).stdout.trim();
  if (releaseTree !== candidateTree) {
    fail('release 合并结果的文件树必须与已批准 candidate 完全一致');
  }

  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (manifest.name !== 'skill-expert') fail('正式发布 package name 必须是 skill-expert');
  const { version, mismatches } = checkVersionConsistency(root);
  if (mismatches.length > 0) {
    fail(`正式发布版本契约不一致：\n- ${mismatches.join('\n- ')}`);
  }
  for (const changelog of ['CHANGELOG.md', 'CHANGELOG-zh.md']) {
    const notes = releaseNotes(fs.readFileSync(path.join(root, changelog), 'utf8'), version);
    if (!/^-[ \t]+\S/m.test(notes)) {
      fail(`${changelog} 的 ${version} 发布说明必须包含非空条目`);
    }
  }

  const tag = `v${version}`;
  if (options.allow_existing_tag && !GITHUB_RUN_ID.test(options.recovery_run_id ?? '')) {
    fail('允许已有 tag 时必须提供有效的 --recovery-run-id');
  }
  const localTag = git(['show-ref', '--verify', '--quiet', `refs/tags/${tag}`], {
    allowFailure: true,
  });
  let tagExists = false;
  const origin = git(['remote', 'get-url', 'origin'], { allowFailure: true });
  if (localTag.status === 0) {
    if (!options.allow_existing_tag) fail(`tag ${tag} 已存在`);
    const tagType = git(['cat-file', '-t', `refs/tags/${tag}`]).stdout.trim();
    const taggedCommit = git(['rev-parse', `refs/tags/${tag}^{commit}`]).stdout.trim();
    if (tagType !== 'tag' || taggedCommit !== releaseSha || origin.status !== 0) {
      fail(`恢复用 tag ${tag} 必须是指向同一 release SHA 的 annotated tag`);
    }
    const localTagObject = git(['rev-parse', `refs/tags/${tag}`]).stdout.trim();
    const remoteTag = git(
      ['ls-remote', '--exit-code', '--tags', '--refs', 'origin', `refs/tags/${tag}`],
      { allowFailure: true },
    );
    const remoteTagObject = remoteTag.stdout.trim().split(/\s+/)[0];
    if (remoteTag.status !== 0 || remoteTagObject !== localTagObject) {
      fail(`恢复用 tag ${tag} 必须是指向同一 release SHA 的远端 annotated tag`);
    }
    const tagMessage = git([
      'for-each-ref',
      '--format=%(contents)',
      `refs/tags/${tag}`,
    ]).stdout.trim();
    const expectedTagMessage = `Skill Expert ${tag}\nworkflow-run-id: ${options.recovery_run_id}`;
    if (tagMessage !== expectedTagMessage) {
      fail(`恢复用 tag ${tag} 必须由同一 workflow run ${options.recovery_run_id} 创建`);
    }
    tagExists = true;
  } else {
    if (localTag.status !== 1) fail(`无法检查本地 tag ${tag}`);
    if (origin.status === 0) {
      const remoteTag = git(
        ['ls-remote', '--exit-code', '--tags', '--refs', 'origin', `refs/tags/${tag}`],
        { allowFailure: true },
      );
      if (remoteTag.status === 0) fail(`tag ${tag} 已存在于 origin`);
      if (remoteTag.status !== 2) fail(`无法检查 origin 上的 tag ${tag}`);
    }
  }

  return { version, tag, releaseSha, candidateSha, previousReleaseSha, tagExists };
}

function main() {
  try {
    const { command, options } = parseArguments(process.argv.slice(2));
    if (command !== 'verify') {
      fail(
        '用法：release-merge.mjs verify --release-sha SHA --candidate-sha SHA --previous-release-sha SHA [--json] [--allow-existing-tag --recovery-run-id ID]',
      );
    }
    const result = verifyReleaseMerge(options);
    if (options.json) {
      process.stdout.write(`${JSON.stringify(result)}\n`);
      return;
    }
    console.log(`release 合并身份验证通过：${result.tag} @ ${result.releaseSha}`);
  } catch (error) {
    console.error(`release 合并身份验证失败：${error.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
