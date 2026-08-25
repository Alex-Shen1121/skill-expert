#!/usr/bin/env bash

set -euo pipefail

OUTPUT_DIRECTORY="${1:-release-assets}"
: "${GH_TOKEN:?必须提供 GH_TOKEN}"
: "${REPO:?必须提供 REPO}"
: "${RUNNER_TEMP:?必须提供 RUNNER_TEMP}"
: "${TAG:?必须提供 TAG}"

mkdir "$OUTPUT_DIRECTORY"
RELEASES_FILE="$RUNNER_TEMP/releases.json"
ASSETS_FILE="$RUNNER_TEMP/assets.tsv"

gh api "repos/${REPO}/releases?per_page=100" > "$RELEASES_FILE"
DRAFT_COUNT="$(jq --arg tag "$TAG" \
  '[.[] | select(.tag_name == $tag and .draft == true)] | length' \
  "$RELEASES_FILE")"
DRAFT_COUNT="${DRAFT_COUNT%$'\r'}"
if [ "$DRAFT_COUNT" != "1" ]; then
  echo "必须存在唯一且仍不可见的 Draft Release：$TAG" >&2
  exit 1
fi

jq -r --arg tag "$TAG" \
  '.[] | select(.tag_name == $tag and .draft == true) | .assets[] | [.id, .name] | @tsv' \
  "$RELEASES_FILE" > "$ASSETS_FILE"
while IFS=$'\t' read -r ASSET_ID ASSET_NAME; do
  [ -n "$ASSET_ID" ] || continue
  ASSET_NAME="${ASSET_NAME%$'\r'}"
  if [[ ! "$ASSET_ID" =~ ^[0-9]+$ || ! "$ASSET_NAME" =~ ^[A-Za-z0-9][A-Za-z0-9._+-]*$ || "$ASSET_NAME" == "." || "$ASSET_NAME" == ".." ]]; then
    echo "Draft 包含不安全资产名：$ASSET_NAME" >&2
    exit 1
  fi
  gh api -H "Accept: application/octet-stream" \
    "repos/${REPO}/releases/assets/$ASSET_ID" > "$OUTPUT_DIRECTORY/$ASSET_NAME"
done < "$ASSETS_FILE"
