import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const policyCli = path.join(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
  'scripts/stable-version-policy.mjs',
);

function git(root, ...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function commitVersion(root, version, message) {
  writeFileSync(path.join(root, 'package.json'), `${JSON.stringify({ version }, null, 2)}\n`);
  git(root, 'add', 'package.json');
  git(root, 'commit', '--allow-empty', '-qm', message);
  return git(root, 'rev-parse', 'HEAD');
}

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'skill-expert-stable-version-policy-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, 'init', '-q');
  git(root, 'config', 'user.name', 'Version Policy Test');
  git(root, 'config', 'user.email', 'version-policy@example.com');
  const baseSha = commitVersion(root, '1.0.3', '初始稳定版本');
  return { root, baseSha };
}

function verify(root, { baseSha, headSha, headRef }) {
  return spawnSync(
    process.execPath,
    [
      policyCli,
      'verify-main-pr',
      '--base-sha',
      baseSha,
      '--head-sha',
      headSha,
      '--head-ref',
      headRef,
      '--json',
    ],
    { cwd: root, encoding: 'utf8' },
  );
}

test('普通 codex PR 必须保持稳定版本不变', (t) => {
  const { root, baseSha } = fixture(t);
  const headSha = commitVersion(root, '1.0.3', '普通更新');

  const result = verify(root, { baseSha, headSha, headRef: 'codex/feature' });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    kind: 'ordinary',
    version: '1.0.3',
  });
});

test('普通 PR 修改版本时拒绝合入', (t) => {
  const { root, baseSha } = fixture(t);
  const headSha = commitVersion(root, '1.0.4', '错误升级版本');

  const result = verify(root, { baseSha, headSha, headRef: 'codex/feature' });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /普通 PR 必须保持版本 1\.0\.3 不变/);
});

test('只允许本次流程 PR 把旧开发序号归一为 1.0.3', (t) => {
  const { root } = fixture(t);
  const legacyBaseSha = commitVersion(root, '1.0.3-3', '旧开发序号');
  const headSha = commitVersion(root, '1.0.3', '归一稳定版本');

  const accepted = verify(root, {
    baseSha: legacyBaseSha,
    headSha,
    headRef: 'codex/simplify-main-release',
  });
  const rejected = verify(root, {
    baseSha: legacyBaseSha,
    headSha,
    headRef: 'codex/other-migration',
  });

  assert.equal(accepted.status, 0, accepted.stderr);
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /基线源码版本必须是稳定版本 x\.y\.z/);
});

test('拒绝不属于 codex 命名空间的普通开发分支', (t) => {
  const { root, baseSha } = fixture(t);
  const headSha = commitVersion(root, '1.0.3', '错误分支');

  const result = verify(root, { baseSha, headSha, headRef: 'feature/no-codex-prefix' });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /普通开发分支必须使用 codex\/\*/);
});

test('发布 PR 的分支名、目标版本和递增关系必须一致', (t) => {
  const { root, baseSha } = fixture(t);
  const headSha = commitVersion(root, '1.1.0', '准备明确稳定版本');

  const result = verify(root, { baseSha, headSha, headRef: 'codex/release-v1.1.0' });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    kind: 'release',
    version: '1.1.0',
  });
});

test('发布分支与版本不一致或目标没有递增时拒绝合入', (t) => {
  for (const { version, headRef, expected } of [
    {
      version: '1.0.4',
      headRef: 'codex/release-v1.1.0',
      expected: /发布分支目标 1\.1\.0 与源码版本 1\.0\.4 不一致/,
    },
    {
      version: '1.0.3',
      headRef: 'codex/release-v1.0.3',
      expected: /发布版本 1\.0\.3 必须高于当前版本 1\.0\.3/,
    },
  ]) {
    const { root, baseSha } = fixture(t);
    const headSha = commitVersion(root, version, '错误发布版本');
    const result = verify(root, { baseSha, headSha, headRef });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, expected);
  }
});
