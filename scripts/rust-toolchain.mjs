import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';

export const RUST_TOOLCHAIN_VERSION = '1.98.0';

export function buildRustEnvironment({
  baseEnvironment = process.env,
  homeDirectory = homedir(),
  platform = process.platform,
  fileExists = existsSync,
} = {}) {
  const environment = { ...baseEnvironment };
  const executableSuffix = platform === 'win32' ? '.exe' : '';
  const defaultCargoBin = join(homeDirectory, '.cargo', 'bin');
  const defaultRustup = join(defaultCargoBin, `rustup${executableSuffix}`);
  const defaultCargo = join(defaultCargoBin, `cargo${executableSuffix}`);
  const explicitCargo = baseEnvironment.CARGO;
  const rustBinDirectory =
    explicitCargo && fileExists(explicitCargo)
      ? dirname(explicitCargo)
      : fileExists(defaultRustup) || fileExists(defaultCargo)
        ? defaultCargoBin
        : null;

  if (rustBinDirectory) {
    const pathEntries = (environment.PATH ?? '').split(delimiter).filter(Boolean);
    environment.PATH = [
      rustBinDirectory,
      ...pathEntries.filter((entry) => entry !== rustBinDirectory),
    ].join(delimiter);
  }

  environment.RUSTUP_TOOLCHAIN = RUST_TOOLCHAIN_VERSION;
  return environment;
}

export function resolveCargoCommand(environment = process.env) {
  return environment.CARGO && existsSync(environment.CARGO)
    ? environment.CARGO
    : process.platform === 'win32'
      ? 'cargo.exe'
      : 'cargo';
}
