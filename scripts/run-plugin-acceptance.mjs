import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultRoot = path.join(os.tmpdir(), 'skill-expert-issue-132-acceptance', 'runtime');
const rootFlagIndex = process.argv.indexOf('--root');
const requestedRoot = rootFlagIndex >= 0 ? process.argv[rootFlagIndex + 1] : defaultRoot;

if (!requestedRoot) {
  console.error('缺少 --root 后的隔离状态目录。');
  process.exit(2);
}

const acceptanceRoot = path.resolve(requestedRoot);
const forbiddenRoots = new Set([
  path.parse(acceptanceRoot).root,
  os.homedir(),
  repositoryRoot,
]);
if (forbiddenRoots.has(acceptanceRoot)) {
  console.error('验收状态目录不能是文件系统根、用户主目录或仓库根。');
  process.exit(2);
}
fs.mkdirSync(acceptanceRoot, { recursive: true });

const acceptanceEnvironment = {
  ...process.env,
  SKILL_EXPERT_ACCEPTANCE_ROOT: acceptanceRoot,
};

const runCommand = (command, args) => {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    stdio: 'inherit',
    env: acceptanceEnvironment,
  });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
};

const runScript = (script, args) => {
  runCommand(process.execPath, [path.join(repositoryRoot, script), ...args]);
};

console.log(`插件验收状态根：${acceptanceRoot}`);
runScript('scripts/run-rust-cli.mjs', ['build']);

if (process.platform === 'darwin') {
  runScript('scripts/run-tauri.mjs', [
    'build', '--debug', '--bundles', 'app',
    '--config', 'src-tauri/tauri.acceptance.conf.json',
  ]);
  const executable = path.join(
    repositoryRoot,
    'src-tauri/target/debug/bundle/macos',
    'Agent 技能管家 · 插件验收.app',
    'Contents',
    'MacOS',
    'skill-expert',
  );
  if (!fs.existsSync(executable)) {
    console.error('未生成独立的 macOS 插件验收应用。');
    process.exit(1);
  }
  runCommand(executable, []);
} else {
  runScript('scripts/run-tauri.mjs', [
    'dev',
    '--config',
    'src-tauri/tauri.acceptance.conf.json',
  ]);
}
