import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baselineCli = path.join(repositoryRoot, 'scripts/worktree-baseline.mjs');

test('稳定公开入口提供中文帮助并区分只读、校验、计划与显式变更', () => {
  const result = spawnSync(
    process.execPath,
    [baselineCli, 'help'],
    { cwd: repositoryRoot, encoding: 'utf8', shell: false },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /diagnose.*只读诊断/s);
  assert.match(result.stdout, /preflight.*实现前/s);
  assert.match(result.stdout, /recovery.*计划预览/s);
  assert.match(result.stdout, /--apply.*--confirm.*--primary-worktree/s);
  assert.match(result.stdout, /sync.*显式变更/s);
  assert.match(result.stdout, /0.*安全条件满足/s);
  assert.match(result.stdout, /1.*安全门阻止/s);
  assert.match(result.stdout, /2.*参数错误/s);
});
