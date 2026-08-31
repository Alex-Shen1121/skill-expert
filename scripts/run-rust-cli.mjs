import { spawnSync } from 'node:child_process';
import { buildRustEnvironment, resolveCargoCommand } from './rust-toolchain.mjs';

const mode = process.argv[2];
const extraArgs = process.argv.slice(3);
const rustEnvironment = buildRustEnvironment();
const cargo = resolveCargoCommand(rustEnvironment);

const baseArgs = ['--manifest-path', 'src-tauri/Cargo.toml', '--bin', 'skill-expert-cli'];
const cargoArgs =
  mode === 'cli'
    ? ['run', '--quiet', ...baseArgs, '--', ...extraArgs]
    : mode === 'build'
      ? ['build', ...baseArgs]
      : mode === 'install'
        ? ['install', '--path', 'src-tauri', '--bin', 'skill-expert-cli', '--locked', '--force']
        : null;

if (!cargoArgs) {
  console.error(`未知模式：${mode}`);
  process.exit(2);
}

const result = spawnSync(cargo, cargoArgs, {
  stdio: 'inherit',
  env: rustEnvironment,
});

if (result.error) {
  console.error(`无法启动固定 Rust 工具链：${result.error.message}`);
  process.exit(result.error.code === 'ENOENT' ? 127 : 1);
}

process.exit(result.status ?? 1);
