import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workflowPath = path.join(repositoryRoot, '.github/workflows/release.yml');
const testWorkflowPath = path.join(repositoryRoot, '.github/workflows/test.yml');

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

test('前置门禁绑定唯一 main 到 release 合并并创建不可变 annotated tag 与 Draft', () => {
  const prepare = job(workflow(), 'prepare-release');

  assert.match(prepare, /contents:\s*write/);
  assert.match(prepare, /pull-requests:\s*read/);
  assert.match(prepare, /repos\/\$\{REPO\}\/commits\/\$\{RELEASE_SHA\}\/pulls/);
  assert.match(prepare, /\.head\.ref == "main"/);
  assert.match(prepare, /\.base\.ref == "release"/);
  assert.match(prepare, /\.merge_commit_sha == \$release_sha/);
  assert.match(prepare, /release-merge\.mjs verify/);
  assert.match(prepare, /github\.run_attempt/);
  assert.match(prepare, /--allow-existing-tag/);
  assert.match(prepare, /repos\/\$\{REPO\}\/git\/tags/);
  assert.match(prepare, /repos\/\$\{REPO\}\/git\/refs/);
  assert.match(prepare, /tag_exists/);
  assert.match(prepare, /draft_exists/);
  assert.match(prepare, /gh release create "\$TAG"[^]*?--draft[^]*?--verify-tag/);
  assert.doesNotMatch(prepare, /--force|--clobber/);
});

test('四目标正式构建只读取 release Environment 的 Updater Secret 并保持 macOS ad-hoc', () => {
  const build = job(workflow(), 'build-release');
  const targets = [...build.matchAll(/^\s+- target_id:\s*([^\s]+)\s*$/gm)]
    .map((match) => match[1])
    .sort();

  assert.deepEqual(targets, ['linux-x64', 'macos-arm64', 'macos-x64', 'windows-x64']);
  assert.match(build, /^\s+environment:\s*release\s*$/m);
  assert.match(build, /TAURI_SIGNING_PRIVATE_KEY:\s*\$\{\{ secrets\.TAURI_SIGNING_PRIVATE_KEY \}\}/);
  assert.match(
    build,
    /TAURI_SIGNING_PRIVATE_KEY_PASSWORD:\s*\$\{\{ secrets\.TAURI_SIGNING_PRIVATE_KEY_PASSWORD \}\}/,
  );
  assert.match(build, /APPLE_SIGNING_IDENTITY:\s*"-"/);
  assert.match(build, /verify-macos-adhoc\.mjs/);
  assert.match(build, /sign-release-updater\.mjs/);
  assert.match(build, /gh release upload "\$TAG"/);
  assert.doesNotMatch(build, /--clobber/);
  assert.doesNotMatch(
    build,
    /APPLE_CERTIFICATE|APPLE_API_|APPLE_ID|APPLE_PASSWORD|APPLE_TEAM_ID|Developer ID|notari[sz]|spctl/i,
  );
});

test('元数据、校验和与 provenance 都进入同一 Draft 且只有 provenance job 获得 OIDC', () => {
  const content = workflow();
  const metadata = job(content, 'release-metadata');
  const provenance = job(content, 'release-provenance');

  assert.match(metadata, /needs:\s*\[prepare-release, build-release\]/);
  assert.match(metadata, /release-assets\.mjs metadata/);
  assert.match(metadata, /release-assets\.mjs checksums/);
  assert.match(metadata, /gh release upload "\$TAG"[^]*?latest\.json[^]*?SHA256SUMS/);

  assert.match(provenance, /needs:\s*release-metadata/);
  assert.match(provenance, /id-token:\s*write/);
  assert.match(provenance, /attestations:\s*write/);
  assert.match(provenance, /artifact-metadata:\s*write/);
  assert.match(provenance, /uses:\s*actions\/attest@[0-9a-f]{40}/);
  assert.match(provenance, /bundle-path/);
  assert.match(provenance, /build-provenance\.json/);
  assert.match(provenance, /gh release upload "\$TAG"/);

  for (const name of ['prepare-release', 'build-release', 'release-metadata', 'verify-release', 'verify-macos', 'verify-native', 'publish-release']) {
    assert.doesNotMatch(job(content, name), /id-token:\s*write|attestations:\s*write/);
  }
});

test('汇总门禁从 Draft 下载精确资产并验证哈希、Updater、provenance 与 macOS 签名', () => {
  const content = workflow();
  const verify = job(content, 'verify-release');
  const verifyMacos = job(content, 'verify-macos');
  const verifyNative = job(content, 'verify-native');

  assert.match(verify, /needs:\s*release-provenance/);
  assert.match(verify, /releases\/assets\/\$ASSET_ID/);
  assert.match(verify, /release-assets\.mjs verify/);
  assert.match(verify, /sha256sum --check SHA256SUMS/);
  assert.match(verify, /verify-updater-metadata\.mjs/);
  assert.match(verify, /gh attestation verify/);
  assert.match(verify, /--bundle[^]*?build-provenance\.json/);
  assert.match(verify, /--source-digest "\$RELEASE_SHA"/);

  assert.match(verifyMacos, /runs-on:\s*\$\{\{ matrix\.runner \}\}/);
  assert.match(verifyMacos, /runner:\s*macos-latest/);
  assert.match(verifyMacos, /runner:\s*macos-15-intel/);
  assert.match(verifyMacos, /--target "\$TARGET_ID"/);
  assert.match(verifyMacos, /needs:\s*release-provenance/);
  assert.match(verifyMacos, /verify-macos-release\.mjs/);
  assert.doesNotMatch(verifyMacos, /notari[sz]|spctl/i);

  assert.match(verifyNative, /windows-latest/);
  assert.match(verifyNative, /ubuntu-22\.04/);
  assert.match(verifyNative, /verify-windows-release\.ps1/);
  assert.match(verifyNative, /verify-linux-release\.mjs/);
  assert.match(verifyNative, /releases\/assets\/\$ASSET_ID/);
});

test('只有全部汇总门禁通过才公开并标记 Latest', () => {
  const publish = job(workflow(), 'publish-release');

  assert.match(publish, /needs:\s*\[verify-release, verify-macos, verify-native\]/);
  assert.match(publish, /gh release edit "\$TAG"[^]*?--draft=false[^]*?--latest/);
  assert.doesNotMatch(workflow(), /gh release delete|git tag -[fd]|git push[^\n]*--delete/);
});

test('同一工作流重跑只恢复带相同 run id 的已验证 annotated tag 与唯一 Draft', () => {
  const prepare = job(workflow(), 'prepare-release');
  const tagStep = prepare.match(
    /- name: 创建不可变 annotated tag[\s\S]*?(?=\n\s+- name:)/,
  )?.[0] ?? '';

  assert.match(prepare, /TAG_EXISTS/);
  assert.match(prepare, /DRAFT_COUNT/);
  assert.match(prepare, /RUN_ID:\s*\$\{\{ github\.run_id \}\}/);
  assert.match(prepare, /--recovery-run-id "\$RUN_ID"/);
  assert.match(tagStep, /RUN_ID:\s*\$\{\{ github\.run_id \}\}/);
  assert.match(tagStep, /workflow-run-id: \$\{RUN_ID\}/);
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
    'node --test scripts/release-merge.test.mjs scripts/release-assets.test.mjs scripts/release-binary-version.test.mjs scripts/sign-release-updater.test.mjs scripts/release-orchestration-workflow.test.mjs scripts/verify-linux-release.test.mjs scripts/verify-macos-release.test.mjs scripts/formal-release-docs.test.mjs',
  );
  assert.match(testWorkflow, /run:\s*npm run test:formal-release/);
  assert.match(
    testWorkflow,
    /if:\s*runner\.os == 'macOS'[^]*?node --test scripts\/verify-macos-release\.test\.mjs/,
  );
  assert.match(
    testWorkflow,
    /if:\s*runner\.os == 'Windows'[^]*?verify-windows-release\.ps1/,
  );
  assert.doesNotMatch(content, /[“”]/, 'workflow shell 脚本不得包含 ShellCheck 误判为引号的弯引号');
});
