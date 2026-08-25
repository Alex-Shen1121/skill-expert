import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const releaseMergeCli = path.join(repositoryRoot, 'scripts/release-merge.mjs');

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

function writeVersionContract(repository, version = '1.0.0') {
  write(repository, 'package.json', `${JSON.stringify({ name: 'skill-expert', version })}\n`);
  write(
    repository,
    'package-lock.json',
    `${JSON.stringify({ name: 'skill-expert', version, packages: { '': { name: 'skill-expert', version } } })}\n`,
  );
  write(repository, 'src-tauri/Cargo.toml', `[package]\nname = "skill-expert"\nversion = "${version}"\n`);
  write(
    repository,
    'src-tauri/Cargo.lock',
    `version = 4\n\n[[package]]\nname = "skill-expert"\nversion = "${version}"\n`,
  );
  write(repository, 'src-tauri/tauri.conf.json', `${JSON.stringify({ version })}\n`);
  for (const locale of ['en', 'zh', 'zh-TW']) {
    write(
      repository,
      `src/i18n/${locale}.json`,
      `${JSON.stringify({ settings: { version: `Skill Expert version ${version}` } })}\n`,
    );
  }
  write(
    repository,
    'CHANGELOG.md',
    `# Changelog\n\n## [Unreleased]\n\n## [${version}] - 2026-08-25\n\n- Publish Skill Expert.\n`,
  );
  write(
    repository,
    'CHANGELOG-zh.md',
    `# 更新日志\n\n## [Unreleased]\n\n## [${version}] - 2026-08-25\n\n- 发布 Skill Expert。\n`,
  );
}

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'skill-expert-release-merge-'));
  const remote = mkdtempSync(path.join(tmpdir(), 'skill-expert-release-origin-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  t.after(() => rmSync(remote, { recursive: true, force: true }));

  git(remote, 'init', '--bare');
  git(root, 'init', '-b', 'release');
  git(root, 'config', 'user.name', 'Skill Expert 测试');
  git(root, 'config', 'user.email', 'release-test@example.com');
  write(root, 'legacy.txt', '上游发布基线\n');
  git(root, 'add', '.');
  git(root, 'commit', '-m', '测试：建立 release 基线');
  const previousReleaseSha = git(root, 'rev-parse', 'HEAD');

  git(root, 'switch', '-c', 'main');
  writeVersionContract(root);
  git(root, 'add', '.');
  git(root, 'commit', '-m', '测试：准备 Skill Expert 版本');
  const candidateSha = git(root, 'rev-parse', 'HEAD');

  git(root, 'switch', 'release');
  git(root, 'merge', '--no-ff', 'main', '-m', '测试：晋级 main 到 release');
  const releaseSha = git(root, 'rev-parse', 'HEAD');
  git(root, 'remote', 'add', 'origin', remote);
  git(root, 'push', 'origin', 'main', 'release');

  return { root, candidateSha, previousReleaseSha, releaseSha };
}

function verify(repository, values, extraArguments = []) {
  return spawnSync(
    process.execPath,
    [
      releaseMergeCli,
      'verify',
      '--release-sha',
      values.releaseSha,
      '--candidate-sha',
      values.candidateSha,
      '--previous-release-sha',
      values.previousReleaseSha,
      '--json',
      ...extraArguments,
    ],
    { cwd: repository, encoding: 'utf8' },
  );
}

test('接受树内容等于候选且第二父提交绑定 main 的 release 合并提交', (t) => {
  const values = fixture(t);
  const result = verify(values.root, values);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    version: '1.0.0',
    tag: 'v1.0.0',
    releaseSha: values.releaseSha,
    candidateSha: values.candidateSha,
    previousReleaseSha: values.previousReleaseSha,
    tagExists: false,
  });
});

test('拒绝与 release 合并提交第二父提交不一致的候选身份', (t) => {
  const values = fixture(t);
  values.candidateSha = values.previousReleaseSha;
  const result = verify(values.root, values);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /第二父提交必须是 candidate SHA/);
});

test('同名 tag 已存在时拒绝复用版本', (t) => {
  const values = fixture(t);
  git(values.root, 'tag', '-a', 'v1.0.0', values.releaseSha, '-m', '既有版本');
  const result = verify(values.root, values);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /tag v1\.0\.0 已存在/);
});

test('精确重跑只接受指向同一 release SHA 的远端 annotated tag', (t) => {
  const values = fixture(t);
  git(
    values.root,
    'tag',
    '-a',
    'v1.0.0',
    values.releaseSha,
    '-m',
    'Skill Expert v1.0.0\nworkflow-run-id: 123456',
  );
  git(values.root, 'push', 'origin', 'refs/tags/v1.0.0');

  const result = verify(values.root, values, [
    '--allow-existing-tag',
    '--recovery-run-id',
    '123456',
  ]);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).tagExists, true);
});

test('精确重跑拒绝轻量 tag 或指向其他提交的 tag', (t) => {
  const values = fixture(t);
  git(values.root, 'tag', 'v1.0.0', values.previousReleaseSha);
  git(values.root, 'push', 'origin', 'refs/tags/v1.0.0');

  const result = verify(values.root, values, [
    '--allow-existing-tag',
    '--recovery-run-id',
    '123456',
  ]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /必须是指向同一 release SHA 的 annotated tag/);
});

test('精确重跑拒绝外部为同一 release SHA 创建的 annotated tag', (t) => {
  const values = fixture(t);
  git(values.root, 'tag', '-a', 'v1.0.0', values.releaseSha, '-m', '人工创建的同 SHA tag');
  git(values.root, 'push', 'origin', 'refs/tags/v1.0.0');

  const result = verify(values.root, values, [
    '--allow-existing-tag',
    '--recovery-run-id',
    '123456',
  ]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /workflow run 123456/);
});

test('允许已有 tag 时必须提供同一次 workflow run id', (t) => {
  const values = fixture(t);
  git(values.root, 'tag', '-a', 'v1.0.0', values.releaseSha, '-m', '人工 tag');

  const result = verify(values.root, values, ['--allow-existing-tag']);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /recovery-run-id/);
});
