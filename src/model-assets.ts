import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

export const MODEL_REVISION =
  "1939ad2a8e416c0acfeecc08a694d14ef25f2231";

export interface PinnedAsset {
  id: string;
  relativePath: string;
  bytes: number;
  sha256: string;
}

export const MODEL_ASSETS: readonly PinnedAsset[] = Object.freeze([
  {
    id: "model-config",
    relativePath: "model/config.json",
    bytes: 44,
    sha256: "df34b4f930b23447cd4dc410fabfb42eb3f24e803e6c3f97d618fb359380a36f",
  },
  {
    id: "tokenizer",
    relativePath: "model/tokenizer.json",
    bytes: 3_497,
    sha256: "77a02c8e164413299b4b4c403b14f8e0e1c1b727db4d46a09d6327b861060a34",
  },
  {
    id: "tokenizer-config",
    relativePath: "model/tokenizer_config.json",
    bytes: 113,
    sha256: "be1cb066d6ef6b074b3f15e6a6dd21ac88ff3cdaedf325f0aaed686c70f75d20",
  },
  {
    id: "q8-model",
    relativePath: "model/onnx/model_quantized.onnx",
    bytes: 92_361_116,
    sha256: "fbae9257e1e05ffc727e951ef9b9c98418e6d79f1c9b6b13bd59f5c9028a1478",
  },
  {
    id: "af-heart",
    relativePath: "model/voices/af_heart.bin",
    bytes: 522_240,
    sha256: "d583ccff3cdca2f7fae535cb998ac07e9fcb90f09737b9a41fa2734ec44a8f0b",
  },
]);

export const PHONEMIZER_INVENTORY = Object.freeze({
  packageVersion: "1.2.1",
  bundle: {
    relativePath: "node_modules/phonemizer/dist/phonemizer.js",
    bytes: 1_322_380,
    sha256: "193481f474f7c1ea81df3195d18b45df8ef7254dbdccb3f193d60215c4897bec",
  },
  embeddedGzip: {
    bytes: 452_273,
    sha256: "4b4454422468c6195d70a3f50eaed157293d6a7af3e509a0612c2abcdb7defa5",
  },
  decompressedData: {
    bytes: 890_802,
    sha256: "6262621f3f8267fb61ef41fe7af75b8fe7e2315d6c9092afd29d7629bb21a60b",
  },
  rawWasmIdentified: false,
  releaseStatus: "blocked-pending-source-relink-and-license-audit",
});

interface InspectedFile {
  bytes: number;
  isRegularFile: boolean;
  sha256: string;
}

export interface AssetVerificationDependencies {
  inspectFile?: (path: string) => Promise<InspectedFile>;
  listFiles?: (root: string) => Promise<string[]>;
}

export async function verifyLocalModelAssets(
  packRoot = process.cwd(),
  dependencies: AssetVerificationDependencies = {},
): Promise<void> {
  if (!isAbsolute(packRoot)) throw new Error("pack-root-not-absolute");
  const inspectFile = dependencies.inspectFile ?? inspectPinnedFile;
  const listFiles = dependencies.listFiles ?? listRelativeFiles;
  const modelRoot = resolve(packRoot, "model");
  const expectedPaths = MODEL_ASSETS.map((asset) =>
    asset.relativePath.slice("model/".length),
  ).sort();

  let actualPaths: string[];
  try {
    actualPaths = (await listFiles(modelRoot)).sort();
  } catch {
    throw new Error("model-asset-layout-invalid");
  }
  if (actualPaths.join("\n") !== expectedPaths.join("\n")) {
    throw new Error("model-asset-layout-invalid");
  }

  for (const asset of MODEL_ASSETS) {
    let inspected: InspectedFile;
    try {
      inspected = await inspectFile(resolve(packRoot, asset.relativePath));
    } catch {
      throw new Error(`model-asset-invalid:${asset.id}`);
    }
    if (
      !inspected.isRegularFile ||
      inspected.bytes !== asset.bytes ||
      inspected.sha256 !== asset.sha256
    ) {
      throw new Error(`model-asset-invalid:${asset.id}`);
    }
  }
}

export async function verifyPinnedPhonemizerBundle(
  repositoryRoot = resolve(import.meta.dir, ".."),
  inspectFile: (path: string) => Promise<InspectedFile> = inspectPinnedFile,
): Promise<void> {
  const expected = PHONEMIZER_INVENTORY.bundle;
  let actual: InspectedFile;
  try {
    actual = await inspectFile(resolve(repositoryRoot, expected.relativePath));
  } catch {
    throw new Error("phonemizer-bundle-invalid");
  }
  if (
    !actual.isRegularFile ||
    actual.bytes !== expected.bytes ||
    actual.sha256 !== expected.sha256
  ) {
    throw new Error("phonemizer-bundle-invalid");
  }
}

async function inspectPinnedFile(path: string): Promise<InspectedFile> {
  const metadata = await lstat(path);
  if (!metadata.isFile()) {
    return { bytes: metadata.size, isRegularFile: false, sha256: "" };
  }
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return {
    bytes: metadata.size,
    isRegularFile: true,
    sha256: hash.digest("hex"),
  };
}

async function listRelativeFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
      } else if (entry.isFile()) {
        files.push(relative(root, path).replaceAll("\\", "/"));
      } else {
        throw new Error("unsupported-model-asset-entry");
      }
    }
  }
  await walk(root);
  return files;
}
