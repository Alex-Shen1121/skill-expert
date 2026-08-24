import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workflowPath = path.join(repositoryRoot, '.github/workflows/candidate-build.yml');
const testWorkflowPath = path.join(repositoryRoot, '.github/workflows/test.yml');

test('reusable candidate workflow checks out and validates the exact requested SHA', () => {
  const workflow = fs.readFileSync(workflowPath, 'utf8');

  assert.match(workflow, /^\s{2}workflow_call:\s*$/m);
  assert.match(workflow, /^\s{2}workflow_dispatch:\s*$/m);
  assert.equal((workflow.match(/^\s{6}candidate_sha:\s*$/gm) ?? []).length, 2);
  assert.match(workflow, /^\s+ref:\s*\$\{\{ inputs\.candidate_sha \}\}\s*$/m);
  assert.match(workflow, /EXPECTED_SHA:\s*\$\{\{ inputs\.candidate_sha \}\}/);
  assert.match(workflow, /ACTUAL_SHA="\$\(git rev-parse HEAD\)"/);
  assert.match(workflow, /\[\[ ! "\$EXPECTED_SHA" =~ \^\[0-9a-f\]\{40\}\$ \]\]/);
  assert.match(workflow, /\[ "\$ACTUAL_SHA" != "\$EXPECTED_SHA" \]/);
  assert.match(
    workflow,
    /git merge-base --is-ancestor "\$EXPECTED_SHA" origin\/main/,
  );
});

test('candidate workflow declares exactly the four supported build targets', () => {
  const workflow = fs.readFileSync(workflowPath, 'utf8');
  const targets = [...workflow.matchAll(/^\s+- target_id:\s*([^\s]+)\s*$/gm)]
    .map((match) => match[1])
    .sort();

  assert.deepEqual(targets, ['linux-x64', 'macos-arm64', 'macos-x64', 'windows-x64']);
  assert.match(workflow, /aarch64-apple-darwin/);
  assert.match(workflow, /x86_64-apple-darwin/);
  assert.match(workflow, /x86_64-pc-windows-msvc/);
  assert.match(workflow, /x86_64-unknown-linux-gnu/);
  assert.equal((workflow.match(/^\s+bundles:\s*app,dmg\s*$/gm) ?? []).length, 2);
  assert.equal((workflow.match(/^\s+bundles:\s*nsis,msi\s*$/gm) ?? []).length, 1);
  assert.equal((workflow.match(/^\s+bundles:\s*appimage,deb,rpm\s*$/gm) ?? []).length, 1);
  assert.match(workflow, /--bundles "\$BUNDLES"/);
});

test('candidate workflow uses only ephemeral signing and has no release side effects', () => {
  const workflow = fs.readFileSync(workflowPath, 'utf8');

  assert.match(workflow, /^\s+contents:\s*read\s*$/m);
  assert.match(workflow, /CANDIDATE_KEY_PASSWORD="\$\(openssl rand -hex 32\)"/);
  assert.match(workflow, /echo "::add-mask::\$CANDIDATE_KEY_PASSWORD"/);
  assert.match(
    workflow,
    /signer generate --ci --force\s+\\\s+--password "\$CANDIDATE_KEY_PASSWORD"\s+\\\s+--write-keys/,
  );
  assert.match(
    workflow,
    /TAURI_SIGNING_PRIVATE_KEY_PASSWORD=\$CANDIDATE_KEY_PASSWORD[^\n]+GITHUB_ENV/,
  );
  assert.match(
    workflow,
    /TAURI_SIGNING_PRIVATE_KEY:\s*\$\{\{ runner\.temp \}\}\/candidate-updater\.key/,
  );
  assert.match(workflow, /APPLE_SIGNING_IDENTITY:\s*"-"/);
  assert.match(workflow, /codesign --force --sign - "\$CLI_PATH"/);
  assert.match(workflow, /verify-macos-adhoc\.mjs/);
  assert.match(workflow, /candidate-assets\.mjs stage/);
  assert.match(workflow, /candidate-assets\.mjs verify/);

  assert.doesNotMatch(workflow, /\$\{\{\s*secrets\./);
  assert.doesNotMatch(
    workflow,
    /APPLE_CERTIFICATE|APPLE_API_|APPLE_ID|APPLE_PASSWORD|APPLE_TEAM_ID|Developer ID/,
  );
  assert.doesNotMatch(workflow, /TAURI_SIGNING_PRIVATE_KEY_PATH/);
  assert.doesNotMatch(workflow, /\bgh release\b|\bgit tag\b|\bnotary|\bnotariz|\bspctl\b/i);
  assert.doesNotMatch(workflow, /^\s+environment:\s*/m);
  assert.doesNotMatch(workflow, /^\s+contents:\s*write\s*$/m);
});

test('candidate workflow pins actions and uploads only staged candidate directories', () => {
  const workflow = fs.readFileSync(workflowPath, 'utf8');
  const actionReferences = [...workflow.matchAll(/^\s+-?\s*uses:\s*([^\s#]+)(?:\s+#.*)?$/gm)].map(
    (match) => match[1],
  );

  assert.ok(actionReferences.length >= 4, 'expected checkout, setup, cache, and upload actions');
  for (const reference of actionReferences) {
    assert.match(reference, /@[0-9a-f]{40}$/, `${reference} must be pinned to a full commit SHA`);
  }
  assert.match(workflow, /path:\s*candidate-assets\/\$\{\{ matrix\.target_id \}\}/);
  assert.doesNotMatch(workflow, /src-tauri\/target[^\n]*\n\s+if-no-files-found/);
});

test('package and CI expose the candidate contract suite', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'));
  const testWorkflow = fs.readFileSync(testWorkflowPath, 'utf8');

  assert.equal(
    packageJson.scripts['test:candidate'],
    'node --test scripts/candidate-assets.test.mjs scripts/candidate-workflow.test.mjs scripts/candidate-docs.test.mjs scripts/verify-macos-adhoc.test.mjs',
  );
  assert.match(testWorkflow, /run: npm run test:candidate/);
});
