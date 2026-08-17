import { mkdir, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { MODEL_ASSETS, MODEL_REVISION } from "../src/model-assets";
export const MINIAUDIO_REVISION =
  "350784a9467a79d0fa65802132668e5afbcf3777";

export const ARCHITECTURE_CACHE_ROOT = resolve(
  import.meta.dir,
  "../.tmp-architecture-smoke",
);
export const ARCHITECTURE_ASSET_ROOT = resolve(
  ARCHITECTURE_CACHE_ROOT,
  "assets",
);
export const MINIAUDIO_HEADER_PATH = resolve(
  ARCHITECTURE_CACHE_ROOT,
  "vendor/miniaudio.h",
);

interface PinnedAsset {
  destination: string;
  sha256: string;
  bytes: number;
  url: string;
}

const MODEL_BASE = `https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/${MODEL_REVISION}`;
const MINIAUDIO_BASE = `https://raw.githubusercontent.com/mackron/miniaudio/${MINIAUDIO_REVISION}`;

const MODEL_DOWNLOADS: PinnedAsset[] = MODEL_ASSETS.map((asset) => ({
  destination: resolve(ARCHITECTURE_ASSET_ROOT, asset.relativePath),
  sha256: asset.sha256,
  bytes: asset.bytes,
  url: `${MODEL_BASE}/${asset.relativePath.slice("model/".length)}`,
}));

const ASSET_BATCH_SIZE = 4;

export const ARCHITECTURE_ASSETS: readonly PinnedAsset[] = Object.freeze([
  ...MODEL_DOWNLOADS,
  {
    destination: MINIAUDIO_HEADER_PATH,
    sha256: "9019743287e443c55e5737a7297f38e5e358561701d6db2d905afb114390c410",
    bytes: 4_025_780,
    url: `${MINIAUDIO_BASE}/miniaudio.h`,
  },
]);

export async function prepareArchitectureAssets(): Promise<void> {
  await forEachAssetBatch(async (asset) => {
    if (await isExpectedAsset(asset)) return;

    await mkdir(dirname(asset.destination), { recursive: true });
    const partial = `${asset.destination}.part`;
    await rm(partial, { force: true });

    try {
      const child = Bun.spawn([
        process.platform === "win32" ? "curl.exe" : "curl",
        "--connect-timeout",
        "15",
        "--fail",
        "--location",
        "--max-time",
        "300",
        "--output",
        partial,
        "--retry",
        "3",
        "--show-error",
        "--silent",
        asset.url,
      ]);
      const exitCode = await child.exited;
      if (exitCode !== 0) {
        throw new Error(`Architecture asset download failed (${exitCode})`);
      }
      if (!(await isExpectedAsset({ ...asset, destination: partial }))) {
        throw new Error("Architecture asset digest or size mismatch");
      }
      await rename(partial, asset.destination);
    } catch (error) {
      await rm(partial, { force: true });
      throw error;
    }
  });
}

export async function verifyArchitectureAssets(): Promise<void> {
  await forEachAssetBatch(async (asset) => {
    if (!(await isExpectedAsset(asset))) {
      throw new Error(
        `Pinned architecture asset is missing or invalid: ${asset.destination}`,
      );
    }
  });
}

async function forEachAssetBatch(
  operation: (asset: PinnedAsset) => Promise<void>,
): Promise<void> {
  for (let index = 0; index < ARCHITECTURE_ASSETS.length; index += ASSET_BATCH_SIZE) {
    const results = await Promise.allSettled(
      ARCHITECTURE_ASSETS.slice(index, index + ASSET_BATCH_SIZE).map(operation),
    );
    const failure = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failure) throw failure.reason;
  }
}

async function isExpectedAsset(asset: PinnedAsset): Promise<boolean> {
  const file = Bun.file(asset.destination);
  if (file.size !== asset.bytes) return false;
  try {
    const bytes = await file.arrayBuffer();
    return Bun.CryptoHasher.hash("sha256", bytes, "hex") === asset.sha256;
  } catch {
    return false;
  }
}
