import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workflowPath = path.join(repositoryRoot, '.github/workflows/upstream-tracking.yml');

function workflow() {
  return fs.readFileSync(workflowPath, 'utf8');
}

test('每周和手动检查只通过公开 CLI 获取受信任的上游 main', () => {
  const content = workflow();

  assert.match(content, /^name: Upstream tracking$/m);
  assert.match(content, /^\s+schedule:\s*$/m);
  assert.match(content, /^\s+- cron: ['"]\d+ \d+ \* \* 1['"]\s*$/m);
  assert.match(content, /^\s+workflow_dispatch:\s*$/m);
  assert.match(
    content,
    /uses:\s*actions\/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1/,
  );
  assert.match(content, /node scripts\/upstream-tracking\.mjs prepare/);
  assert.match(content, /xingkongliang\/skills-manager/);
  assert.match(content, /upstream-tracking\/main/);
  assert.doesNotMatch(content, /refs\/heads\/(?:master|develop)/);
});

test('无变化时零写入，有变化时安全刷新唯一分支和 main PR', () => {
  const content = workflow();

  assert.match(content, /jq -r '\.status' "\$RESULT_PATH"/);
  assert.match(content, /jq -r 'has\("syncSha"\)' "\$RESULT_PATH"/);
  assert.match(content, /if:\s*steps\.prepare\.outputs\.status != 'no-change'/);
  assert.match(content, /if:\s*steps\.prepare\.outputs\.review_required == 'true'/);
  assert.match(
    content,
    /git push --force-with-lease="refs\/heads\/upstream-tracking\/main:\$\{PREVIOUS_SYNC_SHA\}"[^\n]+HEAD:refs\/heads\/upstream-tracking\/main/,
  );
  assert.match(content, /gh pr list --state open --base main --head upstream-tracking\/main/);
  assert.match(content, /gh pr create[^]*--base main[^]*--head upstream-tracking\/main[^]*--draft/);
  assert.match(content, /gh pr edit "\$PR_NUMBER" --title "\$TITLE" --body-file "\$BODY_PATH"/);
  assert.match(content, /--arg title "\$TITLE" --rawfile body "\$BODY_PATH"/);
  assert.match(content, /\.title != \$title or \.body != \$body/);
  assert.doesNotMatch(content, /gh pr merge|--auto|enablePullRequestAutoMerge/);
});

test('上游评审不再查询或依赖 release 分支状态', () => {
  const content = workflow();

  assert.doesNotMatch(content, /--base release|--head main|release-candidate-sha/);
  assert.doesNotMatch(content, /releasePromotion|RELEASE_CANDIDATE_SHA/);
  assert.match(content, /jq -e '\(\.conflicts \| length > 0\)'/);
  assert.match(content, /gh pr ready "\$PR_NUMBER" --undo/);
  assert.doesNotMatch(content, /HEAD:refs\/heads\/(?:main|release)/);
});

test('工作流权限仅允许读取代码并写入自己的分支和 PR', () => {
  const content = workflow();

  assert.match(content, /permissions:\n\s+contents: read/);
  assert.match(
    content,
    /prepare-review:[^]*?permissions:\n\s+contents: write\n\s+pull-requests: write/,
  );
  assert.doesNotMatch(content, /issues: write|actions: write|checks: write|id-token: write|packages: write/);
});

test('package 保留上游跟踪契约套件但轻量 PR 不运行它', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'));
  const testWorkflow = fs.readFileSync(
    path.join(repositoryRoot, '.github/workflows/test.yml'),
    'utf8',
  );

  assert.equal(
    packageJson.scripts['test:upstream-tracking'],
    'node --test scripts/upstream-tracking.test.mjs scripts/upstream-tracking-workflow.test.mjs',
  );
  assert.doesNotMatch(testWorkflow, /run: npm run test:upstream-tracking/);
  assert.doesNotMatch(testWorkflow, /REVIEW_REPORT_REQUIRED|verify-review/);
});
