import { describe, expect, test } from "bun:test";

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

describe("local model assets", () => {
  test("pins the exact minimal revision, q8 model, and af_heart tree", async () => {
    const files = validFiles();
    const packRoot = "/packs/Kokoro ü";

    await verifyLocalModelAssets(packRoot, {
      listFiles: async () =>
        MODEL_ASSETS.map((asset) => asset.relativePath.slice("model/".length)),
      inspectFile: async (path) => {
        const relativePath = path.slice(`${packRoot}/`.length);
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
      const failure = verifyLocalModelAssets("/pack", {
        listFiles: async () =>
          MODEL_ASSETS.map((entry) => entry.relativePath.slice("model/".length)),
        inspectFile: async (path) => files.get(path.slice("/pack/".length))!,
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
      verifyLocalModelAssets("/pack", {
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
  test("binds the installed bundle and embedded data while recording no raw Wasm", async () => {
    await verifyPinnedPhonemizerBundle("/repository", async (path) => {
      expect(path).toBe(
        "/repository/node_modules/phonemizer/dist/phonemizer.js",
      );
      return {
        bytes: PHONEMIZER_INVENTORY.bundle.bytes,
        isRegularFile: true,
        sha256: PHONEMIZER_INVENTORY.bundle.sha256,
      };
    });

    expect(PHONEMIZER_INVENTORY.rawWasmIdentified).toBe(false);
    expect(PHONEMIZER_INVENTORY.embeddedGzip.sha256).toBe(
      "4b4454422468c6195d70a3f50eaed157293d6a7af3e509a0612c2abcdb7defa5",
    );
    expect(PHONEMIZER_INVENTORY.decompressedData.sha256).toBe(
      "6262621f3f8267fb61ef41fe7af75b8fe7e2315d6c9092afd29d7629bb21a60b",
    );
    expect(PHONEMIZER_INVENTORY.releaseStatus).toStartWith("blocked-");
  });

  test("rejects a missing or corrupt installed phonemizer bundle", async () => {
    await expect(
      verifyPinnedPhonemizerBundle("/repository", async () => {
        throw new Error("missing path should remain private");
      }),
    ).rejects.toThrow("phonemizer-bundle-invalid");
  });
});
