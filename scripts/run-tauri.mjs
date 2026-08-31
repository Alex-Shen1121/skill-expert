import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildRustEnvironment,
  resolveCargoCommand,
  RUST_TOOLCHAIN_VERSION,
} from './rust-toolchain.mjs';

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const tauriCli = join(repositoryRoot, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');
const rustEnvironment = buildRustEnvironment();
const cargo = resolveCargoCommand(rustEnvironment);

if (!existsSync(tauriCli)) {
  console.error('未找到 Tauri CLI，请先运行 npm ci。');
  process.exit(127);
}

const cargoProbe = spawnSync(cargo, ['--version'], {
  cwd: repositoryRoot,
  encoding: 'utf8',
  env: rustEnvironment,
});

if (cargoProbe.status !== 0) {
  console.error(
    `无法启动 Rust ${RUST_TOOLCHAIN_VERSION} 工具链，请先安装 rustup 和该工具链。`,
  );
  if (cargoProbe.error) console.error(cargoProbe.error.message);
  else if (cargoProbe.stderr) console.error(cargoProbe.stderr.trim());
  process.exit(cargoProbe.status ?? 127);
}

const result = spawnSync(process.execPath, [tauriCli, ...process.argv.slice(2)], {
  cwd: repositoryRoot,
  stdio: 'inherit',
  env: rustEnvironment,
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
