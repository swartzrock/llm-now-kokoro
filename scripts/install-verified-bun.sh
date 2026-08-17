#!/usr/bin/env bash
set -euo pipefail

url="${1:?usage: install-verified-bun.sh <url> <sha256>}"
expected_sha256="${2:?usage: install-verified-bun.sh <url> <sha256>}"
if [[ ! "$expected_sha256" =~ ^[0-9a-f]{64}$ ]]; then
  echo "invalid Bun SHA-256" >&2
  exit 1
fi

download_root="$(mktemp -d "${RUNNER_TEMP:-/tmp}/verified-bun.XXXXXX")"
trap 'rm -rf "$download_root"' EXIT
archive="$download_root/bun.zip"
unpacked="$download_root/unpacked"
curl --fail --location --proto '=https' --tlsv1.2 --output "$archive" "$url"
if command -v sha256sum >/dev/null 2>&1; then
  actual_sha256="$(sha256sum "$archive" | awk '{print $1}')"
else
  actual_sha256="$(shasum -a 256 "$archive" | awk '{print $1}')"
fi
if [[ "$actual_sha256" != "$expected_sha256" ]]; then
  echo "Bun archive checksum mismatch" >&2
  exit 1
fi

mkdir -p "$unpacked"
unzip -q "$archive" -d "$unpacked"
bun_path="$(find "$unpacked" -type f -name bun -print -quit)"
if [[ -z "$bun_path" ]]; then
  echo "verified Bun archive did not contain bun" >&2
  exit 1
fi
install_root="${RUNNER_TEMP:?RUNNER_TEMP is required}/verified-bun"
mkdir -p "$install_root"
cp "$bun_path" "$install_root/bun"
chmod 0755 "$install_root/bun"
echo "$install_root" >> "${GITHUB_PATH:?GITHUB_PATH is required}"
