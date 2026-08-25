#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

import { checkVersionConsistency } from './check-version-consistency.mjs';

const STABLE_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
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
  const match = version?.match(STABLE_SEMVER);
  if (!match) fail(`${label} must be a stable SemVer x.y.z, found ${version ?? 'missing'}`);
  return match.slice(1).map(Number);
}

function compareVersions(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
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

function verifyCandidate(options) {
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

  const headSha = resolveBranch(head);
  const baseSha = resolveBranch(base);
  const checkoutSha = git(['rev-parse', 'HEAD^{commit}']).stdout.trim();
  if (candidateSha !== headSha) {
    fail(`candidate SHA ${candidateSha} is stale; ${head} is ${headSha}`);
  }
  if (checkoutSha !== candidateSha) {
    fail(`checked-out HEAD ${checkoutSha} does not match candidate SHA ${candidateSha}`);
  }
  verifyPromotionBase(baseSha, candidateSha, base);

  const manifest = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  const candidateVersion = parseStableVersion(manifest.version, 'candidate version');
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
    const baseVersion = parseStableVersion(basePackage.version, 'release branch version');
    if (compareVersions(candidateVersion, baseVersion) <= 0) {
      fail(`candidate version ${version} must be newer than release version ${basePackage.version}`);
    }
  } else if (manifest.name !== 'skill-expert' || version !== '1.0.0') {
    fail('a legacy release baseline can only promote the Skill Expert 1.0.0 bootstrap');
  }

  const tag = `v${version}`;
  const tagLookup = git(['show-ref', '--verify', '--quiet', `refs/tags/${tag}`], {
    allowFailure: true,
  });
  if (tagLookup.status === 0) fail(`tag ${tag} already exists`);
  if (tagLookup.status !== 1) fail(`unable to inspect tag ${tag}`);
  const originLookup = git(['remote', 'get-url', 'origin'], { allowFailure: true });
  const hasOrigin = originLookup.status === 0;
  if (hasOrigin) {
    const remoteTagLookup = git(
      ['ls-remote', '--exit-code', '--tags', '--refs', 'origin', `refs/tags/${tag}`],
      { allowFailure: true },
    );
    if (remoteTagLookup.status === 0) fail(`tag ${tag} already exists on origin`);
    if (remoteTagLookup.status !== 2) fail(`unable to inspect tag ${tag} on origin`);
  }

  return {
    version,
    tag,
    candidateSha,
    baseSha,
    commitRange: `${baseSha}..${candidateSha}`,
    tagAbsence: hasOrigin
      ? `refs/tags/${tag} is absent locally and on origin`
      : `refs/tags/${tag} is absent locally (no origin configured)`,
  };
}

function renderPrBody(options) {
  if (!options.output) fail('render-pr-body requires --output');
  const candidate = verifyCandidate(options);
  const englishNotes = releaseNotes(fs.readFileSync('CHANGELOG.md', 'utf8'), candidate.version);
  const chineseNotes = releaseNotes(fs.readFileSync('CHANGELOG-zh.md', 'utf8'), candidate.version);
  const body = `# Release promotion: Skill Expert v${candidate.version}

> [!IMPORTANT]
> **Merge means publication approval / 合并即批准正式发布。** Merging this \`main\` → \`release\` pull request is the sole approval to publish this exact candidate.
>
> **Merge commit required / 必须使用 merge commit。** Normal feature pull requests may still use squash; this rule applies only to Release promotion pull requests.

## Candidate identity

- Version: \`${candidate.version}\`
- Candidate SHA: \`${candidate.candidateSha}\`
- Commit range: \`${candidate.commitRange}\` (\`release..main\`)
- Promotion: \`head=main\` → \`base=release\`

## Release notes (English)

${englishNotes}

## 发布说明（中文）

${chineseNotes}

## Candidate platform matrix

| Target | Desktop packages | Updater structure | Standalone CLI | Result |
| --- | --- | --- | --- | --- |
| macOS arm64 | app, DMG | app archive + signature | skill-expert-cli | passed |
| macOS x64 | app, DMG | app archive + signature | skill-expert-cli | passed |
| Windows x64 | NSIS, MSI | installer signatures | skill-expert-cli.exe | passed |
| Linux x64 | AppImage, DEB, RPM | AppImage signature | skill-expert-cli | passed |

## macOS distribution limitation

The macOS candidate is **ad-hoc signed** and **not notarized**. Gatekeeper may require **System Settings → Privacy & Security → Open Anyway**. These checks prove package structure and signature integrity; they do not claim Gatekeeper acceptance or Apple notarization.

## Validation results

- Ordinary main CI: passed for \`${candidate.candidateSha}\`.
- Candidate guard: passed for exact \`head=main\`, \`base=release\`, and current main SHA.
- Four-target candidate packaging: passed for the exact candidate SHA above.
- Version consistency: passed for manifest, lockfiles, Tauri, Rust, UI locales, and both Changelogs.
- Stable version: \`${candidate.version}\` is a stable three-part SemVer.
- Tag absence proof: \`${candidate.tagAbsence}\`.

This pull request was created or refreshed by the successful candidate run on the same main SHA. It does not rely on a \`pull_request\` event generated by its own \`GITHUB_TOKEN\`.
`;
  fs.writeFileSync(options.output, body);
  return candidate;
}

function main() {
  try {
    const { command, options } = parseArguments(process.argv.slice(2));
    if (command === 'render-pr-body') {
      const result = renderPrBody(options);
      console.log(`Release promotion body rendered for v${result.version} at ${result.candidateSha}.`);
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
    console.log(`Release candidate v${result.version} verified at ${result.candidateSha}.`);
  } catch (error) {
    console.error(`Release candidate validation failed: ${error.message}`);
    process.exitCode = 1;
  }
}

main();
