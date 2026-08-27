import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workflowDirectory = path.join(repositoryRoot, '.github/workflows');
const requiredNode24Actions = new Map([
  ['actions/checkout', '3d3c42e5aac5ba805825da76410c181273ba90b1'],
  ['actions/setup-node', '820762786026740c76f36085b0efc47a31fe5020'],
]);

function workflowActionReferences() {
  return fs
    .readdirSync(workflowDirectory)
    .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
    .sort()
    .flatMap((name) => {
      const workflowPath = path.join(workflowDirectory, name);
      const content = fs.readFileSync(workflowPath, 'utf8');
      const references = [];

      for (const match of content.matchAll(/^\s*uses:\s*([^\s#]+)/gm)) {
        const value = match[1];
        if (value.startsWith('./')) continue;
        const line = content.slice(0, match.index).split('\n').length;
        references.push({ file: `.github/workflows/${name}`, line, value });
      }

      return references;
    });
}

test('所有第三方 Action 都固定到不可漂移的完整提交 SHA', () => {
  for (const reference of workflowActionReferences()) {
    assert.match(
      reference.value,
      /^[^@]+@[0-9a-f]{40}$/,
      `${reference.file}:${reference.line} 使用了可漂移引用 ${reference.value}`,
    );
  }
});

test('GitHub 官方 JavaScript Action 使用经过核验的 Node 24 版本', () => {
  const found = new Set();

  for (const reference of workflowActionReferences()) {
    const separator = reference.value.lastIndexOf('@');
    const action = reference.value.slice(0, separator);
    const revision = reference.value.slice(separator + 1);
    const requiredRevision = requiredNode24Actions.get(action);
    if (!requiredRevision) continue;

    found.add(action);
    assert.equal(
      revision,
      requiredRevision,
      `${reference.file}:${reference.line} 的 ${action} 仍使用旧运行时`,
    );
  }

  assert.deepEqual(found, new Set(requiredNode24Actions.keys()));
});
