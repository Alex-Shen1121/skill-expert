import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workflowPath = path.join(repositoryRoot, '.github/workflows/release.yml');
const testWorkflowPath = path.join(repositoryRoot, '.github/workflows/test.yml');
const draftDownloadScriptPath = path.join(repositoryRoot, 'scripts/download-draft-release-assets.sh');

function workflow() {
  return fs.readFileSync(workflowPath, 'utf8');
}

function job(content, name) {
  const match = new RegExp(
    `^  ${name}:\\n([^]*?)(?=^  [a-z][a-z0-9-]+:\\n|(?![^]))`,
    'm',
  ).exec(content);
  assert.ok(match, `缺少 ${name} job`);
  return match[0];
}

test('正式发布只响应 release push 且所有发布串行排队不取消', () => {
  const content = workflow();

  assert.match(content, /^  push:\n    branches:\n      - release$/m);
  assert.doesNotMatch(content, /^\s+tags:\s*$/m);
  assert.doesNotMatch(content, /^\s{2}workflow_dispatch:\s*$/m);
  assert.match(content, /^concurrency:\n  group: release-production\n  cancel-in-progress: false$/m);
  assert.match(
    job(content, 'prepare-release'),
    /if:\s*github\.event_name == 'push' && github\.ref == 'refs\/heads\/release'/,
  );
});

test('tag 之前重新验证唯一 Release PR、merge tree、候选 run、artifact、清单和 provenance', () => {
  const prepare = job(workflow(), 'prepare-release');
  const tagPosition = prepare.indexOf('- name: 创建不可变 annotated tag');

  assert.match(prepare, /contents:\s*write/);
  assert.match(prepare, /actions:\s*read/);
  assert.match(prepare, /pull-requests:\s*read/);
  assert.match(prepare, /attestations:\s*read/);
  assert.match(prepare, /repos\/\$\{REPO\}\/commits\/\$\{RELEASE_SHA\}\/pulls/);
  assert.match(prepare, /\.head\.ref == "main"/);
  assert.match(prepare, /\.base\.ref == "release"/);
  assert.match(prepare, /release-merge\.mjs verify/);
  assert.match(prepare, /release-promotion\.mjs read-selector/);
  assert.match(prepare, /actions\/runs\/\$\{CANDIDATE_RUN_ID\}\/attempts\/\$\{CANDIDATE_RUN_ATTEMPT\}\/jobs/);
  assert.match(prepare, /actions\/artifacts\/\$\{EVIDENCE_ARTIFACT_ID\}\/zip/);
  assert.match(prepare, /gh attestation verify/);
  assert.match(prepare, /release-promotion\.mjs[^]*?verify-candidate/);
  assert.ok(prepare.indexOf('verify-candidate') < tagPosition, '候选证据预检必须发生在创建 tag 前');
  assert.match(prepare, /repos\/\$\{REPO\}\/git\/tags/);
  assert.match(prepare, /repos\/\$\{REPO\}\/git\/refs/);
  assert.match(prepare, /gh release create "\$TAG"[^]*?--draft[^]*?--verify-tag/);
  assert.doesNotMatch(prepare, /--force|--clobber/);
});

test('正式发布只搬运候选字节并在单一受限 job 生产重签，不再重新编译', () => {
  const content = workflow();
  const stage = job(content, 'stage-candidate');
  const production = job(content, 'production-release');

  assert.doesNotMatch(
    content,
    /cargo\s+(?:build|install)|tauri(?:\s+--)?\s*build|npm run tauri[^\n]*build|rust-toolchain|rust-cache/,
  );
  assert.match(stage, /actions:\s*read/);
  assert.match(stage, /actions\/artifacts\/\$\{ARTIFACT_ID\}\/zip/);
  assert.match(stage, /release-promotion\.mjs materialize-release/);
  assert.match(stage, /candidate-manifest\.json/);
  assert.match(stage, /candidate-build-provenance\.json/);
  assert.doesNotMatch(stage, /environment:\s*release|TAURI_SIGNING_PRIVATE_KEY|secrets\./);

  assert.match(production, /^\s+environment:\s*release\s*$/m);
  assert.match(production, /TAURI_SIGNING_PRIVATE_KEY:\s*\$\{\{ secrets\.TAURI_SIGNING_PRIVATE_KEY \}\}/);
  assert.match(
    production,
    /TAURI_SIGNING_PRIVATE_KEY_PASSWORD:\s*\$\{\{ secrets\.TAURI_SIGNING_PRIVATE_KEY_PASSWORD \}\}/,
  );
  assert.equal((content.match(/^\s+environment:\s*release\s*$/gm) ?? []).length, 1);
  assert.match(production, /sign-release-updater\.mjs/);
  assert.match(production, /release-promotion\.mjs create-promotion-binding/);
  assert.match(production, /promotion-binding\.json/);
  assert.match(production, /release-provenance\.json/);
});

test('候选搬运使用清单中的精确 ID 与 digest，验证每个候选字节后丢弃临时签名', () => {
  const stage = job(workflow(), 'stage-candidate');

  assert.match(stage, /jq -c '\.artifacts\[\]'/);
  assert.match(stage, /ARTIFACT_ID="\$\(jq -r '\.id'/);
  assert.match(stage, /ARTIFACT_DIGEST="\$\(jq -r '\.digest'/);
  assert.match(stage, /\.expired == false/);
  assert.match(stage, /sha256sum "\$ARCHIVE"/);
  assert.match(stage, /candidate-build-provenance\.json/);
  assert.match(stage, /--source-digest "\$CANDIDATE_SHA"/);
  assert.match(stage, /--source-ref refs\/heads\/main/);
  assert.match(stage, /candidate-byte-reuse\.json/);
  assert.doesNotMatch(stage, /sign-release-updater\.mjs|latest\.json|SHA256SUMS/);
});

test('正式生成 provenance 只覆盖生产签名、元数据、校验和与晋级证明', () => {
  const production = job(workflow(), 'production-release');
  const attestation = production.match(
    /- name: 为正式生成文件创建独立 provenance[\s\S]*?(?=\n\s+- name:)/,
  )?.[0] ?? '';

  assert.match(production, /release-assets\.mjs metadata/);
  assert.match(production, /release-assets\.mjs checksums/);
  assert.match(attestation, /uses:\s*actions\/attest@[0-9a-f]{40}/);
  assert.match(attestation, /release-assets\/\*\.sig/);
  assert.match(attestation, /latest\.json/);
  assert.match(attestation, /SHA256SUMS/);
  assert.match(attestation, /promotion-binding\.json/);
  assert.doesNotMatch(attestation, /\.dmg|\.msi|\.deb|\.rpm|\.AppImage|app\.tar\.gz|skill-expert-cli/);
});

test('最终门禁从 Draft 回验候选哈希、生产 Updater、晋级绑定、双层 provenance 与原生包', () => {
  const content = workflow();
  const verify = job(content, 'verify-release');
  const verifyMacos = job(content, 'verify-macos');
  const verifyNative = job(content, 'verify-native');
  const draftDownload = fs.readFileSync(draftDownloadScriptPath, 'utf8');

  assert.match(draftDownload, /releases\/assets\/\$ASSET_ID/);
  assert.match(verify, /release-assets\.mjs verify/);
  assert.match(verify, /sha256sum --check SHA256SUMS/);
  assert.match(verify, /verify-updater-metadata\.mjs/);
  assert.match(verify, /verify-promotion-binding/);
  assert.match(verify, /candidate-build-provenance\.json/);
  assert.match(verify, /release-provenance\.json/);
  assert.match(verify, /--source-digest "\$CANDIDATE_SHA"[^]*?refs\/heads\/main/);
  assert.match(verify, /--source-digest "\$RELEASE_SHA"[^]*?refs\/heads\/release/);

  assert.match(verifyMacos, /runner:\s*macos-latest/);
  assert.match(verifyMacos, /runner:\s*macos-15-intel/);
  assert.match(verifyMacos, /verify-macos-release\.mjs/);
  assert.doesNotMatch(verifyMacos, /notari[sz]|spctl/i);
  assert.match(verifyNative, /windows-latest/);
  assert.match(verifyNative, /ubuntu-22\.04/);
  assert.match(verifyNative, /verify-windows-release\.ps1/);
  assert.match(verifyNative, /verify-linux-release\.mjs/);
  assert.match(verifyNative, /libarchive-tools/);
});

test('所有 Draft 读取 job 复用同一下载脚本且不修改 Release', () => {
  const content = workflow();
  assert.equal(
    (content.match(/bash scripts\/download-draft-release-assets\.sh release-assets/g) ?? []).length,
    3,
  );
  for (const name of ['verify-release', 'verify-macos', 'verify-native']) {
    const verification = job(content, name);
    assert.match(verification, /permissions:\n\s+contents: read/);
    assert.doesNotMatch(verification, /gh release (?:create|edit|upload|delete)/);
  }
});

test('只有通用、macOS、Windows 和 Linux 门禁全部通过才公开 Latest', () => {
  const content = workflow();
  const publish = job(content, 'publish-release');

  assert.match(publish, /needs:\s*\[verify-release, verify-macos, verify-native\]/);
  assert.match(publish, /gh release edit "\$TAG"[^]*?--draft=false[^]*?--latest/);
  assert.doesNotMatch(content, /gh release delete|git tag -[fd]|git push[^\n]*--delete/);
});

test('同一 workflow 重跑只恢复匹配 run id 的 annotated tag 与唯一 Draft', () => {
  const content = workflow();
  const prepare = job(content, 'prepare-release');
  const production = job(content, 'production-release');
  const tagStep = prepare.match(
    /- name: 创建不可变 annotated tag[\s\S]*?(?=\n\s+- name:)/,
  )?.[0] ?? '';

  assert.match(prepare, /RUN_ATTEMPT/);
  assert.match(prepare, /--recovery-run-id "\$RUN_ID"/);
  assert.match(prepare, /TAG_EXISTS/);
  assert.match(prepare, /DRAFT_COUNT/);
  assert.match(prepare, /release-assets\.mjs draft-state/);
  assert.match(prepare, /reuse_draft_assets/);
  assert.match(tagStep, /workflow-run-id: \$\{RUN_ID\}/);
  assert.match(production, /reuse_draft_assets != 'true'/);
  assert.match(production, /既有 Draft 已包含精确完整资产/);
  assert.doesNotMatch(production, /--clobber/);
  assert.doesNotMatch(prepare, /target_commitish/);
});

test('正式发布第三方 Action 全部固定 SHA 并由普通 CI 执行契约测试', () => {
  const content = workflow();
  const references = [...content.matchAll(/^\s+-?\s*uses:\s*([^\s#]+)(?:\s+#.*)?$/gm)].map(
    (match) => match[1],
  );
  for (const reference of references) {
    assert.match(reference, /@[0-9a-f]{40}$/, `${reference} 必须固定完整 commit SHA`);
  }

  const packageJson = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'));
  const testWorkflow = fs.readFileSync(testWorkflowPath, 'utf8');
  assert.equal(
    packageJson.scripts['test:formal-release'],
    'node --test scripts/release-merge.test.mjs scripts/release-assets.test.mjs scripts/release-binary-version.test.mjs scripts/sign-release-updater.test.mjs scripts/download-draft-release-assets.test.mjs scripts/release-orchestration-workflow.test.mjs scripts/verify-linux-release.test.mjs scripts/verify-macos-release.test.mjs scripts/formal-release-docs.test.mjs',
  );
  assert.match(testWorkflow, /run:\s*npm run test:formal-release/);
  assert.doesNotMatch(content, /[“”]/, 'workflow Shell 不得包含会被误判为引号的弯引号');
});
