#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const TRUSTED_UPSTREAM_URL = 'https://github.com/xingkongliang/skills-manager.git';
const UPSTREAM_REF = 'refs/remotes/skill-expert-upstream/main';
const MAIN_REF = 'refs/remotes/origin/main';
const SYNC_BRANCH = 'upstream-tracking/main';
const SYNC_REMOTE_REF = `refs/remotes/origin/${SYNC_BRANCH}`;
const REVIEW_REPORT = '.github/upstream-tracking-review.json';
const PROTECTED_PATHS = JSON.parse(fs.readFileSync(
  new URL('../.github/upstream-tracking-protected-paths.json', import.meta.url),
  'utf8',
));

function fail(message) {
  throw new Error(message);
}

function parseArguments(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const argument = rest[index];
    const value = rest[index + 1];
    if (!argument?.startsWith('--') || value === undefined) fail(`Invalid argument: ${argument}`);
    options[argument.slice(2).replaceAll('-', '_')] = value;
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

function commit(ref) {
  return git(['rev-parse', '--verify', `${ref}^{commit}`]).stdout.trim();
}

function isAncestor(ancestor, descendant) {
  const result = git(['merge-base', '--is-ancestor', ancestor, descendant], {
    allowFailure: true,
  });
  if (result.status !== 0 && result.status !== 1) {
    fail('Unable to compare upstream main with Skill Expert tracking refs');
  }
  return result.status === 0;
}

function fetchExistingSyncBranch() {
  const lookup = git(
    ['ls-remote', '--exit-code', '--heads', 'origin', `refs/heads/${SYNC_BRANCH}`],
    { allowFailure: true },
  );
  if (lookup.status === 2) return null;
  if (lookup.status !== 0) fail(`Unable to inspect origin/${SYNC_BRANCH}`);
  const sha = lookup.stdout.trim().split(/\s+/)[0];
  git([
    'fetch',
    '--no-tags',
    'origin',
    `+refs/heads/${SYNC_BRANCH}:${SYNC_REMOTE_REF}`,
  ]);
  return sha;
}

function writeResult(outputPath, value) {
  fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(value, null, 2)}\n`);
}

function isProtected(relativePath) {
  return PROTECTED_PATHS.some(
    (protectedPath) =>
      relativePath === protectedPath || relativePath.startsWith(`${protectedPath}/`),
  );
}

function pathExistsAt(ref, relativePath) {
  return git(['cat-file', '-e', `${ref}:${relativePath}`], { allowFailure: true }).status === 0;
}

function restoreProtectedPaths() {
  const pathsAtMain = PROTECTED_PATHS.filter((relativePath) => pathExistsAt(MAIN_REF, relativePath));
  if (pathsAtMain.length > 0) {
    git(['restore', '--source', MAIN_REF, '--staged', '--worktree', '--', ...pathsAtMain]);
  }

  const tracked = git(['ls-files', '--', ...PROTECTED_PATHS]).stdout
    .split(/\r?\n/)
    .filter(Boolean);
  const additions = tracked.filter((relativePath) => !pathExistsAt(MAIN_REF, relativePath));
  if (additions.length > 0) git(['rm', '-f', '--', ...additions]);
}

function unresolvedPaths() {
  return git(['diff', '--name-only', '--diff-filter=U', '-z']).stdout
    .split('\0')
    .filter(Boolean);
}

function upstreamChangedPaths() {
  return git(['diff', '--name-only', '-z', `${MAIN_REF}...${UPSTREAM_REF}`]).stdout
    .split('\0')
    .filter(Boolean);
}

function resolveConflictsToMain(conflicts) {
  for (const relativePath of conflicts) {
    if (pathExistsAt(MAIN_REF, relativePath)) {
      git(['restore', '--source', MAIN_REF, '--staged', '--worktree', '--', relativePath]);
    } else {
      git(['rm', '-f', '--', relativePath]);
    }
  }
}

function renderPullRequest(outcome) {
  const waitingNotice = '> [!IMPORTANT]\n> This pull request requires explicit maintainer review.';
  const conflictNotice =
    outcome.conflicts.length > 0
      ? `## Conflicts requiring manual reconciliation\n\n${outcome.conflicts.map((item) => `- \`${item}\``).join('\n')}\n\nThe review branch keeps the current Skill Expert version of each conflicted path. Incorporate the upstream intent manually, then remove each path from the review report before merging.`
      : '## Merge result\n\nNo feature-level conflicts remain after restoring Skill Expert-owned product and release decisions.';
  const protectedNotice =
    outcome.protectedChanges.length > 0
      ? outcome.protectedChanges.map((item) => `- \`${item}\``).join('\n')
      : '- No protected path differed.';

  return `# Reviewed upstream tracking\n\n${waitingNotice}\n\nThis automation **never merges upstream changes automatically**. It prepares only the fixed \`upstream-tracking/main\` branch and a pull request into \`main\`.\n\n## Trusted source\n\n- Repository: \`xingkongliang/skills-manager\`\n- Branch: \`main\`\n- Upstream SHA: \`${outcome.upstream.sha}\`\n- Skill Expert main SHA: \`${outcome.mainSha}\`\n\n${conflictNotice}\n\n## Skill Expert decisions retained\n\nProduct identity, updater trust and feed configuration, independent version history, and main-based release governance files are restored byte-for-byte from Skill Expert \`main\` before this review commit is created. The following upstream-touched protected paths were intentionally retained:\n\n${protectedNotice}\n\nOrdinary CI must still pass before a maintainer may merge the reviewed result.\n`;
}

function validateReview(review) {
  if (
    review.upstreamRepository !== 'xingkongliang/skills-manager' ||
    review.upstreamBranch !== 'main' ||
    !/^[0-9a-f]{40}$/.test(review.upstreamSha ?? '') ||
    !/^[0-9a-f]{40}$/.test(review.baseMainSha ?? '') ||
    !Array.isArray(review.conflicts) ||
    review.conflicts.some((item) => typeof item !== 'string' || item.length === 0) ||
    !Array.isArray(review.protectedChanges) ||
    review.protectedChanges.some((item) => typeof item !== 'string' || !isProtected(item))
  ) {
    fail(`${REVIEW_REPORT} does not match the trusted upstream review contract`);
  }
  return review;
}

function reviewAt(ref) {
  const result = git(['show', `${ref}:${REVIEW_REPORT}`]);
  try {
    return validateReview(JSON.parse(result.stdout));
  } catch (error) {
    if (error.message.includes('trusted upstream review contract')) throw error;
    fail(`${REVIEW_REPORT} at ${ref} must contain valid JSON`);
  }
}

function recordsReviewedUpstream(ref, upstreamSha) {
  return pathExistsAt(ref, REVIEW_REPORT) && reviewAt(ref).upstreamSha === upstreamSha;
}

function pullRequestTitle(outcome) {
  return `${outcome.conflicts.length > 0 ? '[CONFLICTS] ' : ''}Upstream tracking: ${outcome.upstream.sha.slice(0, 12)}`;
}

function verifyReview(options) {
  const unsupported = Object.keys(options).find((option) => option !== 'required');
  if (unsupported) {
    fail(`unsupported verify-review option: --${unsupported.replaceAll('_', '-')}`);
  }
  if (options.required !== undefined && !['true', 'false'].includes(options.required)) {
    fail('verify-review --required must be true or false');
  }
  const reportRequired = options.required === 'true';
  if (!fs.existsSync(REVIEW_REPORT)) {
    if (reportRequired) {
      fail(`fixed upstream review branch must retain ${REVIEW_REPORT}`);
    }
    console.log('No upstream review metadata; no unresolved conflict paths.');
    return;
  }
  let review;
  try {
    review = JSON.parse(fs.readFileSync(REVIEW_REPORT, 'utf8'));
  } catch {
    fail(`${REVIEW_REPORT} must contain valid JSON`);
  }
  validateReview(review);
  if (review.conflicts.length > 0) {
    fail(`upstream review still requires manual reconciliation: ${review.conflicts.join(', ')}`);
  }
  console.log('Upstream review has no unresolved conflict paths.');
}

function prepareReview(mainSha, upstreamSha, options, previousSyncSha) {
  const clean = git(['status', '--porcelain']).stdout.trim();
  if (clean) fail('working tree must be clean before preparing upstream tracking');
  const upstreamProtectedChanges = upstreamChangedPaths().filter(isProtected);
  git(['switch', '--force-create', SYNC_BRANCH, MAIN_REF]);
  const merge = git(
    ['merge', '--no-ff', '--no-commit', '-m', `Track upstream ${upstreamSha}`, UPSTREAM_REF],
    { allowFailure: true },
  );
  if (merge.status !== 0 && merge.status !== 1) {
    fail(merge.stderr.trim() || 'unable to merge trusted upstream main');
  }

  const conflicts = unresolvedPaths();
  const reviewConflicts = conflicts.filter((relativePath) => !isProtected(relativePath));
  const protectedChanges = [
    ...new Set([
      ...upstreamProtectedChanges,
      ...conflicts.filter(isProtected),
    ]),
  ].sort();
  resolveConflictsToMain(reviewConflicts);
  restoreProtectedPaths();
  const remaining = unresolvedPaths();
  if (remaining.length > 0) {
    fail(`unresolved upstream conflicts are not implemented yet: ${remaining.join(', ')}`);
  }

  const review = {
    upstreamRepository: 'xingkongliang/skills-manager',
    upstreamBranch: 'main',
    upstreamSha,
    baseMainSha: mainSha,
    conflicts: reviewConflicts,
    protectedChanges,
  };
  fs.mkdirSync('.github', { recursive: true });
  fs.writeFileSync(REVIEW_REPORT, `${JSON.stringify(review, null, 2)}\n`);
  git(['add', REVIEW_REPORT]);
  git(['commit', '-m', `chore: prepare upstream review ${upstreamSha.slice(0, 12)}`]);
  const syncSha = commit('HEAD');
  const outcome = {
    status: reviewConflicts.length > 0 ? 'conflicts' : 'review-ready',
    mainSha,
    syncBranch: SYNC_BRANCH,
    syncSha,
    previousSyncSha,
    upstream: {
      repository: 'xingkongliang/skills-manager',
      branch: 'main',
      sha: upstreamSha,
    },
    conflicts: reviewConflicts,
    protectedChanges,
  };
  outcome.prTitle = pullRequestTitle(outcome);
  if (options.body) fs.writeFileSync(options.body, renderPullRequest(outcome));
  writeResult(options.result, outcome);
  console.log(`Prepared upstream review branch ${SYNC_BRANCH} at ${syncSha}.`);
  if (reviewConflicts.length > 0) {
    console.log(`Conflicts require manual review: ${reviewConflicts.join(', ')}`);
  }
}

function prepare(options) {
  const allowedOptions = new Set(['body', 'result']);
  const unsupported = Object.keys(options).find((option) => !allowedOptions.has(option));
  if (unsupported) {
    fail(`unsupported prepare option: --${unsupported.replaceAll('_', '-')}`);
  }
  if (!options.result) fail('prepare requires --result');
  git(['fetch', '--no-tags', 'origin', `+refs/heads/main:${MAIN_REF}`]);
  git([
    'fetch',
    '--no-tags',
    TRUSTED_UPSTREAM_URL,
    `+refs/heads/main:${UPSTREAM_REF}`,
  ]);

  const mainSha = commit(MAIN_REF);
  const upstreamSha = commit(UPSTREAM_REF);
  const previousSyncSha = fetchExistingSyncBranch();
  const trackedOnMain =
    isAncestor(upstreamSha, mainSha) || recordsReviewedUpstream(MAIN_REF, upstreamSha);
  const trackedOnReview =
    !trackedOnMain && previousSyncSha !== null && isAncestor(upstreamSha, previousSyncSha);
  if (trackedOnMain || trackedOnReview) {
    const outcome = {
      status: 'no-change',
      mainSha,
      upstream: {
        repository: 'xingkongliang/skills-manager',
        branch: 'main',
        sha: upstreamSha,
      },
    };
    if (trackedOnReview) {
      const review = reviewAt(previousSyncSha);
      outcome.syncBranch = SYNC_BRANCH;
      outcome.syncSha = previousSyncSha;
      outcome.conflicts = review.conflicts;
      outcome.protectedChanges = review.protectedChanges;
      outcome.prTitle = pullRequestTitle(outcome);
      if (options.body) fs.writeFileSync(options.body, renderPullRequest(outcome));
    }
    writeResult(options.result, outcome);
    console.log('No new upstream commits; the review branch was left unchanged.');
    return;
  }

  prepareReview(mainSha, upstreamSha, options, previousSyncSha);
}

function main() {
  try {
    const { command, options } = parseArguments(process.argv.slice(2));
    if (command === 'verify-review') {
      verifyReview(options);
      return;
    }
    if (command !== 'prepare') {
      fail('Usage: upstream-tracking.mjs <prepare --result path|verify-review>');
    }
    prepare(options);
  } catch (error) {
    console.error(`Upstream tracking failed: ${error.message}`);
    process.exitCode = 1;
  }
}

main();
