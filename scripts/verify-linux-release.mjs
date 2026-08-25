#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertPackageVersion,
  normalizeTauriBundleBinary,
  requireStableVersion,
  verifyCliVersion,
} from './release-binary-version.mjs';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: options.encoding ?? 'utf8',
    cwd: options.cwd,
    env: options.env ?? process.env,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const details =
      String(result.stderr ?? '').trim() ||
      String(result.stdout ?? '').trim() ||
      `退出码 ${result.status}`;
    throw new Error(
      `${command} 执行失败：${details}`,
    );
  }
  return result.stdout;
}

function requireFile(filePath, label) {
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) throw new Error(`${label} 不是普通文件：${filePath}`);
  return filePath;
}

function packagedBinary(root, label) {
  return requireFile(path.join(root, 'usr', 'bin', 'skill-expert'), `${label} 主程序`);
}

const APPIMAGE_BUNDLE_MARKER = Buffer.from('__TAURI_BUNDLE_TYPE_VAR_APP');
export const RPM_EXTRACTION_SCRIPT = [
  'set -euo pipefail',
  'rpm2cpio "$1" | (cd "$2" && cpio --extract --make-directories --preserve-modification-time --no-absolute-filenames --no-preserve-owner --quiet)',
].join('; ');

function readElfBuildId(filePath, label) {
  const output = run('readelf', ['--notes', filePath]);
  const matches = [...output.matchAll(/Build ID:\s*([0-9a-f]+)/gi)].map((match) =>
    match[1].toLowerCase(),
  );
  if (matches.length !== 1) {
    throw new Error(`${label} 主程序必须包含唯一的 ELF build-id，实际为 ${matches.length} 个`);
  }
  return matches[0];
}

export function verifyLinuxBundleBinaries({ deb, rpm, appImage, buildIds }) {
  const normalizedDeb = normalizeTauriBundleBinary(deb, 'DEB');
  const normalizedRpm = normalizeTauriBundleBinary(rpm, 'RPM');
  if (!normalizedDeb.equals(normalizedRpm)) {
    throw new Error('DEB 与 RPM 内的主程序除 bundle type 标记外必须完全一致');
  }

  normalizeTauriBundleBinary(appImage, 'AppImage');
  if (appImage.indexOf(APPIMAGE_BUNDLE_MARKER) === -1) {
    throw new Error('AppImage 主程序必须包含唯一的 Tauri APP 身份标记');
  }

  if (
    !buildIds?.deb ||
    buildIds.deb !== buildIds.rpm ||
    buildIds.deb !== buildIds.appImage
  ) {
    throw new Error('DEB、RPM 与 AppImage 内主程序的 ELF build-id 必须证明来自同一次构建');
  }
}

export function verifyLinuxRelease(directory, version) {
  if (process.platform !== 'linux') throw new Error('Linux 正式资产回验需要 Linux runner');
  requireStableVersion(version);
  const prefix = `skill-expert-v${version}-linux-x64`;
  const cli = requireFile(path.join(directory, `skill-expert-cli-v${version}-linux-x64`), 'CLI');
  const appImage = requireFile(path.join(directory, `${prefix}.AppImage`), 'AppImage');
  const deb = requireFile(path.join(directory, `${prefix}.deb`), 'DEB');
  const rpm = requireFile(path.join(directory, `${prefix}.rpm`), 'RPM');

  fs.chmodSync(cli, fs.statSync(cli).mode | 0o111);
  verifyCliVersion(cli, version);
  assertPackageVersion('DEB', run('dpkg-deb', ['--field', deb, 'Version']), version);
  assertPackageVersion('RPM', run('rpm', ['-qp', '--queryformat', '%{VERSION}', rpm]), version);

  const extractionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-expert-linux-release-'));
  try {
    const debRoot = path.join(extractionRoot, 'deb');
    const rpmRoot = path.join(extractionRoot, 'rpm');
    const appImageRoot = path.join(extractionRoot, 'appimage');
    fs.mkdirSync(debRoot);
    fs.mkdirSync(rpmRoot);
    fs.mkdirSync(appImageRoot);
    run('dpkg-deb', ['--extract', deb, debRoot]);
    run('bash', [
      '-c',
      RPM_EXTRACTION_SCRIPT,
      'verify-rpm',
      rpm,
      rpmRoot,
    ]);
    fs.chmodSync(appImage, fs.statSync(appImage).mode | 0o111);
    run(appImage, ['--appimage-extract'], { cwd: appImageRoot });

    const debBinary = packagedBinary(debRoot, 'DEB');
    const rpmBinary = packagedBinary(rpmRoot, 'RPM');
    const appImageBinary = packagedBinary(
      path.join(appImageRoot, 'squashfs-root'),
      'AppImage',
    );
    verifyLinuxBundleBinaries({
      deb: fs.readFileSync(debBinary),
      rpm: fs.readFileSync(rpmBinary),
      appImage: fs.readFileSync(appImageBinary),
      buildIds: {
        deb: readElfBuildId(debBinary, 'DEB'),
        rpm: readElfBuildId(rpmBinary, 'RPM'),
        appImage: readElfBuildId(appImageBinary, 'AppImage'),
      },
    });
  } finally {
    fs.rmSync(extractionRoot, { recursive: true, force: true });
  }
  console.log(`Linux 正式资产原生版本回验通过：${version}。`);
}

function main() {
  try {
    const args = process.argv.slice(2);
    const options = {};
    for (let index = 0; index < args.length; index += 2) {
      options[args[index]?.replace(/^--/, '')] = args[index + 1];
    }
    if (!options.directory || !options.version) {
      throw new Error('用法：verify-linux-release.mjs --directory 路径 --version x.y.z');
    }
    verifyLinuxRelease(options.directory, options.version);
  } catch (error) {
    console.error(`Linux 正式资产回验失败：${error.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
