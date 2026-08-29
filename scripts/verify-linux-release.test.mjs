import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import {
  assertLinuxPackageIdentity,
  linuxAssetPaths,
  rpmExtractionInvocation,
  verifyLinuxDesktopEntry,
  verifyLinuxBundleBinaries,
} from './verify-linux-release.mjs';

function binary(marker, suffix = '') {
  return Buffer.from(`header__TAURI_BUNDLE_TYPE_VAR_${marker}payload${suffix}`);
}

test('DEB 与 RPM 仅允许 bundle type 标记不同', () => {
  assert.doesNotThrow(() =>
    verifyLinuxBundleBinaries({
      deb: binary('DEB'),
      rpm: binary('RPM'),
      appImage: binary('APP', '-linuxdeploy-patchelf-strip'),
      buildIds: { deb: 'abc123', rpm: 'abc123', appImage: 'abc123' },
    }),
  );
});

test('AppImage 可有 linuxdeploy 合法变化，但必须保留 APP 身份标记', () => {
  assert.throws(
    () =>
      verifyLinuxBundleBinaries({
        deb: binary('DEB'),
        rpm: binary('RPM'),
        appImage: binary('RPM', '-wrong-identity'),
        buildIds: { deb: 'abc123', rpm: 'abc123', appImage: 'abc123' },
      }),
    /AppImage.*APP/,
  );
});

test('DEB 与 RPM 的主程序出现额外差异时拒绝', () => {
  assert.throws(
    () =>
      verifyLinuxBundleBinaries({
        deb: binary('DEB'),
        rpm: binary('RPM', '-tampered'),
        appImage: binary('APP'),
        buildIds: { deb: 'abc123', rpm: 'abc123', appImage: 'abc123' },
      }),
    /DEB.*RPM.*完全一致/,
  );
});

test('AppImage 即使保留 APP 标记，旧版本 build-id 仍被拒绝', () => {
  assert.throws(
    () =>
      verifyLinuxBundleBinaries({
        deb: binary('DEB'),
        rpm: binary('RPM'),
        appImage: binary('APP', '-old-version'),
        buildIds: { deb: 'current123', rpm: 'current123', appImage: 'old456' },
      }),
    /ELF build-id.*同一次构建/,
  );
});

test('RPM 由单进程 libarchive 直接解包且不恢复归档属主', () => {
  const invocation = rpmExtractionInvocation('/tmp/测试包.rpm', '/tmp/解包目录');

  assert.equal(invocation.command, 'bsdtar');
  assert.deepEqual(invocation.args, [
    '--extract',
    '--file',
    '/tmp/测试包.rpm',
    '--directory',
    '/tmp/解包目录',
    '--no-same-owner',
    '--no-same-permissions',
  ]);
});

test('相对资产目录在切换 AppImage 工作目录前解析为绝对路径', () => {
  const assets = linuxAssetPaths('package-assets/linux-x64', '1.0.0');

  for (const assetPath of Object.values(assets)) {
    assert.equal(path.isAbsolute(assetPath), true, assetPath);
  }
  assert.match(assets.appImage, /skill-expert-v1\.0\.0-linux-x64\.AppImage$/);
});

test('DEB 与 RPM 技术包名必须保持 skill-expert', () => {
  assert.doesNotThrow(() => assertLinuxPackageIdentity('DEB', 'skill-expert\n'));
  assert.throws(
    () => assertLinuxPackageIdentity('RPM', 'Agent 技能管家'),
    /RPM.*skill-expert.*Agent 技能管家/,
  );
});

test('三种 Linux 包的桌面入口必须保留中文显示名', () => {
  const valid = [
    '[Desktop Entry]',
    'Exec=skill-expert',
    'Icon=skill-expert',
    'Name=Agent 技能管家',
    'Type=Application',
  ].join('\n');

  assert.doesNotThrow(() => verifyLinuxDesktopEntry('AppImage', valid));
  assert.throws(
    () => verifyLinuxDesktopEntry('DEB', valid.replace('Agent 技能管家', 'skill-expert')),
    /DEB.*Agent 技能管家/,
  );
});
