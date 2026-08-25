import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertCliVersionOutput,
  assertPackageVersion,
  normalizeTauriBundleBinary,
} from './release-binary-version.mjs';

test('CLI 和安装包版本必须精确等于正式版本', () => {
  assert.doesNotThrow(() => assertCliVersionOutput('skill-expert-cli 1.2.3\n', '1.2.3'));
  assert.doesNotThrow(() => assertPackageVersion('DEB', '1.2.3\n', '1.2.3'));
  assert.throws(
    () => assertCliVersionOutput('skill-expert-cli 1.2.2\n', '1.2.3'),
    /CLI 版本不匹配/,
  );
  assert.throws(() => assertPackageVersion('RPM', '1.2.3-1', '1.2.3'), /RPM 版本不匹配/);
});

test('Tauri bundle type 归一化只替换唯一的已知标记', () => {
  for (const type of ['DEB', 'RPM', 'APP']) {
    const binary = Buffer.from(`前缀__TAURI_BUNDLE_TYPE_VAR_${type}后缀`);
    const normalized = normalizeTauriBundleBinary(binary, type);
    assert.match(normalized.toString(), /__TAURI_BUNDLE_TYPE_VAR_UNK/);
  }

  assert.throws(
    () => normalizeTauriBundleBinary(Buffer.from('没有标记'), '缺失标记'),
    /唯一.*标记/,
  );
});
