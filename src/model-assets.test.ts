import { describe, expect, test } from "bun:test";
import { relative, resolve } from "node:path";

import {
  MODEL_ASSETS,
  MODEL_REVISION,
  PHONEMIZER_INVENTORY,
  verifyLocalModelAssets,
  verifyPinnedPhonemizerBundle,
} from "./model-assets";

function validFiles() {
  return new Map(
    MODEL_ASSETS.map((asset) => [
      asset.relativePath,
      {
        bytes: asset.bytes,
        isRegularFile: true,
        sha256: asset.sha256,
      },
    ]),
  );
}

function relativeAssetPath(packRoot: string, path: string): string {
  return relative(packRoot, path).replaceAll("\\", "/");
}

describe("local model assets", () => {
  test("pins the exact minimal revision, q8 model, and af_heart tree", async () => {
    const files = validFiles();
    const packRoot = resolve("/packs/Kokoro ü");

    await verifyLocalModelAssets(packRoot, {
      listFiles: async () =>
        MODEL_ASSETS.map((asset) => asset.relativePath.slice("model/".length)),
      inspectFile: async (path) => {
        const relativePath = relativeAssetPath(packRoot, path);
        const file = files.get(relativePath);
        if (!file) throw new Error("missing");
        return file;
      },
    });

    expect(MODEL_REVISION).toBe(
      "1939ad2a8e416c0acfeecc08a694d14ef25f2231",
    );
    expect(MODEL_ASSETS.map((asset) => asset.relativePath)).toEqual([
      "model/config.json",
      "model/tokenizer.json",
      "model/tokenizer_config.json",
      "model/onnx/model_quantized.onnx",
      "model/voices/af_heart.bin",
    ]);
  });

  test.each([...MODEL_ASSETS])(
    "rejects a missing or corrupt $id without disclosing paths or hashes",
    async (asset) => {
      const files = validFiles();
      files.set(asset.relativePath, {
        ...files.get(asset.relativePath)!,
        sha256: "corrupt",
      });
      const packRoot = resolve("/pack");
      const failure = verifyLocalModelAssets(packRoot, {
        listFiles: async () =>
          MODEL_ASSETS.map((entry) => entry.relativePath.slice("model/".length)),
        inspectFile: async (path) => files.get(relativeAssetPath(packRoot, path))!,
      });

      await expect(failure).rejects.toThrow(`model-asset-invalid:${asset.id}`);
      await failure.catch((error) => {
        expect((error as Error).message).not.toContain(asset.relativePath);
        expect((error as Error).message).not.toContain(asset.sha256);
      });
    },
  );

  test("rejects extra voices and unrelated model files", async () => {
    await expect(
      verifyLocalModelAssets(resolve("/pack"), {
        listFiles: async () => [
          ...MODEL_ASSETS.map((asset) =>
            asset.relativePath.slice("model/".length),
          ),
          "voices/af_bella.bin",
        ],
        inspectFile: async () => {
          throw new Error("must not inspect an invalid tree");
        },
      }),
    ).rejects.toThrow("model-asset-layout-invalid");
  });
});

describe("phonemizer inventory", () => {
  test("binds and audits the installed Emscripten payload", async () => {
    const repositoryRoot = resolve("/repository");
    await verifyPinnedPhonemizerBundle(
      repositoryRoot,
      async (path) => {
        expect(path).toBe(
          resolve(repositoryRoot, "node_modules/phonemizer/dist/phonemizer.js"),
        );
        return {
          bytes: PHONEMIZER_INVENTORY.bundle.bytes,
          isRegularFile: true,
          sha256: PHONEMIZER_INVENTORY.bundle.sha256,
        };
      },
      async () => ({
        compressedBytes: PHONEMIZER_INVENTORY.embeddedGzip.bytes,
        compressedSha256: PHONEMIZER_INVENTORY.embeddedGzip.sha256,
        decompressedBytes: PHONEMIZER_INVENTORY.decompressedData.bytes,
        decompressedSha256: PHONEMIZER_INVENTORY.decompressedData.sha256,
        ...PHONEMIZER_INVENTORY.wasmAudit,
      }),
    );

    expect(PHONEMIZER_INVENTORY.runtimeFormat).toBe(
      "emscripten-javascript-with-embedded-gzip-data",
    );
    expect(PHONEMIZER_INVENTORY.wasmAudit).toEqual({
      wasmBinaryIdentifierPresent: true,
      webAssemblyApiPresent: false,
      wasmMagicPresent: false,
    });
    expect(PHONEMIZER_INVENTORY.embeddedGzip.sha256).toBe(
      "4b4454422468c6195d70a3f50eaed157293d6a7af3e509a0612c2abcdb7defa5",
    );
    expect(PHONEMIZER_INVENTORY.decompressedData.sha256).toBe(
      "6262621f3f8267fb61ef41fe7af75b8fe7e2315d6c9092afd29d7629bb21a60b",
    );
    expect(PHONEMIZER_INVENTORY.releaseStatus).toStartWith("blocked-");
    expect(PHONEMIZER_INVENTORY.licenseAudit.embeddedEngineLicense).toBe(
      "GPL-3.0-or-later",
    );
  });

  test("rejects a missing or corrupt installed phonemizer bundle", async () => {
    await expect(
      verifyPinnedPhonemizerBundle("/repository", async () => {
        throw new Error("missing path should remain private");
      }),
    ).rejects.toThrow("phonemizer-bundle-invalid");
  });

  test("rejects a changed embedded phonemizer payload", async () => {
    await expect(
      verifyPinnedPhonemizerBundle(
        "/repository",
        async () => ({
          bytes: PHONEMIZER_INVENTORY.bundle.bytes,
          isRegularFile: true,
          sha256: PHONEMIZER_INVENTORY.bundle.sha256,
        }),
        async () => ({
          compressedBytes: PHONEMIZER_INVENTORY.embeddedGzip.bytes,
          compressedSha256: "changed",
          decompressedBytes: PHONEMIZER_INVENTORY.decompressedData.bytes,
          decompressedSha256: PHONEMIZER_INVENTORY.decompressedData.sha256,
          ...PHONEMIZER_INVENTORY.wasmAudit,
        }),
      ),
    ).rejects.toThrow("phonemizer-payload-invalid");
  });
});
