import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baselineCli = path.join(repositoryRoot, 'scripts/worktree-baseline.mjs');

function runGit(repository, args, { allowFailure = false } = {}) {
  const result = spawnSync('git', args, {
    cwd: repository,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    shell: false,
  });
  if (!allowFailure) {
    assert.equal(result.status, 0, result.stderr || `git ${args.join(' ')} 执行失败`);
  }
  return result;
}

function git(repository, ...args) {
  return runGit(repository, args).stdout.trim();
}

function write(repository, relativePath, contents) {
  const filePath = path.join(repository, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, contents);
}

function createFixture(t, { defaultBranch = 'main' } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'skill-expert-preflight-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const seed = path.join(root, '远端种子');
  const origin = path.join(root, 'origin.git');
  const primary = path.join(root, '主工作目录');
  const implementation = path.join(root, '实现工作树');

  mkdirSync(seed);
  git(seed, 'init', '-b', defaultBranch);
  git(seed, 'config', 'user.name', '实现基线测试');
  git(seed, 'config', 'user.email', 'preflight@example.com');
  write(seed, 'tracked.txt', '初始内容\n');
  git(seed, 'add', 'tracked.txt');
  git(seed, 'commit', '-m', '建立远端基线');
  git(root, 'init', '--bare', `--initial-branch=${defaultBranch}`, origin);
  git(seed, 'remote', 'add', 'origin', origin);
  git(seed, 'push', '-u', 'origin', defaultBranch);

  git(root, 'clone', origin, primary);
  git(primary, 'config', 'user.name', '实现基线测试');
  git(primary, 'config', 'user.email', 'preflight@example.com');
  git(
    primary,
    'worktree',
    'add',
    '-b',
    'codex/实现测试',
    implementation,
    `origin/${defaultBranch}`,
  );

  return {
    root,
    seed,
    origin,
    primary: realpathSync.native(primary),
    implementation: realpathSync.native(implementation),
  };
}

function runPreflight(repository, ...args) {
  return spawnSync(process.execPath, [baselineCli, 'preflight', ...args], {
    cwd: repository,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    shell: false,
  });
}

function parseReport(result) {
  assert.equal(result.stderr, '');
  return JSON.parse(result.stdout);
}

function commitFile(repository, relativePath, contents, message) {
  write(repository, relativePath, contents);
  git(repository, 'add', '--', relativePath);
  git(repository, 'commit', '-m', message);
  return git(repository, 'rev-parse', 'HEAD');
}

test('首次放行干净且基于最新 main 的 codex 分支，并在后续校验复用基线', (t) => {
  const { implementation } = createFixture(t);
  const expectedBaseline = git(implementation, 'rev-parse', 'origin/main');

  const initialResult = runPreflight(implementation, '--json');

  assert.equal(initialResult.status, 0, initialResult.stderr);
  const initialReport = parseReport(initialResult);
  assert.equal(initialReport.schemaVersion, 1);
  assert.equal(initialReport.command, 'preflight');
  assert.equal(initialReport.exitCode, 0);
  assert.equal(initialReport.mode, 'initial');
  assert.equal(initialReport.implementationBaseline.sha, expectedBaseline);
  assert.equal(initialReport.implementationBaseline.scope, 'worktree');
  assert.ok(initialReport.statuses.includes('implementation-baseline-recorded'));
  assert.ok(initialReport.statuses.includes('implementation-preflight-passed'));

  const continuedResult = runPreflight(implementation, '--json');

  assert.equal(continuedResult.status, 0, continuedResult.stderr);
  const continuedReport = parseReport(continuedResult);
  assert.equal(continuedReport.mode, 'continued');
  assert.equal(continuedReport.implementationBaseline.sha, expectedBaseline);
  assert.ok(continuedReport.statuses.includes('implementation-baseline-verified'));
  assert.ok(continuedReport.statuses.includes('implementation-preflight-passed'));
});

test('远端 main 在实现开始后正常前移时只警告且不重写实现基线', (t) => {
  const { seed, implementation } = createFixture(t);
  const recordedBaseline = git(implementation, 'rev-parse', 'origin/main');
  assert.equal(runPreflight(implementation, '--json').status, 0);
  commitFile(implementation, '本地实现.txt', '实现进行中\n', '本地实现提交');
  const advancedRemote = commitFile(seed, '远端后续.txt', '后续内容\n', '远端后续提交');
  git(seed, 'push', 'origin', 'main');

  const result = runPreflight(implementation, '--json');

  assert.equal(result.status, 0, result.stderr);
  const report = parseReport(result);
  assert.equal(report.mode, 'continued');
  assert.equal(report.remoteBaseline.sha, advancedRemote);
  assert.equal(report.implementationBaseline.sha, recordedBaseline);
  assert.ok(report.statuses.includes('remote-baseline-advanced'));
  assert.ok(report.statuses.includes('implementation-baseline-verified'));
  assert.ok(report.statuses.includes('implementation-preflight-passed'));
  assert.ok(report.conclusions.some((message) => message.includes('远端 main 已前移')));
});

test('detached、main 与其他命名分支都不能进入实现阶段', (t) => {
  const { primary, implementation } = createFixture(t);

  git(implementation, 'switch', '--detach');
  const detachedResult = runPreflight(implementation, '--json');
  assert.equal(detachedResult.status, 1, detachedResult.stderr);
  const detachedReport = parseReport(detachedResult);
  assert.ok(detachedReport.statuses.includes('detached-head'));
  assert.ok(detachedReport.statuses.includes('implementation-preflight-blocked'));
  assert.ok(detachedReport.conclusions.some((message) => message.includes('只读')));
  assert.ok(
    detachedReport.conclusions.some(
      (message) => message.includes('切换') && message.includes('codex/*'),
    ),
  );

  const mainResult = runPreflight(primary, '--json');
  assert.equal(mainResult.status, 1, mainResult.stderr);
  const mainReport = parseReport(mainResult);
  assert.ok(mainReport.statuses.includes('implementation-branch-disallowed'));
  assert.ok(mainReport.conclusions.some((message) => message.includes('codex/*')));

  git(implementation, 'switch', '-c', 'feature/错误分支');
  const otherResult = runPreflight(implementation, '--json');
  assert.equal(otherResult.status, 1, otherResult.stderr);
  const otherReport = parseReport(otherResult);
  assert.ok(otherReport.statuses.includes('implementation-branch-disallowed'));
  assert.ok(otherReport.conclusions.some((message) => message.includes('codex/*')));
});

test('已暂存、未暂存或未跟踪内容都会阻止首次实现校验且不写入配置', (t) => {
  const scenarios = [
    {
      status: 'working-tree-staged',
      change(repository) {
        write(repository, '已暂存.txt', '暂存内容\n');
        git(repository, 'add', '已暂存.txt');
      },
    },
    {
      status: 'working-tree-unstaged',
      change(repository) {
        write(repository, 'tracked.txt', '未暂存内容\n');
      },
    },
    {
      status: 'working-tree-untracked',
      change(repository) {
        write(repository, '.superpowers/未跟踪.txt', '不得吸收\n');
      },
    },
  ];

  for (const scenario of scenarios) {
    const { implementation } = createFixture(t);
    scenario.change(implementation);

    const result = runPreflight(implementation, '--json');

    assert.equal(result.status, 1, result.stderr);
    const report = parseReport(result);
    assert.ok(report.statuses.includes(scenario.status));
    assert.ok(report.statuses.includes('working-tree-dirty'));
    assert.ok(report.statuses.includes('implementation-preflight-blocked'));
    assert.ok(report.conclusions.some((message) => message.includes('干净')));
    assert.equal(
      runGit(implementation, ['config', '--get', 'extensions.worktreeConfig'], {
        allowFailure: true,
      }).status,
      1,
    );
  }
});

test('首次校验拒绝未包含最新 origin/main 的过旧实现起点', (t) => {
  const { seed, implementation } = createFixture(t);
  const remoteSha = commitFile(seed, '最新远端.txt', '远端新内容\n', '推进远端 main');
  git(seed, 'push', 'origin', 'main');

  const result = runPreflight(implementation, '--json');

  assert.equal(result.status, 1, result.stderr);
  const report = parseReport(result);
  assert.equal(report.mode, 'blocked');
  assert.equal(report.remoteBaseline.sha, remoteSha);
  assert.ok(report.statuses.includes('implementation-start-outdated'));
  assert.ok(report.statuses.includes('implementation-preflight-blocked'));
  assert.ok(report.conclusions.some((message) => message.includes('最新 origin/main')));
  assert.ok(
    report.conclusions.some(
      (message) => message.includes('创建') && message.includes('codex/*'),
    ),
  );
  assert.equal(
    runGit(implementation, ['config', '--get', 'extensions.worktreeConfig'], {
      allowFailure: true,
    }).status,
    1,
  );
});

test('实现基线记录缺失、被篡改或不再属于当前历史时都阻止继续实现', (t) => {
  const missingFixture = createFixture(t);
  assert.equal(runPreflight(missingFixture.implementation, '--json').status, 0);
  for (const key of [
    'skill-expert.implementationBaseline',
    'skill-expert.implementationBranch',
    'skill-expert.implementationIntegrity',
    'skill-expert.implementationStarted',
  ]) {
    git(missingFixture.implementation, 'config', '--worktree', '--unset', key);
  }

  const missingResult = runPreflight(missingFixture.implementation, '--json');

  assert.equal(missingResult.status, 1, missingResult.stderr);
  const missingReport = parseReport(missingResult);
  assert.ok(missingReport.statuses.includes('implementation-baseline-missing'));
  assert.ok(missingReport.conclusions.some((message) => message.includes('缺失')));

  const tamperedFixture = createFixture(t);
  assert.equal(runPreflight(tamperedFixture.implementation, '--json').status, 0);
  const substitutedBaseline = commitFile(
    tamperedFixture.implementation,
    '本地实现.txt',
    '实现内容\n',
    '本地实现提交',
  );
  git(
    tamperedFixture.implementation,
    'config',
    '--worktree',
    'skill-expert.implementationBaseline',
    substitutedBaseline,
  );

  const tamperedResult = runPreflight(tamperedFixture.implementation, '--json');

  assert.equal(tamperedResult.status, 1, tamperedResult.stderr);
  const tamperedReport = parseReport(tamperedResult);
  assert.ok(tamperedReport.statuses.includes('implementation-baseline-tampered'));
  assert.ok(tamperedReport.conclusions.some((message) => message.includes('完整性')));

  const rewrittenFixture = createFixture(t);
  assert.equal(runPreflight(rewrittenFixture.implementation, '--json').status, 0);
  const tree = git(rewrittenFixture.implementation, 'write-tree');
  const unrelatedCommit = git(
    rewrittenFixture.implementation,
    'commit-tree',
    tree,
    '-m',
    '重写当前分支历史',
  );
  git(rewrittenFixture.implementation, 'reset', '--hard', unrelatedCommit);

  const rewrittenResult = runPreflight(rewrittenFixture.implementation, '--json');

  assert.equal(rewrittenResult.status, 1, rewrittenResult.stderr);
  const rewrittenReport = parseReport(rewrittenResult);
  assert.ok(rewrittenReport.statuses.includes('implementation-baseline-not-ancestor'));
  assert.ok(rewrittenReport.conclusions.some((message) => message.includes('不是当前分支历史')));
});

test('linked worktree 分别记录实现基线且保留 Codex 本地环境配置', (t) => {
  const { root, primary, implementation } = createFixture(t);
  const secondPath = path.join(root, '第二实现工作树');
  git(primary, 'worktree', 'add', '-b', 'codex/第二实现', secondPath, 'origin/main');
  const second = realpathSync.native(secondPath);
  git(primary, 'config', 'extensions.worktreeConfig', 'true');
  const environmentPath = path.join(root, '环境配置.toml');
  git(
    implementation,
    'config',
    '--worktree',
    'codex.localenvironmentconfigpath',
    environmentPath,
  );

  const firstResult = runPreflight(implementation, '--json');
  const secondResult = runPreflight(second, '--json');

  assert.equal(firstResult.status, 0, firstResult.stderr);
  assert.equal(secondResult.status, 0, secondResult.stderr);
  const firstReport = parseReport(firstResult);
  const secondReport = parseReport(secondResult);
  assert.equal(firstReport.mode, 'initial');
  assert.equal(secondReport.mode, 'initial');
  assert.equal(firstReport.implementationBaseline.worktree, implementation);
  assert.equal(secondReport.implementationBaseline.worktree, second);
  assert.notEqual(firstReport.implementationBaseline.worktree, secondReport.implementationBaseline.worktree);
  assert.equal(
    git(implementation, 'config', '--worktree', '--get', 'codex.localenvironmentconfigpath'),
    environmentPath,
  );
  assert.equal(
    runGit(second, [
      'config',
      '--worktree',
      '--get',
      'codex.localenvironmentconfigpath',
    ], { allowFailure: true }).status,
    1,
  );
  const firstContinued = parseReport(runPreflight(implementation, '--json'));
  assert.equal(firstContinued.mode, 'continued');
});

test('远端不可用时首次和后续校验都拒绝使用缓存引用放行', (t) => {
  const initialFixture = createFixture(t);
  git(
    initialFixture.primary,
    'remote',
    'set-url',
    'origin',
    path.join(initialFixture.root, '不存在.git'),
  );

  const initialResult = runPreflight(initialFixture.implementation, '--json');

  assert.equal(initialResult.status, 1, initialResult.stderr);
  const initialReport = parseReport(initialResult);
  assert.ok(initialReport.statuses.includes('remote-baseline-unconfirmed'));
  assert.ok(initialReport.statuses.includes('implementation-preflight-blocked'));
  assert.ok(initialReport.conclusions.some((message) => message.includes('无法确认最新远端基线')));
  assert.equal(
    runGit(initialFixture.implementation, ['config', '--get', 'extensions.worktreeConfig'], {
      allowFailure: true,
    }).status,
    1,
  );

  const continuedFixture = createFixture(t);
  assert.equal(runPreflight(continuedFixture.implementation, '--json').status, 0);
  git(
    continuedFixture.primary,
    'remote',
    'set-url',
    'origin',
    path.join(continuedFixture.root, '同样不存在.git'),
  );

  const continuedResult = runPreflight(continuedFixture.implementation, '--json');

  assert.equal(continuedResult.status, 1, continuedResult.stderr);
  const continuedReport = parseReport(continuedResult);
  assert.ok(continuedReport.statuses.includes('remote-baseline-unconfirmed'));
  assert.ok(continuedReport.statuses.includes('implementation-preflight-blocked'));
});

test('worktree 切换到另一个 codex 分支后不能复用原分支实现基线', (t) => {
  const { implementation } = createFixture(t);
  assert.equal(runPreflight(implementation, '--json').status, 0);
  git(implementation, 'switch', '-c', 'codex/另一个实现');

  const result = runPreflight(implementation, '--json');

  assert.equal(result.status, 1, result.stderr);
  const report = parseReport(result);
  assert.ok(report.statuses.includes('implementation-baseline-branch-mismatch'));
  assert.ok(report.conclusions.some((message) => message.includes('不能用于当前分支')));
});

test('远端 main 历史改写后阻止继续使用旧实现基线', (t) => {
  const { seed, implementation } = createFixture(t);
  assert.equal(runPreflight(implementation, '--json').status, 0);
  git(seed, 'checkout', '--orphan', '替代历史');
  write(seed, '替代.txt', '无共同祖先\n');
  git(seed, 'add', '替代.txt');
  git(seed, 'commit', '-m', '替代远端历史');
  const rewrittenRemote = git(seed, 'rev-parse', 'HEAD');
  git(seed, 'push', '--force', 'origin', 'HEAD:main');

  const result = runPreflight(implementation, '--json');

  assert.equal(result.status, 1, result.stderr);
  const report = parseReport(result);
  assert.equal(report.remoteBaseline.sha, rewrittenRemote);
  assert.ok(report.statuses.includes('remote-baseline-history-rewritten'));
  assert.ok(report.statuses.includes('implementation-preflight-blocked'));
  assert.ok(report.conclusions.some((message) => message.includes('不再包含')));
});

test('人类输出用中文明确区分实现基线校验通过与被阻止', (t) => {
  const passedFixture = createFixture(t);

  const passedResult = runPreflight(passedFixture.implementation);

  assert.equal(passedResult.status, 0, passedResult.stderr);
  assert.match(passedResult.stdout, /实现阶段基线校验通过/);
  assert.match(passedResult.stdout, /已记录当前 worktree 的实现基线/);

  const blockedFixture = createFixture(t);
  write(blockedFixture.implementation, '未跟踪.txt', '不干净\n');

  const blockedResult = runPreflight(blockedFixture.implementation);

  assert.equal(blockedResult.status, 1, blockedResult.stderr);
  assert.match(blockedResult.stdout, /实现阶段基线校验未通过/);
  assert.match(blockedResult.stdout, /请先妥善处理全部变更/);
});

test('远端默认分支不是 main 时不能把其他分支记录为实现基线', (t) => {
  const { implementation } = createFixture(t, { defaultBranch: 'master' });

  const result = runPreflight(implementation, '--json');

  assert.equal(result.status, 1, result.stderr);
  const report = parseReport(result);
  assert.equal(report.remoteBaseline.branch, 'master');
  assert.ok(report.statuses.includes('remote-default-branch-unexpected'));
  assert.ok(report.statuses.includes('implementation-preflight-blocked'));
  assert.ok(report.conclusions.some((message) => message.includes('必须为 main')));
});
