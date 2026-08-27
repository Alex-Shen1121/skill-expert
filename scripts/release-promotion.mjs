#!/usr/bin/env node
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expectedCandidateAssets } from './candidate-assets.mjs';
import { renderPrBody, verifyCandidate } from './release-candidate.mjs';

const FULL_SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const ARTIFACT_DIGEST = /^sha256:[0-9a-f]{64}$/;
const TARGETS = ['macos-arm64', 'macos-x64', 'windows-x64', 'linux-x64'];
const DAILY_CHECKS = [
  'GitHub Actions syntax',
  'Frontend and version contract',
  'Rust quality and Linux check',
  'Rust tests (macOS)',
  'Rust tests (Windows)',
];
const SELECTOR_PATTERN =
  /^<!-- skill-expert-candidate-selector:v1 (\{[^\n]+\}) -->$/gm;

function fail(message) {
  throw new Error(message);
}

function parseArguments(argv) {
  const [command, ...rest] = argv;
  const options = { json: false };
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (argument === '--json') {
      options.json = true;
      continue;
    }
    if (!argument?.startsWith('--') || index + 1 >= rest.length) {
      fail(`无效参数：${argument ?? '空值'}`);
    }
    options[argument.slice(2).replaceAll('-', '_')] = rest[index + 1];
    index += 1;
  }
  return { command, options };
}

function requireOptions(options, names) {
  const missing = names.filter((name) => !options[name]);
  if (missing.length > 0) fail(`缺少参数：${missing.map((name) => `--${name.replaceAll('_', '-')}`).join('、')}`);
}

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    fail(`${label}不是有效 JSON：${error.message}`);
  }
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) fail(`${label}必须是正整数`);
  return value;
}

export function parseCandidateSelector(body) {
  const matches = [...body.matchAll(SELECTOR_PATTERN)];
  if (matches.length !== 1) fail('Release PR 必须包含唯一候选选择器');
  let selector;
  try {
    selector = JSON.parse(matches[0][1]);
  } catch (error) {
    fail(`候选选择器不是有效 JSON：${error.message}`);
  }
  if (selector.schemaVersion !== 1) fail('候选选择器 schemaVersion 必须为 1');
  positiveInteger(selector.runId, '候选 run ID');
  positiveInteger(selector.runAttempt, '候选 run attempt');
  positiveInteger(selector.evidenceArtifactId, '候选证据 artifact ID');
  if (!ARTIFACT_DIGEST.test(selector.evidenceArtifactDigest ?? '')) {
    fail('候选证据 artifact digest 必须是 sha256 摘要');
  }
  if (!SHA256.test(selector.manifestSha256 ?? '')) {
    fail('候选清单摘要必须是 64 位 SHA-256');
  }
  if (typeof selector.evidenceArtifactName !== 'string' || selector.evidenceArtifactName === '') {
    fail('候选选择器缺少证据 artifact 名称');
  }
  return selector;
}

function requireSuccessfulJob(job, label, runAttempt, candidateSha) {
  if (!job) fail(`候选 run 缺少 ${label}`);
  if (job.status !== 'completed' || job.conclusion !== 'success') {
    fail(`${label}未成功完成`);
  }
  if (job.run_attempt !== runAttempt) fail(`${label}不属于选择的 run attempt`);
  if (job.head_sha && job.head_sha !== candidateSha) fail(`${label}不属于选择的 candidate SHA`);
}

function requireArtifactIdentity(artifact, expected, selector, candidateSha) {
  if (!artifact) fail(`找不到候选 artifact ID ${expected.id}`);
  if (artifact.name !== expected.name) fail(`artifact ${expected.id} 名称与候选清单不一致`);
  if (artifact.digest !== expected.digest) fail(`artifact ${expected.id} digest 与候选清单不一致`);
  if (artifact.size_in_bytes !== expected.size) fail(`artifact ${expected.id} 大小与候选清单不一致`);
  if (artifact.expired) fail(`候选 artifact ${expected.id} 已过期`);
  if (artifact.workflow_run?.id !== selector.runId) fail(`artifact ${expected.id} 不属于选择的 run`);
  if (artifact.workflow_run?.head_branch !== 'main') {
    fail(`artifact ${expected.id} 不属于 main 候选`);
  }
  if (artifact.workflow_run?.head_sha !== candidateSha) {
    fail(`artifact ${expected.id} 不属于选择的 candidate SHA`);
  }
}

function verifyProvenanceSubjects(report, manifest, manifestSha256) {
  if (!Array.isArray(report) || report.length === 0) fail('候选来源证明验证结果为空');
  const subjects = report.flatMap((entry) => entry.verificationResult?.statement?.subject ?? []);
  const actual = new Map(
    subjects.map((subject) => [subject.name, subject.digest?.sha256]),
  );
  const expected = [
    ['candidate-manifest.json', manifestSha256],
    ...manifest.artifacts.flatMap((artifact) =>
      artifact.files.map((file) => [file.name, file.sha256]),
    ),
  ];
  for (const [name, digest] of expected) {
    if (actual.get(name) !== digest) fail(`候选来源证明未绑定正确主体：${name}`);
  }
}

function expectedCandidateRole(filename, inventory) {
  if (filename.endsWith('.sig')) return 'candidate-updater-signature';
  if (filename.startsWith('skill-expert-cli-')) return 'cli';
  if (inventory.includes(`${filename}.sig`)) return 'updater-package';
  return 'desktop-installer';
}

function parsePositiveInteger(value, label) {
  if (!/^[1-9]\d*$/.test(value ?? '')) fail(`${label}必须是正整数`);
  return Number(value);
}

export function createCandidateManifest(options) {
  requireOptions(options, [
    'repository',
    'version',
    'candidate_sha',
    'candidate_tree',
    'source_ref',
    'workflow_path',
    'builder_workflow_path',
    'workflow_revision',
    'run_id',
    'run_attempt',
    'run_response',
    'jobs_response',
    'artifacts_response',
    'assets_directory',
    'output',
  ]);
  if (!/^\d+\.\d+\.\d+$/.test(options.version)) fail('候选版本必须是稳定的 x.y.z');
  for (const [value, label] of [
    [options.candidate_sha, 'candidate SHA'],
    [options.candidate_tree, 'candidate tree'],
    [options.workflow_revision, 'workflow revision'],
  ]) {
    if (!FULL_SHA.test(value)) fail(`${label}必须是完整的小写 40 位 SHA`);
  }
  if (options.workflow_revision !== options.candidate_sha) {
    fail('workflow revision 必须等于 candidate SHA');
  }
  if (options.source_ref !== 'refs/heads/main') fail('正式候选 source ref 必须是 refs/heads/main');
  const runId = parsePositiveInteger(options.run_id, '候选 run ID');
  const runAttempt = parsePositiveInteger(options.run_attempt, '候选 run attempt');
  const run = readJson(options.run_response, 'GitHub run 响应');
  if (run.id !== runId || run.run_attempt !== runAttempt) fail('GitHub run 身份与生成参数不一致');
  if (run.event !== 'push' || run.head_branch !== 'main' || run.head_sha !== options.candidate_sha) {
    fail('GitHub run 不是精确 candidate SHA 的 main push');
  }
  if (run.path !== options.workflow_path) fail('GitHub run workflow 路径与生成参数不一致');
  if (run.status === 'completed' && run.conclusion !== 'success') fail('失败的候选 run 不能生成清单');

  const jobsResponse = readJson(options.jobs_response, 'GitHub jobs 响应');
  const jobs = Array.isArray(jobsResponse.jobs) ? jobsResponse.jobs : fail('GitHub jobs 响应缺少 jobs');
  const artifactsResponse = readJson(options.artifacts_response, 'GitHub artifacts 响应');
  const artifacts = Array.isArray(artifactsResponse.artifacts)
    ? artifactsResponse.artifacts
    : fail('GitHub artifacts 响应缺少 artifacts');

  const manifestJobs = [];
  const manifestArtifacts = [];
  for (const target of TARGETS) {
    const expectedJobName = `candidate-package / Candidate (${target})`;
    const jobMatches = jobs.filter(
      (job) => job.name === expectedJobName || job.name.endsWith(` / Candidate (${target})`),
    );
    if (jobMatches.length !== 1) fail(`${target} 必须对应唯一候选 job`);
    requireSuccessfulJob(jobMatches[0], `${target} 候选 job`, runAttempt, options.candidate_sha);
    manifestJobs.push({
      target,
      id: jobMatches[0].id,
      name: jobMatches[0].name,
      conclusion: 'success',
      runAttempt,
    });

    const expectedArtifactName =
      `skill-expert-candidate-${options.candidate_sha}-${runAttempt}-${target}`;
    const artifactMatches = artifacts.filter((artifact) => artifact.name === expectedArtifactName);
    if (artifactMatches.length !== 1) fail(`${target} 必须对应唯一候选 artifact`);
    const artifact = artifactMatches[0];
    positiveInteger(artifact.id, `${target} artifact ID`);
    if (!ARTIFACT_DIGEST.test(artifact.digest ?? '')) fail(`${target} artifact 缺少不可变 digest`);
    if (!Number.isSafeInteger(artifact.size_in_bytes) || artifact.size_in_bytes <= 0) {
      fail(`${target} artifact 大小无效`);
    }
    if (artifact.expired) fail(`${target} artifact 已过期`);
    if (
      artifact.workflow_run?.id !== runId ||
      artifact.workflow_run?.head_sha !== options.candidate_sha ||
      artifact.workflow_run?.head_branch !== 'main'
    ) {
      fail(`${target} artifact 不属于精确候选 run`);
    }

    const inventory = expectedCandidateAssets(options.version, target);
    const directory = path.join(options.assets_directory, target);
    const actualInventory = fs.readdirSync(directory).sort();
    if (JSON.stringify(actualInventory) !== JSON.stringify(inventory)) {
      fail(`${target} 候选目录文件清单不完整或包含额外文件`);
    }
    const files = inventory.map((name) => {
      const filePath = path.join(directory, name);
      const stat = fs.lstatSync(filePath);
      if (!stat.isFile() || stat.isSymbolicLink()) fail(`${target} 候选资产不是普通文件：${name}`);
      const content = fs.readFileSync(filePath);
      return {
        name,
        role: expectedCandidateRole(name, inventory),
        size: stat.size,
        sha256: sha256(content),
      };
    });
    manifestArtifacts.push({
      target,
      id: artifact.id,
      name: artifact.name,
      digest: artifact.digest,
      size: artifact.size_in_bytes,
      files,
    });
  }

  const manifest = {
    schemaVersion: 1,
    purpose: 'formal-release-candidate',
    repository: options.repository,
    version: options.version,
    candidate: {
      sha: options.candidate_sha,
      tree: options.candidate_tree,
      sourceRef: options.source_ref,
    },
    workflow: {
      path: options.workflow_path,
      builderPath: options.builder_workflow_path,
      revision: options.workflow_revision,
      runId,
      runAttempt,
    },
    jobs: manifestJobs,
    artifacts: manifestArtifacts,
  };
  fs.writeFileSync(options.output, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

export function renderPromotionPrBody(options) {
  requireOptions(options, [
    'repository',
    'candidate_sha',
    'head',
    'base',
    'manifest',
    'evidence_artifact_id',
    'evidence_artifact_name',
    'evidence_artifact_digest',
    'manifest_sha256',
    'output',
  ]);
  const manifestContent = fs.readFileSync(options.manifest);
  const manifestSha256 = sha256(manifestContent);
  if (manifestSha256 !== options.manifest_sha256) fail('候选清单摘要与工作流输出不一致');
  const manifest = readJson(options.manifest, '候选清单');
  if (manifest.repository !== options.repository || manifest.candidate?.sha !== options.candidate_sha) {
    fail('候选清单身份与待创建的 Release PR 不一致');
  }
  const selector = {
    schemaVersion: 1,
    runId: manifest.workflow?.runId,
    runAttempt: manifest.workflow?.runAttempt,
    evidenceArtifactId: parsePositiveInteger(
      options.evidence_artifact_id,
      '候选证据 artifact ID',
    ),
    evidenceArtifactName: options.evidence_artifact_name,
    evidenceArtifactDigest: options.evidence_artifact_digest,
    manifestSha256,
  };
  parseCandidateSelector(
    `<!-- skill-expert-candidate-selector:v1 ${JSON.stringify(selector)} -->`,
  );
  const candidate = renderPrBody(options);
  const platformRows = manifest.artifacts
    .map((artifact) => {
      const job = manifest.jobs.find(({ target }) => target === artifact.target);
      return `| \`${artifact.target}\` | \`${job?.id}\` | \`${artifact.id}\` | \`${artifact.digest}\` |`;
    })
    .join('\n');
  fs.appendFileSync(
    options.output,
    `\n## 不可变候选证据\n\n` +
      `- Candidate tree：\`${manifest.candidate.tree}\`\n` +
      `- Run：\`${selector.runId}\`，attempt：\`${selector.runAttempt}\`\n` +
      `- 候选清单 SHA-256：\`${manifestSha256}\`\n` +
      `- 证据 artifact：\`${selector.evidenceArtifactId}\` / \`${selector.evidenceArtifactDigest}\`\n\n` +
      `| 平台 | Job ID | Artifact ID | Artifact digest |\n` +
      `| --- | ---: | ---: | --- |\n` +
      `${platformRows}\n\n` +
      `> PR 正文只展示并选择候选身份；合并门禁会重新读取 GitHub API、不可变清单和来源证明，不信任正文中的结论。\n\n` +
      `<!-- skill-expert-candidate-selector:v1 ${JSON.stringify(selector)} -->\n`,
  );
  return { ...candidate, selector, candidateTree: manifest.candidate.tree };
}

export function materializeReleaseAssets(options) {
  requireOptions(options, [
    'manifest',
    'candidate_assets_directory',
    'release_assets_directory',
    'output',
  ]);
  const manifestContent = fs.readFileSync(options.manifest);
  const manifest = readJson(options.manifest, '候选清单');
  if (manifest.schemaVersion !== 1 || manifest.purpose !== 'formal-release-candidate') {
    fail('只有正式发布候选清单可以搬运为正式资产');
  }
  if (!/^\d+\.\d+\.\d+$/.test(manifest.version ?? '')) fail('正式候选版本必须是稳定的 x.y.z');
  const artifactTargets = manifest.artifacts?.map(({ target }) => target).sort();
  if (JSON.stringify(artifactTargets) !== JSON.stringify([...TARGETS].sort())) {
    fail('正式搬运要求同一清单中的完整四平台 artifact');
  }
  fs.mkdirSync(options.release_assets_directory, { recursive: true });
  if (fs.readdirSync(options.release_assets_directory).length !== 0) {
    fail('正式资产目录必须为空');
  }

  const reusedFiles = [];
  const names = new Set();
  for (const artifact of manifest.artifacts) {
    const inventory = expectedCandidateAssets(manifest.version, artifact.target);
    const actualNames = artifact.files?.map(({ name }) => name).sort();
    if (JSON.stringify(actualNames) !== JSON.stringify(inventory)) {
      fail(`${artifact.target} 候选清单不完整或包含额外文件`);
    }
    const sourceDirectory = path.join(options.candidate_assets_directory, artifact.target);
    const directoryNames = fs.readdirSync(sourceDirectory).sort();
    if (JSON.stringify(directoryNames) !== JSON.stringify(inventory)) {
      fail(`${artifact.target} 下载目录不完整或包含额外文件`);
    }
    for (const file of artifact.files) {
      const expectedRole = expectedCandidateRole(file.name, inventory);
      if (file.role !== expectedRole) fail(`${artifact.target} 文件角色错误：${file.name}`);
      const source = path.join(sourceDirectory, file.name);
      const stat = fs.lstatSync(source);
      if (!stat.isFile() || stat.isSymbolicLink()) fail(`候选资产不是普通文件：${file.name}`);
      const content = fs.readFileSync(source);
      const digest = sha256(content);
      if (stat.size !== file.size || digest !== file.sha256) {
        fail(`候选资产大小或 SHA-256 与清单不一致：${file.name}`);
      }
      if (file.role === 'candidate-updater-signature') continue;
      if (names.has(file.name)) fail(`正式候选文件名重复：${file.name}`);
      names.add(file.name);
      const destination = path.join(options.release_assets_directory, file.name);
      fs.copyFileSync(source, destination);
      fs.chmodSync(destination, stat.mode);
      reusedFiles.push({
        name: file.name,
        role: file.role,
        size: file.size,
        sha256: file.sha256,
        target: artifact.target,
      });
    }
  }
  const report = {
    schemaVersion: 1,
    purpose: 'candidate-byte-reuse',
    repository: manifest.repository,
    version: manifest.version,
    candidate: manifest.candidate,
    workflow: manifest.workflow,
    manifestSha256: sha256(manifestContent),
    artifacts: manifest.artifacts.map(({ target, id, name, digest }) => ({
      target,
      id,
      name,
      digest,
    })),
    files: reusedFiles.sort((left, right) => left.name.localeCompare(right.name)),
  };
  fs.writeFileSync(options.output, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

export function createPromotionBinding(options) {
  requireOptions(options, [
    'reuse_report',
    'version',
    'tag',
    'release_sha',
    'candidate_sha',
    'release_tree',
    'candidate_tree',
    'output',
  ]);
  if (!/^\d+\.\d+\.\d+$/.test(options.version) || options.tag !== `v${options.version}`) {
    fail('晋级绑定的稳定版本与 tag 不一致');
  }
  for (const [value, label] of [
    [options.release_sha, 'release SHA'],
    [options.candidate_sha, 'candidate SHA'],
    [options.release_tree, 'release tree'],
    [options.candidate_tree, 'candidate tree'],
  ]) {
    if (!FULL_SHA.test(value)) fail(`${label}必须是完整的小写 40 位 SHA`);
  }
  if (options.release_tree !== options.candidate_tree) fail('release tree 与 candidate tree 必须完全相同');
  const reuse = readJson(options.reuse_report, '候选字节复用报告');
  if (
    reuse.schemaVersion !== 1 ||
    reuse.purpose !== 'candidate-byte-reuse' ||
    reuse.version !== options.version ||
    reuse.candidate?.sha !== options.candidate_sha ||
    reuse.candidate?.tree !== options.candidate_tree
  ) {
    fail('候选字节复用报告与晋级身份不一致');
  }
  if (!SHA256.test(reuse.manifestSha256 ?? '')) fail('候选清单摘要无效');
  positiveInteger(reuse.workflow?.runId, '候选 run ID');
  positiveInteger(reuse.workflow?.runAttempt, '候选 run attempt');
  if (!Array.isArray(reuse.artifacts) || reuse.artifacts.length !== TARGETS.length) {
    fail('晋级绑定必须包含四个平台 artifact 身份');
  }
  if (!Array.isArray(reuse.files) || reuse.files.length === 0) fail('晋级绑定缺少复用字节哈希');
  for (const file of reuse.files) {
    if (!SHA256.test(file.sha256 ?? '') || file.role === 'candidate-updater-signature') {
      fail(`晋级绑定包含无效复用文件：${file.name ?? '缺失名称'}`);
    }
  }
  const binding = {
    schemaVersion: 1,
    purpose: 'release-promotion-binding',
    repository: reuse.repository,
    version: options.version,
    release: {
      sha: options.release_sha,
      tree: options.release_tree,
      ref: 'refs/heads/release',
      tag: options.tag,
    },
    candidate: {
      sha: options.candidate_sha,
      tree: options.candidate_tree,
      ref: 'refs/heads/main',
      runId: reuse.workflow.runId,
      runAttempt: reuse.workflow.runAttempt,
      workflowPath: reuse.workflow.path,
      builderWorkflowPath: reuse.workflow.builderPath,
      manifestSha256: reuse.manifestSha256,
      artifacts: reuse.artifacts,
    },
    reusedFiles: reuse.files,
  };
  fs.writeFileSync(options.output, `${JSON.stringify(binding, null, 2)}\n`);
  return binding;
}

export function verifyPromotionBinding(options) {
  requireOptions(options, [
    'binding',
    'release_assets_directory',
    'version',
    'release_sha',
    'candidate_sha',
    'tree',
  ]);
  const binding = readJson(options.binding, '晋级绑定证明');
  if (binding.schemaVersion !== 1 || binding.purpose !== 'release-promotion-binding') {
    fail('晋级绑定证明用途或 schema 无效');
  }
  if (
    binding.version !== options.version ||
    binding.release?.tag !== `v${options.version}` ||
    binding.release?.sha !== options.release_sha ||
    binding.release?.tree !== options.tree ||
    binding.release?.ref !== 'refs/heads/release' ||
    binding.candidate?.sha !== options.candidate_sha ||
    binding.candidate?.tree !== options.tree ||
    binding.candidate?.ref !== 'refs/heads/main'
  ) {
    fail('晋级绑定证明与正式发布身份不一致');
  }
  positiveInteger(binding.candidate.runId, '候选 run ID');
  positiveInteger(binding.candidate.runAttempt, '候选 run attempt');
  if (!Array.isArray(binding.candidate.artifacts) || binding.candidate.artifacts.length !== TARGETS.length) {
    fail('晋级绑定证明缺少四个平台 artifact');
  }
  const targets = binding.candidate.artifacts.map(({ target }) => target).sort();
  if (JSON.stringify(targets) !== JSON.stringify([...TARGETS].sort())) {
    fail('晋级绑定证明的平台 artifact 集合不完整');
  }
  for (const artifact of binding.candidate.artifacts) {
    positiveInteger(artifact.id, `${artifact.target} artifact ID`);
    if (!ARTIFACT_DIGEST.test(artifact.digest ?? '')) fail(`${artifact.target} artifact digest 无效`);
  }
  const manifestPath = path.join(options.release_assets_directory, 'candidate-manifest.json');
  if (sha256(fs.readFileSync(manifestPath)) !== binding.candidate.manifestSha256) {
    fail('候选清单摘要与晋级绑定不一致');
  }
  const manifest = readJson(manifestPath, '候选清单');
  if (
    manifest.schemaVersion !== 1 ||
    manifest.purpose !== 'formal-release-candidate' ||
    manifest.repository !== binding.repository ||
    manifest.version !== binding.version ||
    manifest.candidate?.sha !== binding.candidate.sha ||
    manifest.candidate?.tree !== binding.candidate.tree ||
    manifest.candidate?.sourceRef !== binding.candidate.ref ||
    manifest.workflow?.runId !== binding.candidate.runId ||
    manifest.workflow?.runAttempt !== binding.candidate.runAttempt ||
    manifest.workflow?.path !== binding.candidate.workflowPath ||
    manifest.workflow?.builderPath !== binding.candidate.builderWorkflowPath
  ) {
    fail('晋级绑定中的候选身份与候选清单不一致');
  }
  const expectedArtifacts = (manifest.artifacts ?? [])
    .map(({ target, id, name, digest }) => ({ target, id, name, digest }))
    .sort((left, right) => left.target.localeCompare(right.target));
  const boundArtifacts = binding.candidate.artifacts
    .map(({ target, id, name, digest }) => ({ target, id, name, digest }))
    .sort((left, right) => left.target.localeCompare(right.target));
  if (JSON.stringify(boundArtifacts) !== JSON.stringify(expectedArtifacts)) {
    fail('晋级绑定中的候选 artifact 身份与候选清单不一致');
  }
  if (!Array.isArray(binding.reusedFiles) || binding.reusedFiles.length === 0) {
    fail('晋级绑定证明缺少候选本体哈希');
  }
  const expectedReusedFiles = (manifest.artifacts ?? [])
    .flatMap((artifact) =>
      (artifact.files ?? [])
        .filter(({ role }) => role !== 'candidate-updater-signature')
        .map(({ name, role, size, sha256: digest }) => ({
          name,
          role,
          size,
          sha256: digest,
          target: artifact.target,
        })),
    )
    .sort((left, right) => left.name.localeCompare(right.name));
  const boundReusedFiles = binding.reusedFiles
    .map(({ name, role, size, sha256: digest, target }) => ({
      name,
      role,
      size,
      sha256: digest,
      target,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
  if (JSON.stringify(boundReusedFiles) !== JSON.stringify(expectedReusedFiles)) {
    fail('晋级绑定中的候选本体与候选清单不一致');
  }
  for (const file of binding.reusedFiles) {
    if (file.role === 'candidate-updater-signature' || file.name.endsWith('.sig')) {
      fail(`晋级绑定不能把候选临时签名作为复用本体：${file.name}`);
    }
    const filePath = path.join(options.release_assets_directory, file.name);
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) fail(`正式候选本体不是普通文件：${file.name}`);
    if (stat.size !== file.size || sha256(fs.readFileSync(filePath)) !== file.sha256) {
      fail(`候选本体大小或 SHA-256 与晋级绑定不一致：${file.name}`);
    }
  }
  return binding;
}

export function verifyCandidatePromotion(options) {
  requireOptions(options, [
    'repository',
    'candidate_sha',
    'head',
    'base',
    'pr_body',
    'run_response',
    'jobs_response',
    'artifacts_response',
    'evidence_directory',
    'provenance_report',
  ]);
  if (!FULL_SHA.test(options.candidate_sha)) fail('candidate SHA 必须是完整的小写 40 位 SHA');
  const candidate = verifyCandidate(options);
  const selector = parseCandidateSelector(fs.readFileSync(options.pr_body, 'utf8'));

  const manifestPath = path.join(options.evidence_directory, 'candidate-manifest.json');
  const provenancePath = path.join(
    options.evidence_directory,
    'candidate-build-provenance.json',
  );
  if (!fs.statSync(provenancePath).isFile()) fail('候选证据缺少 candidate-build-provenance.json');
  const manifestContent = fs.readFileSync(manifestPath);
  const manifestSha256 = sha256(manifestContent);
  if (manifestSha256 !== selector.manifestSha256) fail('候选清单摘要与 Release PR 选择器不一致');
  const manifest = readJson(manifestPath, '候选清单');
  if (manifest.schemaVersion !== 1) fail('候选清单 schemaVersion 必须为 1');
  if (manifest.purpose !== 'formal-release-candidate') fail('候选清单用途不可晋级');
  if (manifest.repository !== options.repository) fail('候选清单仓库身份不一致');
  if (manifest.version !== candidate.version) fail('候选清单版本与 Git 候选不一致');
  if (manifest.candidate?.sha !== options.candidate_sha) fail('候选清单 SHA 不一致');
  const treeLookup = spawnSync('git', ['rev-parse', `${options.candidate_sha}^{tree}`], {
    encoding: 'utf8',
  });
  if (treeLookup.status !== 0) fail(treeLookup.stderr.trim() || '无法读取 candidate tree');
  const candidateTree = treeLookup.stdout.trim();
  if (manifest.candidate?.tree !== candidateTree) fail('候选清单 tree 与 Git 候选不一致');
  if (manifest.candidate?.sourceRef !== 'refs/heads/main') fail('候选清单 source ref 必须是 refs/heads/main');

  const workflow = manifest.workflow ?? {};
  if (workflow.path !== '.github/workflows/test.yml') fail('候选清单 workflow 路径不受信任');
  if (workflow.builderPath !== '.github/workflows/candidate-build.yml') {
    fail('候选清单 builder workflow 路径不受信任');
  }
  if (workflow.revision !== options.candidate_sha) fail('候选 workflow revision 不等于 candidate SHA');
  if (workflow.runId !== selector.runId || workflow.runAttempt !== selector.runAttempt) {
    fail('候选清单与 Release PR 选择的 run attempt 不一致');
  }

  const run = readJson(options.run_response, 'GitHub run 响应');
  if (run.id !== selector.runId) fail('GitHub run ID 与候选选择器不一致');
  if (run.run_attempt !== selector.runAttempt) fail('GitHub run attempt 与候选选择器不一致');
  if (run.status !== 'completed' || run.conclusion !== 'success') fail('候选 run 未成功完成');
  if (run.event !== 'push' || run.head_branch !== 'main') fail('候选 run 不是 main push');
  if (run.head_sha !== options.candidate_sha) fail('候选 run head SHA 不一致');
  if (run.path !== workflow.path) fail('候选 run workflow 路径与清单不一致');

  const jobsResponse = readJson(options.jobs_response, 'GitHub jobs 响应');
  const jobs = Array.isArray(jobsResponse.jobs) ? jobsResponse.jobs : fail('GitHub jobs 响应缺少 jobs');
  for (const name of DAILY_CHECKS) {
    const matches = jobs.filter((job) => job.name === name);
    if (matches.length !== 1) fail(`候选 run 必须包含唯一日常检查：${name}`);
    requireSuccessfulJob(matches[0], name, selector.runAttempt, options.candidate_sha);
  }
  if (!Array.isArray(manifest.jobs) || manifest.jobs.length !== TARGETS.length) {
    fail('候选清单必须包含四个平台 job');
  }
  const manifestTargets = manifest.jobs.map((job) => job.target).sort();
  if (JSON.stringify(manifestTargets) !== JSON.stringify([...TARGETS].sort())) {
    fail('候选清单平台 job 集合不完整');
  }
  for (const expected of manifest.jobs) {
    if (expected.runAttempt !== selector.runAttempt || expected.conclusion !== 'success') {
      fail(`候选清单中的 ${expected.target} job 身份无效`);
    }
    const matches = jobs.filter((job) => job.id === expected.id);
    if (matches.length !== 1 || matches[0].name !== expected.name) {
      fail(`候选清单中的 ${expected.target} job 与 GitHub API 不一致`);
    }
    requireSuccessfulJob(matches[0], `${expected.target} 候选 job`, selector.runAttempt, options.candidate_sha);
  }

  const artifactsResponse = readJson(options.artifacts_response, 'GitHub artifacts 响应');
  const artifacts = Array.isArray(artifactsResponse.artifacts)
    ? artifactsResponse.artifacts
    : fail('GitHub artifacts 响应缺少 artifacts');
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length !== TARGETS.length) {
    fail('候选清单必须包含四个平台 artifact');
  }
  const artifactTargets = manifest.artifacts.map((artifact) => artifact.target).sort();
  if (JSON.stringify(artifactTargets) !== JSON.stringify([...TARGETS].sort())) {
    fail('候选清单平台 artifact 集合不完整');
  }
  const artifactIds = new Set();
  const candidateFileNames = new Set();
  for (const expected of manifest.artifacts) {
    positiveInteger(expected.id, `${expected.target} artifact ID`);
    if (artifactIds.has(expected.id)) fail('候选清单不能重复使用 artifact ID');
    artifactIds.add(expected.id);
    if (!ARTIFACT_DIGEST.test(expected.digest ?? '')) fail(`${expected.target} artifact digest 无效`);
    if (!Array.isArray(expected.files) || expected.files.length === 0) {
      fail(`${expected.target} artifact 文件清单为空`);
    }
    const expectedInventory = expectedCandidateAssets(candidate.version, expected.target);
    const actualInventory = expected.files.map((file) => file.name).sort();
    if (JSON.stringify(actualInventory) !== JSON.stringify(expectedInventory)) {
      fail(`${expected.target} artifact 文件清单不完整或包含额外文件`);
    }
    for (const file of expected.files) {
      if (!SHA256.test(file.sha256 ?? '') || !Number.isSafeInteger(file.size) || file.size < 0) {
        fail(`${expected.target} artifact 文件身份无效：${file.name ?? '缺失名称'}`);
      }
      if (file.role !== expectedCandidateRole(file.name, expectedInventory)) {
        fail(`${expected.target} artifact 文件角色不正确：${file.name}`);
      }
      if (candidateFileNames.has(file.name)) fail(`候选文件名重复：${file.name}`);
      candidateFileNames.add(file.name);
    }
    const matches = artifacts.filter((artifact) => artifact.id === expected.id);
    if (matches.length !== 1) fail(`候选 artifact ID ${expected.id} 必须唯一`);
    requireArtifactIdentity(matches[0], expected, selector, options.candidate_sha);
  }

  const evidenceMatches = artifacts.filter(
    (artifact) => artifact.id === selector.evidenceArtifactId,
  );
  if (evidenceMatches.length !== 1) fail('候选证据 artifact ID 不存在或不唯一');
  const evidenceArtifact = evidenceMatches[0];
  if (
    evidenceArtifact.name !== selector.evidenceArtifactName ||
    evidenceArtifact.digest !== selector.evidenceArtifactDigest
  ) {
    fail('候选证据 artifact 身份与 Release PR 选择器不一致');
  }
  if (evidenceArtifact.expired) fail('候选证据 artifact 已过期');
  if (
    evidenceArtifact.workflow_run?.id !== selector.runId ||
    evidenceArtifact.workflow_run?.head_sha !== options.candidate_sha ||
    evidenceArtifact.workflow_run?.head_branch !== 'main'
  ) {
    fail('候选证据 artifact 不属于选择的候选 run');
  }

  verifyProvenanceSubjects(
    readJson(options.provenance_report, '候选来源证明验证结果'),
    manifest,
    manifestSha256,
  );

  return {
    schemaVersion: 1,
    decision: 'promotable',
    version: candidate.version,
    candidateSha: options.candidate_sha,
    candidateTree,
    runId: selector.runId,
    runAttempt: selector.runAttempt,
    manifestSha256,
    evidenceArtifactId: selector.evidenceArtifactId,
    artifactIds: manifest.artifacts.map((artifact) => artifact.id),
  };
}

function main() {
  try {
    const { command, options } = parseArguments(process.argv.slice(2));
    if (command === 'create-manifest') {
      const result = createCandidateManifest(options);
      console.log(`已生成 ${result.artifacts.length} 个平台的不可变候选清单。`);
      return;
    }
    if (command === 'read-selector') {
      requireOptions(options, ['pr_body']);
      const selector = parseCandidateSelector(fs.readFileSync(options.pr_body, 'utf8'));
      process.stdout.write(`${JSON.stringify(selector)}\n`);
      return;
    }
    if (command === 'render-pr-body') {
      const result = renderPromotionPrBody(options);
      console.log(
        `已为候选 ${result.candidateSha} 与 run ${result.selector.runId}/${result.selector.runAttempt} 生成 Release PR 正文。`,
      );
      return;
    }
    if (command === 'materialize-release') {
      const result = materializeReleaseAssets(options);
      console.log(`已逐字节复用 ${result.files.length} 个候选本体，并丢弃候选临时签名。`);
      return;
    }
    if (command === 'create-promotion-binding') {
      const result = createPromotionBinding(options);
      console.log(`已生成 ${result.version} 的 candidate 到 release 晋级绑定证明。`);
      return;
    }
    if (command === 'verify-promotion-binding') {
      const result = verifyPromotionBinding(options);
      console.log(`晋级绑定回验通过：${result.version} @ ${result.release.sha}`);
      return;
    }
    if (command !== 'verify-candidate') {
      fail(
        '用法：release-promotion.mjs <create-manifest|read-selector|render-pr-body|verify-candidate|materialize-release|create-promotion-binding|verify-promotion-binding> [参数] [--json]',
      );
    }
    const result = verifyCandidatePromotion(options);
    process.stdout.write(`${options.json ? JSON.stringify(result) : '发布晋级契约验证通过。'}\n`);
  } catch (error) {
    console.error(`发布晋级契约验证失败：${error.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
