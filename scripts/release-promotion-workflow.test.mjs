import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workflowPath = path.join(repositoryRoot, '.github/workflows/test.yml');
const promotionWorkflowPath = path.join(repositoryRoot, '.github/workflows/release-promotion.yml');

function workflow() {
  return fs.readFileSync(workflowPath, 'utf8');
}

function promotionWorkflow() {
  return fs.readFileSync(promotionWorkflowPath, 'utf8');
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
  assert.match(promotion, /release-promotion\.mjs render-pr-body/);
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
    'node --test scripts/release-candidate.test.mjs scripts/release-promotion-contract.test.mjs scripts/release-promotion-workflow.test.mjs',
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
  assert.match(
    job(content, 'candidate-pr'),
    /permissions:\n\s+contents: read\n\s+actions: read\n\s+pull-requests: write/,
  );
  assert.doesNotMatch(job(content, 'candidate-guard'), /pull-requests:\s*write/);
});

test('a manually opened non-main or cross-repository promotion fails on its own PR run', () => {
  const shape = job(promotionWorkflow(), 'promotion-source');

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
  const shape = job(promotionWorkflow(), 'promotion-contract');

  assert.match(shape, /ref:\s*\$\{\{ github\.event\.pull_request\.head\.sha \}\}/);
  assert.match(shape, /fetch-depth:\s*0/);
  assert.match(shape, /CANDIDATE_SHA:\s*\$\{\{ github\.event\.pull_request\.head\.sha \}\}/);
  assert.match(shape, /release-promotion\.mjs verify-candidate/);
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
  const content = promotionWorkflow();

  assert.match(
    content,
    /^  pull_request:\n    branches: \[release\]\n    types: \[opened, synchronize, reopened, edited\]$/m,
  );
});

test('Release PR 只运行稳定命名的高层来源与晋级契约检查', () => {
  const daily = workflow();
  const promotion = promotionWorkflow();

  assert.match(daily, /^  pull_request:\n    branches: \[main\]\n/m);
  assert.match(promotion, /^name:\s*发布晋级门禁$/m);
  assert.match(promotion, /^  pull_request:\n    branches: \[release\]\n/m);
  assert.match(promotion, /types:\s*\[opened, synchronize, reopened, edited\]/);
  assert.match(promotion, /^  promotion-source:\n[^]*?name:\s*发布晋级来源/m);
  assert.match(promotion, /^  promotion-contract:\n[^]*?name:\s*发布晋级契约/m);
  assert.match(promotion, /needs:\s*promotion-source/);
  assert.match(promotion, /actions:\s*read/);
  assert.match(promotion, /attestations:\s*read/);
  assert.match(promotion, /release-promotion\.mjs read-selector/);
  assert.match(promotion, /actions\/runs\/\$\{RUN_ID\}\/attempts\/\$\{RUN_ATTEMPT\}\/jobs/);
  assert.match(promotion, /actions\/artifacts\/\$\{EVIDENCE_ARTIFACT_ID\}\/zip/);
  assert.match(promotion, /gh attestation verify/);
  assert.match(promotion, /--source-digest "\$CANDIDATE_SHA"/);
  assert.match(promotion, /--source-ref refs\/heads\/main/);
  assert.match(promotion, /release-promotion\.mjs verify-candidate/);
  assert.doesNotMatch(promotion, /npm ci|cargo |tauri -- build|secrets\.|environment:\s*release/);
});

test('候选 PR 创建任务固定写入证据 artifact 与候选清单选择器', () => {
  const daily = workflow();
  const candidatePackage = job(daily, 'candidate-package');
  const candidatePr = job(daily, 'candidate-pr');

  assert.match(candidatePackage, /id-token:\s*write/);
  assert.match(candidatePackage, /attestations:\s*write/);
  assert.match(candidatePackage, /artifact-metadata:\s*write/);
  assert.match(candidatePr, /actions:\s*read/);
  assert.match(candidatePr, /needs\.candidate-package\.outputs\.evidence_artifact_id/);
  assert.match(candidatePr, /needs\.candidate-package\.outputs\.evidence_artifact_digest/);
  assert.match(candidatePr, /needs\.candidate-package\.outputs\.manifest_sha256/);
  assert.match(candidatePr, /actions\/artifacts\/\$\{EVIDENCE_ARTIFACT_ID\}\/zip/);
  assert.match(candidatePr, /release-promotion\.mjs render-pr-body/);
  assert.match(candidatePr, /--evidence-artifact-id "\$EVIDENCE_ARTIFACT_ID"/);
  assert.match(candidatePr, /--manifest-sha256 "\$MANIFEST_SHA256"/);
});
