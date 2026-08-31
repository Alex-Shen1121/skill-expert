import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  buildRustEnvironment,
  RUST_TOOLCHAIN_VERSION,
} from './rust-toolchain.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('仓库固定使用 Rust 1.98.0 最小工具链', () => {
  assert.equal(RUST_TOOLCHAIN_VERSION, '1.98.0');
  assert.equal(
    readFileSync(path.join(repositoryRoot, 'rust-toolchain.toml'), 'utf8'),
    '[toolchain]\nchannel = "1.98.0"\nprofile = "minimal"\n',
  );
});

test('PATH 缺少 cargo 时仍会使用用户默认 rustup 目录和固定工具链', (t) => {
  const fakeHome = mkdtempSync(path.join(tmpdir(), 'skill-expert-rust-toolchain-'));
  t.after(() => rmSync(fakeHome, { recursive: true, force: true }));
  const cargoBin = path.join(fakeHome, '.cargo', 'bin');
  mkdirSync(cargoBin, { recursive: true });
  writeFileSync(path.join(cargoBin, 'rustup'), 'fixture');
  writeFileSync(path.join(cargoBin, 'cargo'), 'fixture');

  const environment = buildRustEnvironment({
    baseEnvironment: {
      PATH: '/usr/bin:/bin',
      RUSTUP_TOOLCHAIN: '1.77.2',
    },
    homeDirectory: fakeHome,
    platform: 'darwin',
    fileExists: existsSync,
  });

  assert.equal(environment.RUSTUP_TOOLCHAIN, '1.98.0');
  assert.equal(environment.PATH.split(path.delimiter)[0], cargoBin);
});

test('Tauri 开发入口统一经过 Rust 工具链启动器', () => {
  const packageJson = JSON.parse(
    readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'),
  );

  assert.equal(
    packageJson.scripts['tauri:dev'],
    'node scripts/run-tauri.mjs dev --config src-tauri/tauri.dev.conf.json',
  );
});

for (const workflow of [
  '.github/workflows/test.yml',
  '.github/workflows/test-package-build.yml',
  '.github/workflows/release.yml',
]) {
  test(`${workflow} 显式安装固定 Rust 工具链`, () => {
    const contents = readFileSync(path.join(repositoryRoot, workflow), 'utf8');
    const actionUses = contents.match(/uses: dtolnay\/rust-toolchain@/g) ?? [];
    const pinnedInputs = contents.match(/toolchain: 1\.98\.0/g) ?? [];

    assert.ok(actionUses.length > 0, `${workflow} 必须安装 Rust 工具链`);
    assert.equal(pinnedInputs.length, actionUses.length);
  });
}
