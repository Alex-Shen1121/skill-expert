const PRODUCT_VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([1-9]\d*))?$/;

const PRODUCT_VERSION_SEARCH_PATTERN =
  /(?:^|[^\d])((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[1-9]\d*)?)(?![\d-])/;

export function parseProductVersion(value) {
  const match = typeof value === 'string' ? value.match(PRODUCT_VERSION_PATTERN) : null;
  if (!match) return null;
  return {
    raw: value,
    stable: `${match[1]}.${match[2]}.${match[3]}`,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    development: match[4] ? Number(match[4]) : null,
  };
}

export function findProductVersion(value) {
  if (typeof value !== 'string') return null;
  return value.match(PRODUCT_VERSION_SEARCH_PATTERN)?.[1] ?? null;
}

export function nextDevelopmentVersion(version) {
  return `${version.stable}-${(version.development ?? 0) + 1}`;
}

export function nextPatchVersion(version) {
  return `${version.major}.${version.minor}.${version.patch + 1}`;
}
