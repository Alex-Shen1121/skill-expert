import { spawnSync } from 'node:child_process';

const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const BUNDLE_MARKERS = ['DEB', 'RPM', 'APP'].map((type) =>
  Buffer.from(`__TAURI_BUNDLE_TYPE_VAR_${type}`),
);
const NEUTRAL_MARKER = Buffer.from('__TAURI_BUNDLE_TYPE_VAR_UNK');

export function requireStableVersion(version) {
  if (!STABLE_VERSION.test(version ?? '')) {
    throw new Error(`版本必须是稳定的 x.y.z，实际为 ${version ?? '缺失'}`);
  }
}

export function assertCliVersionOutput(output, version) {
  requireStableVersion(version);
  const actual = String(output).trim();
  const expected = `skill-expert-cli ${version}`;
  if (actual !== expected) {
    throw new Error(`CLI 版本不匹配：预期 ${expected}，实际 ${actual || '空输出'}`);
  }
}

export function verifyCliVersion(cliPath, version) {
  const result = spawnSync(cliPath, ['--version'], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`CLI --version 执行失败：${result.stderr.trim() || `退出码 ${result.status}`}`);
  }
  assertCliVersionOutput(result.stdout, version);
}

export function assertPackageVersion(label, output, version) {
  requireStableVersion(version);
  const actual = String(output).trim();
  if (actual !== version) {
    throw new Error(`${label} 版本不匹配：预期 ${version}，实际 ${actual || '空输出'}`);
  }
}

export function normalizeTauriBundleBinary(binary, label) {
  const normalized = Buffer.from(binary);
  const matches = [];
  for (const marker of BUNDLE_MARKERS) {
    let offset = normalized.indexOf(marker);
    while (offset !== -1) {
      matches.push({ marker, offset });
      offset = normalized.indexOf(marker, offset + marker.length);
    }
  }
  if (matches.length !== 1) {
    throw new Error(`${label} 必须包含唯一的 Tauri bundle type 标记，实际为 ${matches.length} 个`);
  }
  NEUTRAL_MARKER.copy(normalized, matches[0].offset);
  return normalized;
}
