import { spawnSync } from 'node:child_process';

export function runGit(cwd, args, { allowFailure = false } = {}) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    shell: false,
  });
  if (!allowFailure && result.status !== 0) {
    throw new Error(result.stderr.trim() || `Git 命令执行失败：git ${args.join(' ')}`);
  }
  return result;
}

export function git(cwd, args) {
  return runGit(cwd, args).stdout.trim();
}

export function parseWorktrees(output) {
  const records = [];
  let current = null;
  for (const field of output.split('\0')) {
    if (field === '') {
      if (current) records.push(current);
      current = null;
      continue;
    }
    const separator = field.indexOf(' ');
    const key = separator === -1 ? field : field.slice(0, separator);
    const value = separator === -1 ? true : field.slice(separator + 1);
    if (key === 'worktree') current = { path: value };
    else if (current) current[key] = value;
  }
  if (current) records.push(current);
  return records.map((record) => ({
    path: record.path,
    head: record.HEAD ?? null,
    branch: typeof record.branch === 'string' ? record.branch.replace('refs/heads/', '') : null,
    detached: record.detached === true,
    bare: record.bare === true,
    locked: record.locked === true ? true : (record.locked ?? false),
    prunable: record.prunable === true ? true : (record.prunable ?? false),
  }));
}

export function parseStatus(output) {
  const staged = [];
  const unstaged = [];
  const untracked = [];
  const fields = output.split('\0');
  for (let index = 0; index < fields.length; index += 1) {
    const record = fields[index];
    if (!record || record.startsWith('# ') || record.startsWith('! ')) continue;
    if (record.startsWith('? ')) {
      untracked.push(record.slice(2));
      continue;
    }
    const kind = record[0];
    const match =
      kind === '1'
        ? /^1 (..) \S+ \S+ \S+ \S+ \S+ \S+ (.*)$/s.exec(record)
        : kind === '2'
          ? /^2 (..) \S+ \S+ \S+ \S+ \S+ \S+ \S+ (.*)$/s.exec(record)
          : kind === 'u'
            ? /^u (..) \S+ \S+ \S+ \S+ \S+ \S+ \S+ \S+ (.*)$/s.exec(record)
            : null;
    if (!match) throw new Error('无法安全解析 Git 工作区状态');
    const [, state, currentPath] = match;
    if (state[0] !== '.') staged.push(currentPath);
    if (state[1] !== '.') unstaged.push(currentPath);
    if (kind === '2') index += 1;
  }
  return { staged, unstaged, untracked };
}
