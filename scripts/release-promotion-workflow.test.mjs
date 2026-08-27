import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workflowPath = path.join(repositoryRoot, '.github/workflows/test.yml');

function workflow() {
  return fs.readFileSync(workflowPath, 'utf8');
}

function job(content, name) {
  // The workflow text is the observable contract; actionlint owns YAML structure validation.
  const match = new RegExp(
    `^  ${name}:\\n([^]*?)(?=^  [a-z][a-z0-9-]+:\\n|(?![^]))`,
    'm',
  ).exec(content);
  assert.ok(match, `expected ${name} job`);
  return match[0];
}

test('main PR 通过公开版本策略 CLI 卡控开发序号或发布准备例外', () => {
  const content = workflow();
  const frontend = job(content, 'frontend');

  assert.match(frontend, /if:\s*github\.event_name == 'pull_request' && github\.base_ref == 'main'/);
  assert.match(frontend, /BASE_SHA:\s*\$\{\{ github\.event\.pull_request\.base\.sha \}\}/);
  assert.match(frontend, /HEAD_SHA:\s*\$\{\{ github\.event\.pull_request\.head\.sha \}\}/);
  assert.match(frontend, /HEAD_REF:\s*\$\{\{ github\.head_ref \}\}/);
  assert.match(
    frontend,
    /HEAD_REPOSITORY:\s*\$\{\{ github\.event\.pull_request\.head\.repo\.full_name \}\}/,
  );
  assert.match(frontend, /EXPECTED_REPOSITORY:\s*\$\{\{ github\.repository \}\}/);
  assert.match(frontend, /version-policy\.mjs verify-main-pr/);
  assert.match(frontend, /--base-sha "\$BASE_SHA"/);
  assert.match(frontend, /--head-sha "\$HEAD_SHA"/);
  assert.match(frontend, /--head-ref "\$HEAD_REF"/);
  assert.match(frontend, /--head-repository "\$HEAD_REPOSITORY"/);
  assert.match(frontend, /--expected-repository "\$EXPECTED_REPOSITORY"/);
  assert.match(frontend, /--release-ref origin\/release/);
});

test('main push 先区分开发序号与正式候选，只有正式候选进入四平台构建', () => {
  const content = workflow();
  assert.match(
    content,
    /main-version-policy:\n[^]*?needs:\s*\[frontend, workflow-lint, rust-quality, rust-tests\]/,
  );
  assert.match(
    content,
    /main-version-policy:\n[^]*?if:\s*github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'/,
  );
  assert.match(content, /BEFORE_SHA:\s*\$\{\{ github\.event\.before \}\}/);
  assert.match(content, /HEAD_SHA:\s*\$\{\{ github\.sha \}\}/);
  assert.match(content, /version-policy\.mjs verify-main-push/);
  assert.match(content, /release_candidate=\$RELEASE_CANDIDATE/);

  assert.match(
    content,
    /candidate-guard:\n[^]*?needs:\s*main-version-policy[^]*?if:\s*needs\.main-version-policy\.outputs\.release_candidate == 'true'/,
  );
  assert.match(content, /CANDIDATE_SHA:\s*\$\{\{ github\.sha \}\}/);
  assert.match(content, /release-candidate\.mjs verify[^]*?--candidate-sha "\$CANDIDATE_SHA"/);
  assert.match(content, /--head main[^]*?--base release/);

  assert.match(
    content,
    /candidate-package:\n[^]*?needs:\s*candidate-guard[^]*?uses:\s*\.\/\.github\/workflows\/candidate-build\.yml/,
  );
  assert.match(
    content,
    /candidate-package:\n[^]*?candidate_sha:\s*\$\{\{ github\.sha \}\}/,
  );
  assert.equal(
    (content.match(/uses:\s*\.\/\.github\/workflows\/candidate-build\.yml/g) ?? []).length,
    1,
  );
  assert.doesNotMatch(content, /target_id:\s*(?:macos|windows|linux)-/);
});

test('a packaged current candidate creates or updates exactly one release promotion', () => {
  const content = workflow();
  const promotion = job(content, 'candidate-pr');

  assert.match(promotion, /needs:\s*candidate-package/);
  assert.match(promotion, /contents:\s*read/);
  assert.match(promotion, /pull-requests:\s*write/);
  assert.match(promotion, /ref:\s*\$\{\{ github\.sha \}\}/);
  assert.match(promotion, /CANDIDATE_SHA:\s*\$\{\{ github\.sha \}\}/);
  assert.match(promotion, /release-candidate\.mjs render-pr-body/);
  assert.match(promotion, /--candidate-sha "\$CANDIDATE_SHA"/);
  assert.match(promotion, /--head main/);
  assert.match(promotion, /--base release/);

  assert.match(
    promotion,
    /gh pr list --state open --base release --limit 1000/,
  );
  assert.match(promotion, /headRefName == "main" and \.baseRefName == "release"/);
  assert.match(promotion, /if \[ "\$PR_COUNT" -gt 1 \]/);
  assert.match(promotion, /gh pr edit "\$PR_NUMBER"[^]*?--body-file "\$PROMOTION_BODY"/);
  assert.match(
    promotion,
    /gh pr create[^]*?--base release[^]*?--head main[^]*?--body-file "\$PROMOTION_BODY"/,
  );
  assert.match(promotion, /GH_TOKEN:\s*\$\{\{ github\.token \}\}/);
});

test('CI exposes the promotion contract suite before candidate packaging', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'));
  const frontend = job(workflow(), 'frontend');

  assert.equal(
    packageJson.scripts['test:promotion'],
    'node --test scripts/release-candidate.test.mjs scripts/release-promotion-workflow.test.mjs',
  );
  assert.match(frontend, /run:\s*npm run test:promotion/);
});

test('promotion keeps third-party actions pinned and grants write permission only to the PR job', () => {
  const content = workflow();
  const references = [...content.matchAll(/^\s+uses:\s*([^\s#]+)(?:\s+#.*)?$/gm)].map(
    (match) => match[1],
  );

  for (const reference of references.filter((value) => !value.startsWith('./'))) {
    assert.match(reference, /@[0-9a-f]{40}$/, `${reference} must be pinned to a full commit SHA`);
  }
  assert.match(content, /^permissions:\n  contents: read$/m);
  assert.doesNotMatch(content, /contents:\s*write/);
  assert.doesNotMatch(content, /\$\{\{\s*secrets\./);
  assert.match(job(content, 'candidate-pr'), /permissions:\n\s+contents: read\n\s+pull-requests: write/);
  assert.doesNotMatch(job(content, 'candidate-guard'), /pull-requests:\s*write/);
});

test('a manually opened non-main or cross-repository promotion fails on its own PR run', () => {
  const shape = job(workflow(), 'release-promotion-shape');

  assert.match(
    shape,
    /if:\s*github\.event_name == 'pull_request' && github\.base_ref == 'release'/,
  );
  assert.match(shape, /HEAD_REF:\s*\$\{\{ github\.head_ref \}\}/);
  assert.match(shape, /BASE_REF:\s*\$\{\{ github\.base_ref \}\}/);
  assert.match(
    shape,
    /HEAD_REPOSITORY:\s*\$\{\{ github\.event\.pull_request\.head\.repo\.full_name \}\}/,
  );
  assert.match(shape, /EXPECTED_REPOSITORY:\s*\$\{\{ github\.repository \}\}/);
  assert.match(shape, /"\$HEAD_REF" != "main"/);
  assert.match(shape, /"\$BASE_REF" != "release"/);
  assert.match(shape, /"\$HEAD_REPOSITORY" != "\$EXPECTED_REPOSITORY"/);
});

test('main 到 release 的 PR 再次校验精确 SHA 与下一正式补丁版本', () => {
  const shape = job(workflow(), 'release-promotion-shape');

  assert.match(shape, /ref:\s*\$\{\{ github\.event\.pull_request\.head\.sha \}\}/);
  assert.match(shape, /fetch-depth:\s*0/);
  assert.match(shape, /CANDIDATE_SHA:\s*\$\{\{ github\.event\.pull_request\.head\.sha \}\}/);
  assert.match(shape, /release-candidate\.mjs verify/);
  assert.match(shape, /--candidate-sha "\$CANDIDATE_SHA"/);
  assert.match(shape, /--head main/);
  assert.match(shape, /--base release/);
});

test('existing promotion lookup binds the repository main head to the packaged SHA', () => {
  const promotion = job(workflow(), 'candidate-pr');

  assert.match(
    promotion,
    /--json number,headRefName,baseRefName,isCrossRepository,headRefOid/,
  );
  assert.match(promotion, /\.isCrossRepository/);
  assert.match(promotion, /\.headRefOid == \$candidate_sha/);
  assert.match(promotion, /--arg candidate_sha "\$CANDIDATE_SHA"/);
});

test('a rejected outsider promotion cannot block selection of the exact valid promotion', () => {
  const promotion = job(workflow(), 'candidate-pr');

  assert.match(promotion, /VALID_PROMOTIONS=/);
  assert.match(promotion, /\.headRefName == "main"/);
  assert.match(promotion, /\.baseRefName == "release"/);
  assert.match(promotion, /\(\.isCrossRepository \| not\)/);
  assert.match(promotion, /\.headRefOid == \$candidate_sha/);
  assert.doesNotMatch(promotion, /INVALID_COUNT/);
});

test('retargeting an existing pull request to release reruns the shape guard', () => {
  const content = workflow();

  assert.match(
    content,
    /^  pull_request:\n    types: \[opened, synchronize, reopened, edited\]$/m,
  );
});
