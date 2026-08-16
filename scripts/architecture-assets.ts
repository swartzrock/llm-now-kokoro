import { mkdir, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export const MODEL_REVISION =
  "1939ad2a8e416c0acfeecc08a694d14ef25f2231";
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

export const ARCHITECTURE_ASSETS: readonly PinnedAsset[] = Object.freeze([
  {
    destination: resolve(ARCHITECTURE_ASSET_ROOT, "model/config.json"),
    sha256: "df34b4f930b23447cd4dc410fabfb42eb3f24e803e6c3f97d618fb359380a36f",
    bytes: 44,
    url: `${MODEL_BASE}/config.json`,
  },
  {
    destination: resolve(ARCHITECTURE_ASSET_ROOT, "model/tokenizer.json"),
    sha256: "77a02c8e164413299b4b4c403b14f8e0e1c1b727db4d46a09d6327b861060a34",
    bytes: 3_497,
    url: `${MODEL_BASE}/tokenizer.json`,
  },
  {
    destination: resolve(
      ARCHITECTURE_ASSET_ROOT,
      "model/tokenizer_config.json",
    ),
    sha256: "be1cb066d6ef6b074b3f15e6a6dd21ac88ff3cdaedf325f0aaed686c70f75d20",
    bytes: 113,
    url: `${MODEL_BASE}/tokenizer_config.json`,
  },
  {
    destination: resolve(
      ARCHITECTURE_ASSET_ROOT,
      "model/onnx/model_quantized.onnx",
    ),
    sha256: "fbae9257e1e05ffc727e951ef9b9c98418e6d79f1c9b6b13bd59f5c9028a1478",
    bytes: 92_361_116,
    url: `${MODEL_BASE}/onnx/model_quantized.onnx`,
  },
  {
    destination: resolve(
      ARCHITECTURE_ASSET_ROOT,
      "model/voices/af_heart.bin",
    ),
    sha256: "d583ccff3cdca2f7fae535cb998ac07e9fcb90f09737b9a41fa2734ec44a8f0b",
    bytes: 522_240,
    url: `${MODEL_BASE}/voices/af_heart.bin`,
  },
  {
    destination: MINIAUDIO_HEADER_PATH,
    sha256: "9019743287e443c55e5737a7297f38e5e358561701d6db2d905afb114390c410",
    bytes: 4_025_780,
    url: `${MINIAUDIO_BASE}/miniaudio.h`,
  },
]);

export async function prepareArchitectureAssets(): Promise<void> {
  for (const asset of ARCHITECTURE_ASSETS) {
    if (await isExpectedAsset(asset)) continue;

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
  }
}

export async function verifyArchitectureAssets(): Promise<void> {
  for (const asset of ARCHITECTURE_ASSETS) {
    if (!(await isExpectedAsset(asset))) {
      throw new Error(`Pinned architecture asset is missing or invalid: ${asset.destination}`);
    }
  }
}

async function isExpectedAsset(asset: PinnedAsset): Promise<boolean> {
  const file = Bun.file(asset.destination);
  if (!(await file.exists()) || file.size !== asset.bytes) return false;

  const bytes = await file.arrayBuffer();
  return Bun.CryptoHasher.hash("sha256", bytes, "hex") === asset.sha256;
}
