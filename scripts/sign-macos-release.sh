#!/bin/bash
set -euo pipefail

: "${APPLE_DEVELOPER_ID_P12_BASE64:?missing APPLE_DEVELOPER_ID_P12_BASE64}"
: "${APPLE_DEVELOPER_ID_P12_PASSWORD:?missing APPLE_DEVELOPER_ID_P12_PASSWORD}"
: "${APPLE_DEVELOPER_ID_IDENTITY:?missing APPLE_DEVELOPER_ID_IDENTITY}"
: "${APPLE_NOTARY_PRIVATE_KEY_BASE64:?missing APPLE_NOTARY_PRIVATE_KEY_BASE64}"
: "${APPLE_NOTARY_KEY_ID:?missing APPLE_NOTARY_KEY_ID}"
: "${APPLE_NOTARY_ISSUER_ID:?missing APPLE_NOTARY_ISSUER_ID}"
: "${APPLE_NOTARY_TEAM_ID:?missing APPLE_NOTARY_TEAM_ID}"

if [ "$#" -ne 4 ]; then
  echo "usage: sign-macos-release.sh <asset-root> <rc-tag> <source-commit> <bun-lock-sha256>" >&2
  exit 2
fi

asset_root="$1"
release_tag="$2"
source_commit="$3"
bun_lock_sha256="$4"
work_root="$(mktemp -d)"
keychain="$work_root/release-signing.keychain-db"
keychain_password="$(openssl rand -hex 32)"
cleanup() {
  security delete-keychain "$keychain" >/dev/null 2>&1 || true
  rm -rf "$work_root"
}
trap cleanup EXIT

printf '%s' "$APPLE_DEVELOPER_ID_P12_BASE64" | openssl base64 -d -A -out "$work_root/developer-id.p12"
printf '%s' "$APPLE_NOTARY_PRIVATE_KEY_BASE64" | openssl base64 -d -A -out "$work_root/notary.p8"
security create-keychain -p "$keychain_password" "$keychain"
security set-keychain-settings -lut 21600 "$keychain"
security unlock-keychain -p "$keychain_password" "$keychain"
security import "$work_root/developer-id.p12" -k "$keychain" -P "$APPLE_DEVELOPER_ID_P12_PASSWORD" -T /usr/bin/codesign
security set-key-partition-list -S apple-tool:,apple: -s -k "$keychain_password" "$keychain"

while IFS= read -r native_file; do
  codesign --force --options runtime --timestamp --sign "$APPLE_DEVELOPER_ID_IDENTITY" --keychain "$keychain" "$native_file"
  codesign --verify --strict --verbose=2 "$native_file"
done < <(find "$asset_root" -type f \( -name '*.node' -o -name '*.dylib' \) -print | sort)
while IFS= read -r executable; do
  codesign --force --options runtime --timestamp --sign "$APPLE_DEVELOPER_ID_IDENTITY" --keychain "$keychain" "$executable"
  codesign --verify --strict --verbose=2 "$executable"
done < <(find "$asset_root" -type f \( -name '*-player' -o -name '*-helper' \) -print | sort)

# Individual release files cannot be stapled. Submit a build-only container and
# preserve the accepted notarization result as evidence for this exact file set.
ditto -c -k --keepParent "$asset_root" "$work_root/notary-submission.zip"
xcrun notarytool submit "$work_root/notary-submission.zip" \
  --key "$work_root/notary.p8" \
  --key-id "$APPLE_NOTARY_KEY_ID" \
  --issuer "$APPLE_NOTARY_ISSUER_ID" \
  --wait

bun "$(dirname "$0")/write-signing-receipt.ts" macos "$asset_root" \
  "$asset_root/../signing-receipt.json" "$release_tag" "$source_commit" "$bun_lock_sha256"
