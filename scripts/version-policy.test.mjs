import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const policyCli = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'version-policy.mjs',
);

function git(repository, ...args) {
  const result = spawnSync('git', args, { cwd: repository, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function writeVersion(repository, version) {
  writeFileSync(
    path.join(repository, 'package.json'),
    `${JSON.stringify({ name: 'skill-expert', version }, null, 2)}\n`,
  );
}

function commitVersion(repository, version, message) {
  writeVersion(repository, version);
  git(repository, 'add', 'package.json');
  git(repository, 'commit', '-m', message);
  return git(repository, 'rev-parse', 'HEAD');
}

function repositoryFixture(t, { releaseVersion = '1.0.3' } = {}) {
  const repository = mkdtempSync(path.join(tmpdir(), 'skill-expert-version-policy-'));
  t.after(() => rmSync(repository, { recursive: true, force: true }));
  git(repository, 'init', '-b', 'release');
  git(repository, 'config', 'user.name', '版本策略测试');
  git(repository, 'config', 'user.email', 'version-policy@example.com');
  const releaseSha = commitVersion(repository, releaseVersion, `发布 ${releaseVersion}`);
  git(repository, 'switch', '-c', 'main');
  return { repository, releaseSha };
}

function runPolicy(repository, ...args) {
  const completeArgs = [...args];
  if (completeArgs[0] === 'verify-main-pr' && !completeArgs.includes('--head-repository')) {
    completeArgs.push(
      '--head-repository',
      'Alex-Shen1121/skill-expert',
      '--expected-repository',
      'Alex-Shen1121/skill-expert',
    );
  }
  return spawnSync(process.execPath, [policyCli, ...completeArgs], {
    cwd: repository,
    encoding: 'utf8',
  });
}

test('普通 main PR 从正式版本进入首个开发序号', (t) => {
  const { repository } = repositoryFixture(t);
  const baseSha = git(repository, 'rev-parse', 'main');
  git(repository, 'switch', '-c', 'codex/new-feature');
  const headSha = commitVersion(repository, '1.0.3-1', '功能：首个开发序号');

  const result = runPolicy(
    repository,
    'verify-main-pr',
    '--base-sha',
    baseSha,
    '--head-sha',
    headSha,
    '--head-ref',
    'codex/new-feature',
    '--release-ref',
    'release',
    '--json',
  );

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    schemaVersion: 1,
    command: 'verify-main-pr',
    channel: 'development',
    baseVersion: '1.0.3',
    headVersion: '1.0.3-1',
    releaseVersion: '1.0.3',
    expectedVersion: '1.0.3-1',
    releaseCandidate: false,
  });
});

test('普通 main PR 必须逐次递增开发序号，不能重复或跳号', (t) => {
  const { repository } = repositoryFixture(t);
  commitVersion(repository, '1.0.3-1', '功能：已有开发序号');
  const baseSha = git(repository, 'rev-parse', 'main');
  git(repository, 'switch', '-c', 'codex/skipped-sequence');
  const headSha = commitVersion(repository, '1.0.3-3', '错误：跳过开发序号');

  const result = runPolicy(
    repository,
    'verify-main-pr',
    '--base-sha',
    baseSha,
    '--head-sha',
    headSha,
    '--head-ref',
    'codex/skipped-sequence',
    '--release-ref',
    'release',
  );

  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /普通 main PR 必须把版本从 1\.0\.3-1 递增为 1\.0\.3-2，实际为 1\.0\.3-3/,
  );
});

test('普通 main PR 未修改版本时必须被卡控', (t) => {
  const { repository } = repositoryFixture(t);
  const baseSha = git(repository, 'rev-parse', 'main');
  git(repository, 'switch', '-c', 'codex/missing-version-bump');
  writeFileSync(path.join(repository, 'feature.txt'), '新增功能但没有升级开发序号\n');
  git(repository, 'add', 'feature.txt');
  git(repository, 'commit', '-m', '错误：遗漏开发序号');
  const headSha = git(repository, 'rev-parse', 'HEAD');

  const result = runPolicy(
    repository,
    'verify-main-pr',
    '--base-sha',
    baseSha,
    '--head-sha',
    headSha,
    '--head-ref',
    'codex/missing-version-bump',
    '--release-ref',
    'release',
  );

  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /普通 main PR 必须把版本从 1\.0\.3 递增为 1\.0\.3-1，实际为 1\.0\.3/,
  );
});

test('发布准备 PR 是 main 的唯一正式版本例外，并且只能进入下一补丁版本', (t) => {
  const { repository } = repositoryFixture(t);
  commitVersion(repository, '1.0.3-7', '功能：第七个开发序号');
  const baseSha = git(repository, 'rev-parse', 'main');
  git(repository, 'switch', '-c', 'release-prep/v1.0.4');
  const headSha = commitVersion(repository, '1.0.4', '发布：准备 1.0.4');

  const result = runPolicy(
    repository,
    'verify-main-pr',
    '--base-sha',
    baseSha,
    '--head-sha',
    headSha,
    '--head-ref',
    'release-prep/v1.0.4',
    '--release-ref',
    'release',
    '--json',
  );

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    schemaVersion: 1,
    command: 'verify-main-pr',
    channel: 'release',
    baseVersion: '1.0.3-7',
    headVersion: '1.0.4',
    releaseVersion: '1.0.3',
    expectedVersion: '1.0.4',
    releaseCandidate: true,
  });
});

test('发布准备分支名必须与下一正式补丁版本完全匹配', (t) => {
  const { repository } = repositoryFixture(t);
  commitVersion(repository, '1.0.3-7', '功能：第七个开发序号');
  const baseSha = git(repository, 'rev-parse', 'main');
  git(repository, 'switch', '-c', 'release-prep/v1.0.5');
  const headSha = commitVersion(repository, '1.0.4', '错误：发布准备分支版本不匹配');

  const result = runPolicy(
    repository,
    'verify-main-pr',
    '--base-sha',
    baseSha,
    '--head-sha',
    headSha,
    '--head-ref',
    'release-prep/v1.0.5',
    '--release-ref',
    'release',
  );

  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /发布准备分支必须是 release-prep\/v1\.0\.4，实际为 release-prep\/v1\.0\.5/,
  );
});

test('跨仓库 PR 不能冒充发布准备分支', (t) => {
  const { repository } = repositoryFixture(t);
  commitVersion(repository, '1.0.3-7', '功能：第七个开发序号');
  const baseSha = git(repository, 'rev-parse', 'main');
  git(repository, 'switch', '-c', 'release-prep/v1.0.4');
  const headSha = commitVersion(repository, '1.0.4', '错误：外部仓库冒充发布准备');

  const result = runPolicy(
    repository,
    'verify-main-pr',
    '--base-sha',
    baseSha,
    '--head-sha',
    headSha,
    '--head-ref',
    'release-prep/v1.0.4',
    '--head-repository',
    'outside/fork',
    '--expected-repository',
    'Alex-Shen1121/skill-expert',
    '--release-ref',
    'release',
  );

  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /发布准备 PR 必须来自当前仓库 Alex-Shen1121\/skill-expert，实际来自 outside\/fork/,
  );
});

test('开发序号合入 main 后通过卡控，但不成为正式发布候选', (t) => {
  const { repository } = repositoryFixture(t);
  const beforeSha = git(repository, 'rev-parse', 'main');
  const headSha = commitVersion(repository, '1.0.3-1', '功能：合入首个开发序号');

  const result = runPolicy(
    repository,
    'verify-main-push',
    '--before-sha',
    beforeSha,
    '--head-sha',
    headSha,
    '--release-ref',
    'release',
    '--json',
  );

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    schemaVersion: 1,
    command: 'verify-main-push',
    channel: 'development',
    baseVersion: '1.0.3',
    headVersion: '1.0.3-1',
    releaseVersion: '1.0.3',
    expectedVersion: '1.0.3-1',
    releaseCandidate: false,
  });
});

test('下一正式补丁版本合入 main 后成为唯一可构建候选', (t) => {
  const { repository } = repositoryFixture(t);
  const beforeSha = commitVersion(repository, '1.0.3-7', '功能：完成开发序号');
  const headSha = commitVersion(repository, '1.0.4', '发布：准备正式补丁版本');

  const result = runPolicy(
    repository,
    'verify-main-push',
    '--before-sha',
    beforeSha,
    '--head-sha',
    headSha,
    '--release-ref',
    'release',
    '--json',
  );

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    schemaVersion: 1,
    command: 'verify-main-push',
    channel: 'release',
    baseVersion: '1.0.3-7',
    headVersion: '1.0.4',
    releaseVersion: '1.0.3',
    expectedVersion: '1.0.4',
    releaseCandidate: true,
  });
});
