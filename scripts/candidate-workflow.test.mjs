import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workflowPath = path.join(repositoryRoot, '.github/workflows/candidate-build.yml');
const manualWorkflowPath = path.join(repositoryRoot, '.github/workflows/manual-test-package.yml');
const testWorkflowPath = path.join(repositoryRoot, '.github/workflows/test.yml');

test('reusable candidate workflow checks out and validates the exact requested SHA', () => {
  const workflow = fs.readFileSync(workflowPath, 'utf8');

  assert.match(workflow, /^\s{2}workflow_call:\s*$/m);
  assert.doesNotMatch(workflow, /^\s{2}workflow_dispatch:\s*$/m);
  assert.equal((workflow.match(/^\s{6}candidate_sha:\s*$/gm) ?? []).length, 1);
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
  const caller = fs.readFileSync(testWorkflowPath, 'utf8');
  const targets = [...caller.matchAll(/"target_id":"([^"]+)"/g)]
    .map((match) => match[1])
    .sort();

  assert.deepEqual(targets, ['linux-x64', 'macos-arm64', 'macos-x64', 'windows-x64']);
  assert.match(caller, /aarch64-apple-darwin/);
  assert.match(caller, /x86_64-apple-darwin/);
  assert.match(caller, /x86_64-pc-windows-msvc/);
  assert.match(caller, /x86_64-unknown-linux-gnu/);
  assert.match(workflow, /include:\s*\$\{\{ fromJSON\(inputs\.targets_json\) \}\}/);
  assert.match(workflow, /--bundles "\$BUNDLES"/);
});

test('candidate workflow uses only ephemeral signing and has no release side effects', () => {
  const workflow = fs.readFileSync(workflowPath, 'utf8');
  const buildStep = workflow.match(
    /- name: 构建完整桌面安装包与 Updater 资产[\s\S]*?(?=\n\s+- name:)/,
  )?.[0] ?? '';
  const stageStep = workflow.match(
    /- name: 整理稳定候选资产名[\s\S]*?(?=\n\s+- name:)/,
  )?.[0] ?? '';

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
    buildStep,
    /TAURI_SIGNING_PRIVATE_KEY:\s*\$\{\{ runner\.temp \}\}\/candidate-updater\.key/,
  );
  assert.match(
    stageStep,
    /TAURI_SIGNING_PRIVATE_KEY_PATH:\s*\$\{\{ runner\.temp \}\}\/candidate-updater\.key/,
  );
  assert.doesNotMatch(stageStep, /^\s*TAURI_SIGNING_PRIVATE_KEY:\s*/m);
  assert.match(workflow, /APPLE_SIGNING_IDENTITY:\s*"-"/);
  assert.match(workflow, /codesign --force --sign - "\$CLI_PATH"/);
  assert.match(workflow, /verify-macos-adhoc\.mjs/);
  assert.match(workflow, /candidate-assets\.mjs stage/);
  assert.match(workflow, /sign-release-updater\.mjs/);
  assert.match(workflow, /--public-key "\$CANDIDATE_PUBLIC_KEY_PATH"/);
  assert.match(workflow, /candidate-assets\.mjs verify/);

  assert.doesNotMatch(workflow, /\$\{\{\s*secrets\./);
  assert.doesNotMatch(
    workflow,
    /APPLE_CERTIFICATE|APPLE_API_|APPLE_ID|APPLE_PASSWORD|APPLE_TEAM_ID|Developer ID/,
  );
  assert.doesNotMatch(workflow, /\bgh release\b|\bgit tag\b|\bnotary|\bnotariz|\bspctl\b/i);
  assert.doesNotMatch(workflow, /^\s+environment:\s*/m);
  assert.doesNotMatch(workflow, /^\s+contents:\s*write\s*$/m);
});

test('候选工作流实际运行 Linux 与 Windows 原生安装包回验', () => {
  const workflow = fs.readFileSync(workflowPath, 'utf8');

  assert.match(workflow, /apt-get install -y[\s\S]*?\blibarchive-tools\b/);
  assert.match(
    workflow,
    /if:\s*runner\.os == 'Linux'[\s\S]*?verify-linux-release\.mjs[\s\S]*?--directory "candidate-assets\/\$TARGET_ID"/,
  );
  assert.match(
    workflow,
    /if:\s*runner\.os == 'Windows'[\s\S]*?verify-windows-release\.ps1[\s\S]*?-Directory "candidate-assets\/\$\{\{ matrix\.target_id \}\}"/,
  );
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
  assert.match(
    workflow,
    /name:\s*\$\{\{ inputs\.artifact_prefix \}\}-\$\{\{ inputs\.candidate_sha \}\}-\$\{\{ github\.run_attempt \}\}-\$\{\{ matrix\.target_id \}\}/,
  );
  assert.doesNotMatch(workflow, /src-tauri\/target[^\n]*\n\s+if-no-files-found/);
});

test('候选工作流汇总精确 artifact 身份并生成不可变清单与真实来源证明', () => {
  const workflow = fs.readFileSync(workflowPath, 'utf8');
  const evidenceJob = workflow.match(
    /^  candidate-evidence:\n([^]*?)(?=^  [a-z][a-z0-9-]+:\n|(?![^]))/m,
  )?.[0] ?? '';

  assert.match(workflow, /^\s{4}outputs:\n\s{6}evidence_artifact_id:/m);
  assert.match(workflow, /value:\s*\$\{\{ jobs\.candidate-evidence\.outputs\.artifact_id \}\}/);
  assert.match(workflow, /evidence_artifact_digest:/);
  assert.match(workflow, /manifest_sha256:/);
  assert.match(evidenceJob, /needs:\s*build-candidate/);
  assert.match(evidenceJob, /actions:\s*read/);
  assert.match(evidenceJob, /id-token:\s*write/);
  assert.match(evidenceJob, /attestations:\s*write/);
  assert.match(evidenceJob, /artifact-metadata:\s*write/);
  assert.match(evidenceJob, /repos\/\$\{REPO\}\/actions\/runs\/\$\{RUN_ID\}\/artifacts/);
  assert.match(evidenceJob, /repos\/\$\{REPO\}\/actions\/artifacts\/\$\{ARTIFACT_ID\}\/zip/);
  assert.match(evidenceJob, /sha256sum/);
  assert.match(evidenceJob, /release-promotion\.mjs create-manifest/);
  assert.match(evidenceJob, /candidate-build-provenance\.json/);
  assert.match(evidenceJob, /uses:\s*actions\/attest@[0-9a-f]{40}/);
  assert.match(evidenceJob, /subject-path:[^]*?candidate-assets\/\*\*\/\*/);
  assert.match(evidenceJob, /skill-expert-candidate-evidence-/);
  assert.match(evidenceJob, /skill-expert-candidate-\$\{CANDIDATE_SHA\}-\$\{GITHUB_RUN_ATTEMPT\}-\$\{TARGET_ID\}/);
  assert.match(evidenceJob, /artifact-id/);
  assert.match(evidenceJob, /artifact-digest/);
  assert.doesNotMatch(evidenceJob, /pull-requests:\s*write|contents:\s*write|environment:\s*release/);
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

test('手动测试包默认只选 macOS arm64，并以不可晋级用途调用隔离构建', () => {
  const manual = fs.readFileSync(manualWorkflowPath, 'utf8');

  assert.match(manual, /^name:\s*构建手动测试包$/m);
  assert.match(manual, /^\s{6}macos_arm64:\n[^]*?default:\s*true/m);
  for (const input of ['macos_x64', 'windows_x64', 'linux_x64']) {
    assert.match(manual, new RegExp(`^\\s{6}${input}:\\n[^]*?default:\\s*false`, 'm'));
  }
  assert.match(manual, /uses:\s*\.\/\.github\/workflows\/candidate-build\.yml/);
  assert.match(manual, /purpose:\s*manual-test-package/);
  assert.match(manual, /artifact_prefix:\s*skill-expert-manual-test/);
  assert.match(manual, /targets_json:\s*\$\{\{ needs\.select-targets\.outputs\.targets_json \}\}/);
  assert.doesNotMatch(manual, /pull-requests:\s*write|gh pr (?:create|edit)|environment:\s*release|secrets\./);
});

test('可复用构建只为正式四平台候选生成晋级证据，手动包写入不可晋级标记', () => {
  const candidate = fs.readFileSync(workflowPath, 'utf8');
  const evidenceJob = candidate.match(
    /^  candidate-evidence:\n([^]*?)(?=^  [a-z][a-z0-9-]+:\n|(?![^]))/m,
  )?.[0] ?? '';

  assert.match(candidate, /^\s{6}purpose:\n[^]*?default:\s*formal-release-candidate/m);
  assert.match(candidate, /^\s{6}targets_json:\n[^]*?required:\s*true/m);
  assert.match(candidate, /^\s{6}artifact_prefix:\n[^]*?default:\s*skill-expert-candidate/m);
  assert.match(candidate, /include:\s*\$\{\{ fromJSON\(inputs\.targets_json\) \}\}/);
  assert.match(candidate, /name:\s*\$\{\{ inputs\.artifact_prefix \}\}-/);
  assert.match(candidate, /TEST-PACKAGE\.json/);
  assert.match(candidate, /"purpose":\s*"manual-test-package"/);
  assert.match(evidenceJob, /if:\s*inputs\.purpose == 'formal-release-candidate'/);
});
