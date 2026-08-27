import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('AGENTS.md 给出可执行的开发序号与正式发布边界', () => {
  const agents = readFileSync(path.join(repositoryRoot, 'AGENTS.md'), 'utf8');

  assert.match(agents, /npm run version:prepare-development/);
  assert.match(agents, /1\.0\.3 → 1\.0\.3-1 → 1\.0\.3-2/);
  assert.match(agents, /release-prep\/v1\.0\.4/);
  assert.match(agents, /1\.0\.3-N → 1\.0\.4/);
  assert.match(agents, /开发序号[^\n]+不[^\n]+四平台/);
  assert.match(agents, /正式版本[^\n]+四平台/);
  assert.match(agents, /main[^\n]+release[^\n]+下一补丁版本/);
  assert.match(agents, /strict_required_status_checks_policy=true/);
  assert.match(agents, /并发 PR[^\n]+不能复用同一个开发序号/);
});
