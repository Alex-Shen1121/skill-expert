import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RPM_EXTRACTION_SCRIPT,
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

test('RPM 在非 root runner 解包时不尝试恢复归档属主', () => {
  assert.match(RPM_EXTRACTION_SCRIPT, /--no-preserve-owner/);
  assert.match(RPM_EXTRACTION_SCRIPT, /--no-absolute-filenames/);
});
