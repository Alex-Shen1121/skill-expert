import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  readlinkSync,
  realpathSync,
} from 'node:fs';
import path from 'node:path';

import { git, parseStatus, runGit } from './git.mjs';

export function normalizePath(value) {
  return realpathSync.native(path.resolve(value));
}

function repositoryIgnoresCase(cwd) {
  if (process.platform === 'win32') return true;
  return runGit(cwd, ['config', '--bool', 'core.ignoreCase'], {
    allowFailure: true,
  }).stdout.trim() === 'true';
}

export function repositoryPathKey(cwd, value) {
  const normalized = normalizePath(value).replaceAll('\\', '/');
  return repositoryIgnoresCase(cwd) ? normalized.toLowerCase() : normalized;
}

export function repositoryPathsEqual(cwd, left, right) {
  return repositoryPathKey(cwd, left) === repositoryPathKey(cwd, right);
}

export function repositoryRelativePathKey(cwd, value) {
  const normalized = value.replaceAll('\\', '/');
  return repositoryIgnoresCase(cwd) ? normalized.toLowerCase() : normalized;
}

export function resolveCommit(cwd, ref) {
  const result = runGit(cwd, ['rev-parse', '--verify', `${ref}^{commit}`], {
    allowFailure: true,
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

export function findOngoingOperation(cwd) {
  const markers = [
    ['MERGE_HEAD', 'merge'],
    ['CHERRY_PICK_HEAD', 'cherry-pick'],
    ['REVERT_HEAD', 'revert'],
    ['BISECT_LOG', 'bisect'],
    ['rebase-merge', 'rebase'],
    ['rebase-apply', 'rebase'],
    ['sequencer', 'sequencer'],
  ];
  for (const [marker, operation] of markers) {
    const gitPath = git(cwd, ['rev-parse', '--git-path', marker]);
    const absolutePath = path.isAbsolute(gitPath) ? gitPath : path.resolve(cwd, gitPath);
    if (existsSync(absolutePath)) return operation;
  }
  return null;
}

export function readWorkingTreeStatus(cwd) {
  const status = parseStatus(
    runGit(cwd, ['status', '--porcelain=v2', '-z', '--untracked-files=all']).stdout,
  );
  return {
    staged: [...status.staged].sort(),
    unstaged: [...status.unstaged].sort(),
    untracked: [...status.untracked].sort(),
    ignored: ignoredRoots(cwd),
  };
}

function ignoredRoots(cwd) {
  const output = runGit(cwd, [
    'status',
    '--porcelain=v2',
    '-z',
    '--untracked-files=normal',
    '--ignored=matching',
  ]).stdout;
  return output.split('\0')
    .filter((record) => record.startsWith('! '))
    .map((record) => record.slice(2).replace(/[\\/]$/, ''))
    .filter(Boolean)
    .sort();
}

function hashFile(absolutePath) {
  const digest = createHash('sha256');
  const descriptor = openSync(absolutePath, 'r');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    let bytesRead;
    do {
      bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead > 0) digest.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    closeSync(descriptor);
  }
  return digest.digest('hex');
}

function joinGitPath(parent, child) {
  return parent ? `${parent}/${child}` : child;
}

function absoluteGitPath(cwd, relativePath) {
  return path.join(cwd, ...relativePath.split('/'));
}

function fingerprintEntry(cwd, relativePath, source, records) {
  const absolutePath = absoluteGitPath(cwd, relativePath);
  const stat = lstatSync(absolutePath);
  const mode = stat.mode;
  if (stat.isSymbolicLink()) {
    const target = readlinkSync(absolutePath);
    const record = {
      path: relativePath,
      source,
      type: 'symlink',
      mode,
      size: stat.size,
      digest: createHash('sha256').update(target).digest('hex'),
    };
    records.push(record);
    return record;
  }
  if (stat.isFile()) {
    const record = {
      path: relativePath,
      source,
      type: 'file',
      mode,
      size: stat.size,
      digest: hashFile(absolutePath),
    };
    records.push(record);
    return record;
  }
  if (stat.isDirectory()) {
    const childNames = readdirSync(absolutePath).sort();
    const children = [];
    for (const childName of childNames) {
      children.push(fingerprintEntry(cwd, joinGitPath(relativePath, childName), source, records));
    }
    const record = {
      path: relativePath,
      source,
      type: 'directory',
      mode,
      size: stat.size,
      digest: createHash('sha256').update(JSON.stringify(children)).digest('hex'),
    };
    records.push(record);
    return record;
  }
  const record = {
    path: relativePath,
    source,
    type: 'other',
    mode,
    size: stat.size,
    digest: createHash('sha256').update(`${mode}:${stat.size}`).digest('hex'),
  };
  records.push(record);
  return record;
}

export function captureUntrackedState(cwd) {
  const status = readWorkingTreeStatus(cwd);
  const roots = [
    ...status.untracked.map((relativePath) => ({ relativePath, source: 'untracked' })),
    ...status.ignored.map((relativePath) => ({ relativePath, source: 'ignored' })),
  ];
  const uniqueRoots = new Map();
  for (const root of roots) {
    uniqueRoots.set(`${root.source}\0${root.relativePath}`, root);
  }
  const entries = [];
  for (const { relativePath, source } of [...uniqueRoots.values()].sort((left, right) => {
    const leftKey = `${left.source}\0${left.relativePath}`;
    const rightKey = `${right.source}\0${right.relativePath}`;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  })) {
    fingerprintEntry(cwd, relativePath, source, entries);
  }
  entries.sort((left, right) => {
    const leftKey = `${left.path}\0${left.source}`;
    const rightKey = `${right.path}\0${right.source}`;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
  return {
    untrackedPaths: status.untracked,
    ignoredPaths: status.ignored,
    entries,
    digest: createHash('sha256').update(JSON.stringify(entries)).digest('hex'),
  };
}
