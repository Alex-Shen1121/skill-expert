import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { expectedCandidateAssets } from './candidate-assets.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const contractCli = path.join(repositoryRoot, 'scripts/release-promotion.mjs');
const repositoryName = 'Alex-Shen1121/skill-expert';
const runId = 9001;
const runAttempt = 2;
const targets = ['macos-arm64', 'macos-x64', 'windows-x64', 'linux-x64'];
const dailyChecks = [
  'GitHub Actions syntax',
  'Frontend and version contract',
  'Rust quality and Linux check',
  'Rust tests (macOS)',
  'Rust tests (Windows)',
];

function git(repository, ...args) {
  const result = spawnSync('git', args, { cwd: repository, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function write(repository, relativePath, content) {
  const filePath = path.join(repository, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
}

function writeJson(repository, relativePath, value) {
  write(repository, relativePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeVersionContract(repository, version) {
  writeJson(repository, 'package.json', { name: 'skill-expert', version });
  writeJson(repository, 'package-lock.json', {
    name: 'skill-expert',
    version,
    packages: { '': { name: 'skill-expert', version } },
  });
  writeJson(repository, 'src-tauri/tauri.conf.json', { version });
  write(repository, 'src-tauri/Cargo.toml', `[package]\nname = "skill-expert"\nversion = "${version}"\n`);
  write(
    repository,
    'src-tauri/Cargo.lock',
    `version = 4\n\n[[package]]\nname = "skill-expert"\nversion = "${version}"\n`,
  );
  for (const locale of ['en', 'zh', 'zh-TW']) {
    writeJson(repository, `src/i18n/${locale}.json`, {
      settings: { version: `Skill Expert version ${version}` },
    });
  }
  write(
    repository,
    'CHANGELOG.md',
    `# Changelog\n\n## [Unreleased]\n\n## [${version}] - 2026-08-28\n\n- Reuse candidate assets.\n`,
  );
  write(
    repository,
    'CHANGELOG-zh.md',
    `# 更新日志\n\n## [Unreleased]\n\n## [${version}] - 2026-08-28\n\n- 复用候选资产。\n`,
  );
}

function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function candidateRole(filename, inventory) {
  if (filename.endsWith('.sig')) return 'candidate-updater-signature';
  if (filename.startsWith('skill-expert-cli-')) return 'cli';
  if (inventory.includes(`${filename}.sig`)) return 'updater-package';
  return 'desktop-installer';
}

function createFixture(t) {
  const repository = mkdtempSync(path.join(tmpdir(), 'skill-expert-promotion-contract-'));
  t.after(() => rmSync(repository, { recursive: true, force: true }));
  git(repository, 'init', '-b', 'release');
  git(repository, 'config', 'user.name', '发布晋级契约测试');
  git(repository, 'config', 'user.email', 'promotion-contract@example.com');
  writeVersionContract(repository, '1.0.3');
  git(repository, 'add', '.');
  git(repository, 'commit', '-m', '测试：建立发布分支基线');
  const releaseBaselineSha = git(repository, 'rev-parse', 'HEAD');

  git(repository, 'switch', '-c', 'main');
  writeVersionContract(repository, '1.0.4');
  git(repository, 'add', '.');
  git(repository, 'commit', '-m', '测试：建立正式候选');
  const candidateSha = git(repository, 'rev-parse', 'HEAD');
  const candidateTree = git(repository, 'rev-parse', 'HEAD^{tree}');

  const evidenceDirectory = path.join(repository, 'candidate-evidence');
  mkdirSync(evidenceDirectory);
  const jobs = [
    ...dailyChecks.map((name, index) => ({
      id: 1000 + index,
      name,
      status: 'completed',
      conclusion: 'success',
      run_attempt: runAttempt,
      head_sha: candidateSha,
    })),
    ...targets.map((target, index) => ({
      id: 2000 + index,
      name: `candidate-package / Candidate (${target})`,
      status: 'completed',
      conclusion: 'success',
      run_attempt: runAttempt,
      head_sha: candidateSha,
    })),
  ];
  const artifacts = targets.map((target, index) => ({
    id: 3000 + index,
    name: `skill-expert-candidate-${candidateSha}-${runAttempt}-${target}`,
    digest: `sha256:${String(index + 1).repeat(64)}`,
    size_in_bytes: 1000 + index,
    expired: false,
    workflow_run: { id: runId, head_branch: 'main', head_sha: candidateSha },
  }));
  const manifest = {
    schemaVersion: 1,
    purpose: 'formal-release-candidate',
    repository: repositoryName,
    version: '1.0.4',
    candidate: {
      sha: candidateSha,
      tree: candidateTree,
      sourceRef: 'refs/heads/main',
    },
    workflow: {
      path: '.github/workflows/test.yml',
      builderPath: '.github/workflows/candidate-build.yml',
      revision: candidateSha,
      runId,
      runAttempt,
    },
    jobs: targets.map((target, index) => ({
      target,
      id: 2000 + index,
      name: `candidate-package / Candidate (${target})`,
      conclusion: 'success',
      runAttempt,
    })),
    artifacts: artifacts.map((artifact, index) => {
      const inventory = expectedCandidateAssets('1.0.4', targets[index]);
      return {
        target: targets[index],
        id: artifact.id,
        name: artifact.name,
        digest: artifact.digest,
        size: artifact.size_in_bytes,
        files: inventory.map((name, fileIndex) => ({
          name,
          role: candidateRole(name, inventory),
          size: 100 + fileIndex,
          sha256: String(index + 1).repeat(63) + String(fileIndex + 1),
        })),
      };
    }),
  };
  const manifestContent = `${JSON.stringify(manifest, null, 2)}\n`;
  write(evidenceDirectory, 'candidate-manifest.json', manifestContent);
  writeJson(evidenceDirectory, 'candidate-build-provenance.json', { mediaType: 'application/vnd.dev.sigstore.bundle.v0.3+json' });

  const evidenceArtifact = {
    id: 3999,
    name: `skill-expert-candidate-evidence-${candidateSha}-${runId}-${runAttempt}`,
    digest: `sha256:${'9'.repeat(64)}`,
    size_in_bytes: 2048,
    expired: false,
    workflow_run: { id: runId, head_branch: 'main', head_sha: candidateSha },
  };
  artifacts.push(evidenceArtifact);
  const selector = {
    schemaVersion: 1,
    runId,
    runAttempt,
    evidenceArtifactId: evidenceArtifact.id,
    evidenceArtifactName: evidenceArtifact.name,
    evidenceArtifactDigest: evidenceArtifact.digest,
    manifestSha256: sha256(manifestContent),
  };
  write(
    repository,
    'release-pr.md',
    `# 发布晋级\n\n<!-- skill-expert-candidate-selector:v1 ${JSON.stringify(selector)} -->\n`,
  );
  writeJson(repository, 'run.json', {
    id: runId,
    run_attempt: runAttempt,
    event: 'push',
    status: 'completed',
    conclusion: 'success',
    head_branch: 'main',
    head_sha: candidateSha,
    path: '.github/workflows/test.yml',
  });
  writeJson(repository, 'jobs.json', { total_count: jobs.length, jobs });
  writeJson(repository, 'artifacts.json', { total_count: artifacts.length, artifacts });
  writeJson(repository, 'provenance-report.json', [
    {
      verificationResult: {
        statement: {
          subject: [
            { name: 'candidate-manifest.json', digest: { sha256: sha256(manifestContent) } },
            ...manifest.artifacts.flatMap((artifact) =>
              artifact.files.map((file) => ({ name: file.name, digest: { sha256: file.sha256 } })),
            ),
          ],
        },
      },
    },
  ]);

  return {
    repository,
    candidateSha,
    candidateTree,
    releaseBaselineSha,
    manifest,
    selector,
    evidenceDirectory,
  };
}

function verifyCandidate(values) {
  return spawnSync(
    process.execPath,
    [
      contractCli,
      'verify-candidate',
      '--repository',
      repositoryName,
      '--candidate-sha',
      values.candidateSha,
      '--head',
      'main',
      '--base',
      'release',
      '--pr-body',
      'release-pr.md',
      '--run-response',
      'run.json',
      '--jobs-response',
      'jobs.json',
      '--artifacts-response',
      'artifacts.json',
      '--evidence-directory',
      'candidate-evidence',
      '--provenance-report',
      'provenance-report.json',
      '--json',
    ],
    {
      cwd: values.repository,
      encoding: 'utf8',
      env: {
        ...process.env,
        SKILL_EXPERT_RELEASE_BASELINE_SHA: values.releaseBaselineSha,
      },
    },
  );
}

function rewriteManifestEvidence(values, mutate) {
  const manifestPath = path.join(values.evidenceDirectory, 'candidate-manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  mutate(manifest);
  const manifestContent = `${JSON.stringify(manifest, null, 2)}\n`;
  writeFileSync(manifestPath, manifestContent);
  values.selector.manifestSha256 = sha256(manifestContent);
  write(
    values.repository,
    'release-pr.md',
    `<!-- skill-expert-candidate-selector:v1 ${JSON.stringify(values.selector)} -->\n`,
  );
  writeJson(values.repository, 'provenance-report.json', [
    {
      verificationResult: {
        statement: {
          subject: [
            {
              name: 'candidate-manifest.json',
              digest: { sha256: values.selector.manifestSha256 },
            },
            ...manifest.artifacts.flatMap((artifact) =>
              artifact.files.map((file) => ({
                name: file.name,
                digest: { sha256: file.sha256 },
              })),
            ),
          ],
        },
      },
    },
  ]);
  return manifest;
}

test('发布晋级契约接受绑定同一 run attempt 的完整四平台候选', (t) => {
  const values = createFixture(t);
  const result = verifyCandidate(values);

  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.decision, 'promotable');
  assert.equal(report.candidateSha, values.candidateSha);
  assert.equal(report.candidateTree, values.candidateTree);
  assert.equal(report.runId, runId);
  assert.equal(report.runAttempt, runAttempt);
  assert.equal(report.manifestSha256, values.selector.manifestSha256);
  assert.deepEqual(report.artifactIds, values.manifest.artifacts.map(({ id }) => id));
});

test('发布晋级契约拒绝缺少现有安装格式的候选文件清单', (t) => {
  const values = createFixture(t);
  rewriteManifestEvidence(values, (manifest) => {
    const windows = manifest.artifacts.find(({ target }) => target === 'windows-x64');
    windows.files = windows.files.filter(({ name }) => !name.endsWith('.msi'));
  });

  const result = verifyCandidate(values);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /windows-x64.*文件清单不完整/);
});

test('发布晋级契约拒绝失败 run、错误 attempt 与过期 artifact', async (t) => {
  await t.test('run 未成功完成', () => {
    const values = createFixture(t);
    const run = JSON.parse(readFileSync(path.join(values.repository, 'run.json'), 'utf8'));
    run.conclusion = 'failure';
    writeJson(values.repository, 'run.json', run);

    const result = verifyCandidate(values);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /候选 run 未成功完成/);
  });

  await t.test('候选 job 来自错误 attempt', () => {
    const values = createFixture(t);
    const jobs = JSON.parse(readFileSync(path.join(values.repository, 'jobs.json'), 'utf8'));
    jobs.jobs.find(({ id }) => id === 2000).run_attempt = runAttempt - 1;
    writeJson(values.repository, 'jobs.json', jobs);

    const result = verifyCandidate(values);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /不属于选择的 run attempt/);
  });

  await t.test('候选 artifact 已过期', () => {
    const values = createFixture(t);
    const artifacts = JSON.parse(
      readFileSync(path.join(values.repository, 'artifacts.json'), 'utf8'),
    );
    artifacts.artifacts.find(({ id }) => id === 3000).expired = true;
    writeJson(values.repository, 'artifacts.json', artifacts);

    const result = verifyCandidate(values);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /候选 artifact 3000 已过期/);
  });
});

test('发布晋级契约拒绝手工测试包与被改写的候选身份', async (t) => {
  await t.test('手工测试用途不可晋级', () => {
    const values = createFixture(t);
    rewriteManifestEvidence(values, (manifest) => {
      manifest.purpose = 'manual-test-package';
    });

    const result = verifyCandidate(values);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /候选清单用途不可晋级/);
  });

  await t.test('workflow revision 不等于 candidate SHA', () => {
    const values = createFixture(t);
    rewriteManifestEvidence(values, (manifest) => {
      manifest.workflow.revision = 'f'.repeat(40);
    });

    const result = verifyCandidate(values);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /候选 workflow revision 不等于 candidate SHA/);
  });

  await t.test('PR 缺少唯一候选选择器', () => {
    const values = createFixture(t);
    write(values.repository, 'release-pr.md', '# 发布晋级\n');

    const result = verifyCandidate(values);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /必须包含唯一候选选择器/);
  });
});

test('公开 CLI 从实际候选目录和 GitHub 响应生成不可变候选清单', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'skill-expert-candidate-manifest-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const candidateSha = 'a'.repeat(40);
  const candidateTree = 'b'.repeat(40);
  const jobs = targets.map((target, index) => ({
    id: 4100 + index,
    name: `candidate-package / Candidate (${target})`,
    status: 'completed',
    conclusion: 'success',
    run_attempt: 3,
    head_sha: candidateSha,
  }));
  const artifacts = targets.map((target, index) => ({
    id: 5100 + index,
    name: `skill-expert-candidate-${candidateSha}-3-${target}`,
    digest: `sha256:${String(index + 3).repeat(64)}`,
    size_in_bytes: 8000 + index,
    expired: false,
    workflow_run: { id: 7001, head_branch: 'main', head_sha: candidateSha },
  }));
  for (const target of targets) {
    const inventory = expectedCandidateAssets('1.0.4', target);
    for (const filename of inventory) {
      write(root, `assets/${target}/${filename}`, `候选字节：${target}/${filename}\n`);
    }
  }
  writeJson(root, 'run.json', {
    id: 7001,
    run_attempt: 3,
    event: 'push',
    status: 'in_progress',
    conclusion: null,
    head_branch: 'main',
    head_sha: candidateSha,
    path: '.github/workflows/test.yml',
  });
  writeJson(root, 'jobs.json', { jobs });
  writeJson(root, 'artifacts.json', { artifacts });

  const result = spawnSync(
    process.execPath,
    [
      contractCli,
      'create-manifest',
      '--repository',
      repositoryName,
      '--version',
      '1.0.4',
      '--candidate-sha',
      candidateSha,
      '--candidate-tree',
      candidateTree,
      '--source-ref',
      'refs/heads/main',
      '--workflow-path',
      '.github/workflows/test.yml',
      '--builder-workflow-path',
      '.github/workflows/candidate-build.yml',
      '--workflow-revision',
      candidateSha,
      '--run-id',
      '7001',
      '--run-attempt',
      '3',
      '--run-response',
      'run.json',
      '--jobs-response',
      'jobs.json',
      '--artifacts-response',
      'artifacts.json',
      '--assets-directory',
      'assets',
      '--output',
      'candidate-manifest.json',
    ],
    { cwd: root, encoding: 'utf8' },
  );

  assert.equal(result.status, 0, result.stderr);
  const manifest = JSON.parse(readFileSync(path.join(root, 'candidate-manifest.json'), 'utf8'));
  assert.equal(manifest.purpose, 'formal-release-candidate');
  assert.equal(manifest.candidate.sha, candidateSha);
  assert.equal(manifest.candidate.tree, candidateTree);
  assert.equal(manifest.workflow.runId, 7001);
  assert.equal(manifest.workflow.runAttempt, 3);
  assert.deepEqual(manifest.artifacts.map(({ id }) => id), [5100, 5101, 5102, 5103]);
  const macCli = manifest.artifacts[0].files.find(({ role }) => role === 'cli');
  const macCliContent = readFileSync(path.join(root, 'assets/macos-arm64', macCli.name));
  assert.equal(macCli.size, macCliContent.byteLength);
  assert.equal(macCli.sha256, sha256(macCliContent));
  assert.equal(
    manifest.artifacts[0].files.find(({ name }) => name.endsWith('.app.tar.gz.sig')).role,
    'candidate-updater-signature',
  );
});

test('正式搬运逐字节复用候选本体并丢弃全部临时签名', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'skill-expert-materialize-release-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const manifest = {
    schemaVersion: 1,
    purpose: 'formal-release-candidate',
    repository: repositoryName,
    version: '1.0.4',
    candidate: { sha: 'a'.repeat(40), tree: 'b'.repeat(40), sourceRef: 'refs/heads/main' },
    workflow: {
      path: '.github/workflows/test.yml',
      builderPath: '.github/workflows/candidate-build.yml',
      revision: 'a'.repeat(40),
      runId: 7100,
      runAttempt: 1,
    },
    jobs: [],
    artifacts: [],
  };
  for (const [targetIndex, target] of targets.entries()) {
    const inventory = expectedCandidateAssets('1.0.4', target);
    const files = inventory.map((name, fileIndex) => {
      const content = Buffer.from(`真实候选字节：${target}/${name}\n`);
      write(root, `candidate-assets/${target}/${name}`, content);
      return {
        name,
        role: candidateRole(name, inventory),
        size: content.byteLength,
        sha256: sha256(content),
      };
    });
    manifest.artifacts.push({
      target,
      id: 6100 + targetIndex,
      name: `skill-expert-candidate-${manifest.candidate.sha}-1-${target}`,
      digest: `sha256:${String(targetIndex + 1).repeat(64)}`,
      size: 9000 + targetIndex,
      files,
    });
  }
  writeJson(root, 'candidate-manifest.json', manifest);

  const result = spawnSync(
    process.execPath,
    [
      contractCli,
      'materialize-release',
      '--manifest',
      'candidate-manifest.json',
      '--candidate-assets-directory',
      'candidate-assets',
      '--release-assets-directory',
      'release-assets',
      '--output',
      'candidate-byte-reuse.json',
    ],
    { cwd: root, encoding: 'utf8' },
  );

  assert.equal(result.status, 0, result.stderr);
  const reuse = JSON.parse(readFileSync(path.join(root, 'candidate-byte-reuse.json'), 'utf8'));
  const expectedBodies = manifest.artifacts
    .flatMap(({ files }) => files)
    .filter(({ role }) => role !== 'candidate-updater-signature');
  assert.equal(reuse.files.length, expectedBodies.length);
  for (const file of expectedBodies) {
    const released = readFileSync(path.join(root, 'release-assets', file.name));
    assert.equal(sha256(released), file.sha256);
  }
  assert.equal(
    reuse.files.filter(({ role }) => role === 'candidate-updater-signature').length,
    0,
  );
  assert.equal(
    manifest.artifacts
      .flatMap(({ files }) => files)
      .filter(({ role }) => role === 'candidate-updater-signature')
      .every(({ name }) => !readFileSync(path.join(root, 'candidate-byte-reuse.json'), 'utf8').includes(`"name": "${name}"`)),
    true,
  );
});

test('晋级绑定证明同时记录 release、candidate、tree、run、artifact 与本体哈希', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'skill-expert-promotion-binding-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const candidateSha = 'a'.repeat(40);
  const releaseSha = 'b'.repeat(40);
  const tree = 'c'.repeat(40);
  const reuse = {
    schemaVersion: 1,
    purpose: 'candidate-byte-reuse',
    repository: repositoryName,
    version: '1.0.4',
    candidate: { sha: candidateSha, tree, sourceRef: 'refs/heads/main' },
    workflow: {
      path: '.github/workflows/test.yml',
      builderPath: '.github/workflows/candidate-build.yml',
      revision: candidateSha,
      runId: 7200,
      runAttempt: 2,
    },
    manifestSha256: 'd'.repeat(64),
    artifacts: targets.map((target, index) => ({
      target,
      id: 7300 + index,
      name: `artifact-${target}`,
      digest: `sha256:${String(index + 1).repeat(64)}`,
    })),
    files: [{ name: 'installer.bin', role: 'desktop-installer', size: 10, sha256: 'e'.repeat(64) }],
  };
  writeJson(root, 'candidate-byte-reuse.json', reuse);

  const result = spawnSync(
    process.execPath,
    [
      contractCli,
      'create-promotion-binding',
      '--reuse-report',
      'candidate-byte-reuse.json',
      '--version',
      '1.0.4',
      '--tag',
      'v1.0.4',
      '--release-sha',
      releaseSha,
      '--candidate-sha',
      candidateSha,
      '--release-tree',
      tree,
      '--candidate-tree',
      tree,
      '--output',
      'promotion-binding.json',
    ],
    { cwd: root, encoding: 'utf8' },
  );

  assert.equal(result.status, 0, result.stderr);
  const binding = JSON.parse(readFileSync(path.join(root, 'promotion-binding.json'), 'utf8'));
  assert.equal(binding.purpose, 'release-promotion-binding');
  assert.deepEqual(binding.release, { sha: releaseSha, tree, ref: 'refs/heads/release', tag: 'v1.0.4' });
  assert.equal(binding.candidate.sha, candidateSha);
  assert.equal(binding.candidate.tree, tree);
  assert.equal(binding.candidate.runId, 7200);
  assert.equal(binding.candidate.runAttempt, 2);
  assert.equal(binding.candidate.manifestSha256, reuse.manifestSha256);
  assert.deepEqual(binding.candidate.artifacts, reuse.artifacts);
  assert.deepEqual(binding.reusedFiles, reuse.files);
});

test('最终门禁重新计算晋级绑定中的候选本体哈希并拒绝替换字节', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'skill-expert-verify-promotion-binding-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const releaseSha = 'a'.repeat(40);
  const candidateSha = 'b'.repeat(40);
  const tree = 'c'.repeat(40);
  const content = Buffer.from('不可替换的候选安装包\n');
  write(root, 'release-assets/installer.bin', content);
  const artifactIdentities = targets.map((target, index) => ({
    target,
    id: 8200 + index,
    name: `artifact-${target}`,
    digest: `sha256:${String(index + 1).repeat(64)}`,
  }));
  writeJson(root, 'release-assets/candidate-manifest.json', {
    schemaVersion: 1,
    purpose: 'formal-release-candidate',
    repository: repositoryName,
    version: '1.0.4',
    candidate: { sha: candidateSha, tree, sourceRef: 'refs/heads/main' },
    workflow: {
      path: '.github/workflows/test.yml',
      builderPath: '.github/workflows/candidate-build.yml',
      revision: candidateSha,
      runId: 8100,
      runAttempt: 1,
    },
    artifacts: artifactIdentities.map((artifact) => ({
      ...artifact,
      size: 1000,
      files:
        artifact.target === 'macos-arm64'
          ? [
              {
                name: 'installer.bin',
                role: 'desktop-installer',
                size: content.byteLength,
                sha256: sha256(content),
              },
            ]
          : [],
    })),
  });
  const manifestSha256 = sha256(
    readFileSync(path.join(root, 'release-assets/candidate-manifest.json')),
  );
  writeJson(root, 'release-assets/promotion-binding.json', {
    schemaVersion: 1,
    purpose: 'release-promotion-binding',
    repository: repositoryName,
    version: '1.0.4',
    release: { sha: releaseSha, tree, ref: 'refs/heads/release', tag: 'v1.0.4' },
    candidate: {
      sha: candidateSha,
      tree,
      ref: 'refs/heads/main',
      runId: 8100,
      runAttempt: 1,
      workflowPath: '.github/workflows/test.yml',
      builderWorkflowPath: '.github/workflows/candidate-build.yml',
      manifestSha256,
      artifacts: artifactIdentities,
    },
    reusedFiles: [
      {
        name: 'installer.bin',
        role: 'desktop-installer',
        size: content.byteLength,
        sha256: sha256(content),
        target: 'macos-arm64',
      },
    ],
  });
  const argumentsList = [
    contractCli,
    'verify-promotion-binding',
    '--binding',
    'release-assets/promotion-binding.json',
    '--release-assets-directory',
    'release-assets',
    '--version',
    '1.0.4',
    '--release-sha',
    releaseSha,
    '--candidate-sha',
    candidateSha,
    '--tree',
    tree,
  ];

  const accepted = spawnSync(process.execPath, argumentsList, { cwd: root, encoding: 'utf8' });
  assert.equal(accepted.status, 0, accepted.stderr);

  const bindingPath = path.join(root, 'release-assets/promotion-binding.json');
  const binding = JSON.parse(readFileSync(bindingPath, 'utf8'));
  binding.candidate.artifacts[0].id += 1;
  writeJson(root, 'release-assets/promotion-binding.json', binding);
  const identityRejected = spawnSync(process.execPath, argumentsList, {
    cwd: root,
    encoding: 'utf8',
  });
  assert.notEqual(identityRejected.status, 0);
  assert.match(identityRejected.stderr, /候选 artifact 身份与候选清单不一致/);
  binding.candidate.artifacts[0].id -= 1;
  writeJson(root, 'release-assets/promotion-binding.json', binding);

  write(root, 'release-assets/installer.bin', '已被替换\n');
  const rejected = spawnSync(process.execPath, argumentsList, { cwd: root, encoding: 'utf8' });
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /候选本体大小或 SHA-256 与晋级绑定不一致/);
});
