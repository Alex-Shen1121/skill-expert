import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW_PATH = path.join(ROOT, '.github/workflows/prepare-release.yml');
const TEST_WORKFLOW_PATH = path.join(ROOT, '.github/workflows/test.yml');

test('dispatch prepares a release preparation branch and opens a pull request to main without tagging', () => {
  const workflow = fs.readFileSync(WORKFLOW_PATH, 'utf8');

  assert.match(workflow, /^\s*workflow_dispatch:\s*$/m);
  assert.match(workflow, /release_type:[^]*?options:\s*\n\s*- patch/);
  assert.doesNotMatch(workflow, /^\s*- (?:minor|major)\s*$/m);
  assert.match(
    workflow,
    /if:\s*\$\{\{\s*github\.event_name == 'workflow_dispatch' && github\.ref == 'refs\/heads\/release'\s*\}\}/,
  );
  assert.match(workflow, /^\s*pull-requests:\s*write\s*$/m);
  assert.match(workflow, /^\s*ref:\s*main\s*$/m);
  assert.match(workflow, /release-prep\/v\$\{VERSION\}/);
  assert.match(workflow, /\\\(-\[0-9\]\[0-9\]\*\\\)\\\?/);
  assert.match(workflow, /git ls-remote[^\n]+refs\/heads\/\$\{BRANCH\}/);
  assert.match(workflow, /gh pr list[^\n]+--head "\$BRANCH"/);
  assert.match(workflow, /git switch -c "\$BRANCH"/);
  assert.match(
    workflow,
    /git push --force-with-lease="refs\/heads\/\$\{BRANCH\}:" --set-upstream origin "\$BRANCH"/,
  );
  assert.match(workflow, /gh pr create[^]*--base main[^]*--head "\$BRANCH"/);
  assert.match(workflow, /--body [^\n]+#8[^\n]+npm run version:check/);
  assert.doesNotMatch(workflow, /\bgit tag\b/);
  assert.doesNotMatch(workflow, /git push[^\n]*(?:HEAD:main|origin main|--follow-tags)/);
  assert.doesNotMatch(workflow, /release\.yml/);
});

test('package and CI expose the release preparation contract suite', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const testWorkflow = fs.readFileSync(TEST_WORKFLOW_PATH, 'utf8');

  assert.equal(
    packageJson.scripts['test:release'],
    'node --test scripts/prepare-release.test.mjs scripts/changelog-history.test.mjs scripts/prepare-release-workflow.test.mjs',
  );
  assert.match(testWorkflow, /run: npm run test:release/);
});
