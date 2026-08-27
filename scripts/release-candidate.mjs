#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkVersionConsistency } from './check-version-consistency.mjs';
import { nextPatchVersion, parseProductVersion } from './product-version.mjs';

const DEFAULT_RELEASE_BASELINE_SHA = 'e7ed2157726b50b585ee0c53df61870a12cd9893';

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
      fail(`Invalid argument: ${argument}`);
    }
    options[argument.slice(2).replaceAll('-', '_')] = rest[index + 1];
    index += 1;
  }

  return { command, options };
}

function git(args, { allowFailure = false } = {}) {
  const result = spawnSync('git', args, { encoding: 'utf8' });
  if (!allowFailure && result.status !== 0) {
    fail(result.stderr.trim() || `git ${args.join(' ')} failed`);
  }
  return result;
}

function resolveBranch(branch) {
  const originLookup = git(['remote', 'get-url', 'origin'], { allowFailure: true });
  if (originLookup.status === 0) {
    const remoteBranch = git(
      ['ls-remote', '--exit-code', '--heads', 'origin', `refs/heads/${branch}`],
      { allowFailure: true },
    );
    if (remoteBranch.status === 0) return remoteBranch.stdout.trim().split(/\s+/)[0];
    if (remoteBranch.status === 2) fail(`Unable to resolve branch ${branch} on origin`);
    fail(`Unable to inspect branch ${branch} on origin`);
  }
  for (const ref of [`refs/heads/${branch}`, `refs/remotes/origin/${branch}`]) {
    const localBranch = git(['rev-parse', '--verify', `${ref}^{commit}`], { allowFailure: true });
    if (localBranch.status === 0) return localBranch.stdout.trim();
  }
  fail(`Unable to resolve branch ${branch}`);
}

function parseStableVersion(version, label) {
  const parsed = parseProductVersion(version);
  if (!parsed || parsed.development !== null) {
    fail(`${label}必须是稳定 SemVer x.y.z，实际为 ${version ?? '缺失'}`);
  }
  return parsed;
}

function packageAt(ref) {
  const result = git(['show', `${ref}:package.json`]);
  try {
    return JSON.parse(result.stdout);
  } catch {
    fail(`package.json at ${ref} is not valid JSON`);
  }
}

function isAncestor(ancestor, descendant) {
  const result = git(['merge-base', '--is-ancestor', ancestor, descendant], {
    allowFailure: true,
  });
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  fail(`无法核对提交祖先关系：${ancestor} → ${descendant}`);
}

function releaseBaselineSha() {
  const baselineSha =
    process.env.SKILL_EXPERT_RELEASE_BASELINE_SHA ?? DEFAULT_RELEASE_BASELINE_SHA;
  if (!/^[0-9a-f]{40}$/.test(baselineSha)) {
    fail('release 固定基线必须是完整的小写 40 位提交 SHA');
  }
  const resolved = git(['rev-parse', '--verify', `${baselineSha}^{commit}`], {
    allowFailure: true,
  });
  if (resolved.status !== 0 || resolved.stdout.trim() !== baselineSha) {
    fail(`无法解析 release 固定基线 ${baselineSha}`);
  }
  return baselineSha;
}

function verifyPromotionBase(baseSha, candidateSha, base) {
  const baselineSha = releaseBaselineSha();
  let releaseCursor = baseSha;
  let newerCandidateSha = candidateSha;
  const visited = new Set();

  while (releaseCursor !== baselineSha) {
    if (visited.has(releaseCursor)) fail(`${base} 第一父历史出现循环`);
    visited.add(releaseCursor);

    const revision = git(['rev-list', '--parents', '-n', '1', releaseCursor])
      .stdout.trim()
      .split(/\s+/);
    if (revision.length !== 3) {
      fail(`${base} 第一父历史只能包含合法的双父晋级 merge commit`);
    }

    const firstParentSha = revision[1];
    const previousCandidateSha = revision[2];
    const releaseTree = git(['rev-parse', `${releaseCursor}^{tree}`]).stdout.trim();
    const previousCandidateTree = git(['rev-parse', `${previousCandidateSha}^{tree}`])
      .stdout.trim();
    if (releaseTree !== previousCandidateTree) {
      fail(`${base} 的树必须与上一次晋级的 main 候选完全一致`);
    }
    if (!isAncestor(previousCandidateSha, newerCandidateSha)) {
      fail(
        `较旧的晋级候选 ${previousCandidateSha} 必须是下一次晋级候选 ${newerCandidateSha} 的祖先`,
      );
    }

    newerCandidateSha = previousCandidateSha;
    releaseCursor = firstParentSha;
  }

  if (!isAncestor(baselineSha, newerCandidateSha)) {
    fail(`最早的晋级候选必须从 release 固定基线 ${baselineSha} 继续开发`);
  }
}

function releaseNotes(content, version) {
  const escapedVersion = version.replaceAll('.', '\\.');
  const heading = new RegExp(
    `^## \\[${escapedVersion}\\](?:\\s+-\\s+\\d{4}-\\d{2}-\\d{2})?\\s*$`,
    'm',
  ).exec(content);
  if (!heading) return '';
  const bodyStart = heading.index + heading[0].length;
  const remaining = content.slice(bodyStart);
  const nextHeading = /^## \[/m.exec(remaining);
  return remaining.slice(0, nextHeading?.index ?? remaining.length).trim();
}

export function verifyCandidate(options) {
  const { candidate_sha: candidateSha, head, base } = options;
  if (!candidateSha || !head || !base) {
    fail('verify requires --candidate-sha, --head, and --base');
  }
  if (head !== 'main' || base !== 'release') {
    fail('release promotion must use head=main and base=release');
  }
  if (!/^[0-9a-f]{40}$/.test(candidateSha)) {
    fail('candidate SHA must be a full lowercase 40-character commit SHA');
  }

  const checkoutSha = git(['rev-parse', 'HEAD^{commit}']).stdout.trim();
  if (checkoutSha !== candidateSha) {
    fail(`checked-out HEAD ${checkoutSha} does not match candidate SHA ${candidateSha}`);
  }
  let baseSha;
  if (options.approved_release_sha) {
    const releaseSha = options.approved_release_sha;
    const previousReleaseSha = options.previous_release_sha;
    if (!/^[0-9a-f]{40}$/.test(releaseSha) || !/^[0-9a-f]{40}$/.test(previousReleaseSha ?? '')) {
      fail('已批准发布恢复必须提供完整的 release SHA 与 previous release SHA');
    }
    const parents = git(['show', '-s', '--format=%P', releaseSha]).stdout.trim().split(/\s+/);
    if (
      parents.length !== 2 ||
      parents[0] !== previousReleaseSha ||
      parents[1] !== candidateSha
    ) {
      fail('已批准 release merge 的双亲与候选绑定不一致');
    }
    const releaseTree = git(['rev-parse', `${releaseSha}^{tree}`]).stdout.trim();
    const candidateTree = git(['rev-parse', `${candidateSha}^{tree}`]).stdout.trim();
    if (releaseTree !== candidateTree) {
      fail('已批准 release merge 的 tree 与候选 tree 不一致');
    }
    baseSha = previousReleaseSha;
  } else {
    const headSha = resolveBranch(head);
    baseSha = resolveBranch(base);
    if (candidateSha !== headSha) {
      fail(`candidate SHA ${candidateSha} is stale; ${head} is ${headSha}`);
    }
  }
  verifyPromotionBase(baseSha, candidateSha, base);

  const manifest = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  parseStableVersion(manifest.version, '候选版本');
  const { version, mismatches } = checkVersionConsistency(process.cwd());
  if (mismatches.length > 0) {
    fail(`candidate version contract is inconsistent:\n- ${mismatches.join('\n- ')}`);
  }
  const changelogErrors = [];
  for (const file of ['CHANGELOG.md', 'CHANGELOG-zh.md']) {
    const notes = releaseNotes(fs.readFileSync(file, 'utf8'), version);
    if (!/^-[ \t]+\S/m.test(notes)) {
      changelogErrors.push(`${file} release ${version} must contain a non-empty bullet`);
    }
  }
  if (changelogErrors.length > 0) {
    fail(`candidate changelogs are empty:\n- ${changelogErrors.join('\n- ')}`);
  }
  const basePackage = packageAt(baseSha);
  if (basePackage.name === 'skill-expert') {
    const baseVersion = parseStableVersion(basePackage.version, 'release 分支版本');
    const expectedVersion = nextPatchVersion(baseVersion);
    if (version !== expectedVersion) {
      fail(
        `正式候选版本 ${version} 必须是 release 版本 ${basePackage.version} 的下一补丁版本；预期 ${expectedVersion}`,
      );
    }
  } else if (manifest.name !== 'skill-expert' || version !== '1.0.0') {
    fail('a legacy release baseline can only promote the Skill Expert 1.0.0 bootstrap');
  }

  const tag = `v${version}`;
  const originLookup = git(['remote', 'get-url', 'origin'], { allowFailure: true });
  const hasOrigin = originLookup.status === 0;
  if (!options.approved_release_sha) {
    const tagLookup = git(['show-ref', '--verify', '--quiet', `refs/tags/${tag}`], {
      allowFailure: true,
    });
    if (tagLookup.status === 0) fail(`tag ${tag} already exists`);
    if (tagLookup.status !== 1) fail(`unable to inspect tag ${tag}`);
    if (hasOrigin) {
      const remoteTagLookup = git(
        ['ls-remote', '--exit-code', '--tags', '--refs', 'origin', `refs/tags/${tag}`],
        { allowFailure: true },
      );
      if (remoteTagLookup.status === 0) fail(`tag ${tag} already exists on origin`);
      if (remoteTagLookup.status !== 2) fail(`unable to inspect tag ${tag} on origin`);
    }
  }

  return {
    version,
    tag,
    candidateSha,
    baseSha,
    commitRange: `${baseSha}..${candidateSha}`,
    tagAbsence: options.approved_release_sha
      ? 'tag 身份已由 release merge 恢复契约验证'
      : hasOrigin
        ? `refs/tags/${tag} 在本地和 origin 均不存在`
        : `refs/tags/${tag} 在本地不存在（未配置 origin）`,
  };
}

export function renderPrBody(options) {
  if (!options.output) fail('render-pr-body requires --output');
  const candidate = verifyCandidate(options);
  const englishNotes = releaseNotes(fs.readFileSync('CHANGELOG.md', 'utf8'), candidate.version);
  const chineseNotes = releaseNotes(fs.readFileSync('CHANGELOG-zh.md', 'utf8'), candidate.version);
  const body = `# 发布晋级：Skill Expert v${candidate.version}

> [!IMPORTANT]
> **合并即批准正式发布。** 合并这一个 \`main\` → \`release\` PR，就是发布该精确候选的唯一批准。
>
> **必须使用 merge commit。** 普通功能 PR 仍可使用 squash；本规则只适用于 Release PR。

## 候选身份

- 版本：\`${candidate.version}\`
- Candidate SHA：\`${candidate.candidateSha}\`
- 提交范围：\`${candidate.commitRange}\`（\`release..main\`）
- 晋级方向：\`head=main\` → \`base=release\`

## 英文 Changelog 条目

${englishNotes}

## 发布说明（中文）

${chineseNotes}

## 候选四平台矩阵

| 目标 | 桌面安装包 | Updater 结构 | 独立 CLI | 结果 |
| --- | --- | --- | --- | --- |
| macOS arm64 | app、DMG | app archive 与签名 | skill-expert-cli | 通过 |
| macOS x64 | app、DMG | app archive 与签名 | skill-expert-cli | 通过 |
| Windows x64 | NSIS、MSI | 安装包签名 | skill-expert-cli.exe | 通过 |
| Linux x64 | AppImage、DEB、RPM | AppImage 签名 | skill-expert-cli | 通过 |

## macOS 分发边界

macOS 候选使用 **ad-hoc 签名**且**未经 Apple 公证**。Gatekeeper 可能要求进入**系统设置 → 隐私与安全性 → 仍要打开**。这些检查只证明包结构和签名完整性，不代表通过 Gatekeeper 或 Apple 公证。

## 验证结果

- 日常 main CI：\`${candidate.candidateSha}\` 已通过。
- 候选门禁：精确 \`head=main\`、\`base=release\` 和当前 main SHA 已通过。
- 四平台候选打包：上述精确 candidate SHA 已通过。
- 版本一致性：manifest、lockfile、Tauri、Rust、UI locale 和双语 Changelog 已通过。
- 稳定版本：\`${candidate.version}\` 是三段式 SemVer。
- tag 不存在证明：\`${candidate.tagAbsence}\`。

本 PR 由同一 main SHA 上成功的候选 run 创建或刷新，不依赖自身 \`GITHUB_TOKEN\` 触发的 \`pull_request\` 事件。
`;
  fs.writeFileSync(options.output, body);
  return candidate;
}

function main() {
  try {
    const { command, options } = parseArguments(process.argv.slice(2));
    if (command === 'render-pr-body') {
      const result = renderPrBody(options);
      console.log(`已为 ${result.candidateSha} 生成 v${result.version} 的发布晋级正文。`);
      return;
    }
    if (command !== 'verify') {
      fail('Usage: release-candidate.mjs <verify|render-pr-body> --candidate-sha <sha> --head main --base release');
    }
    const result = verifyCandidate(options);
    if (options.json) {
      process.stdout.write(`${JSON.stringify(result)}\n`);
      return;
    }
    console.log(`正式候选 v${result.version} 已通过验证：${result.candidateSha}`);
  } catch (error) {
    console.error(`正式候选验证失败：${error.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
