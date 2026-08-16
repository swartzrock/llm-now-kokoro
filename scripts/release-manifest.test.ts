import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  DOWNLOAD_BUDGET_BYTES,
  INSTALLED_BUDGET_BYTES,
  assertFirstTargetSizeBudget,
  createReleaseManifest,
  validateReleaseManifest,
} from "./release-manifest";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(import.meta.dir, ".tmp-release-manifest-"));
  temporaryDirectories.push(path);
  return path;
}

describe("release manifest", () => {
  test("is mechanically generated from sorted produced files", async () => {
    const root = await temporaryDirectory();
    const playerFilename = "llm-now-kokoro-0.1.0-linux-x64-player";
    const helperFilename = "llm-now-kokoro-0.1.0-linux-x64-helper";
    await Bun.write(resolve(root, playerFilename), "player");
    await Bun.write(resolve(root, helperFilename), "helper");
    await chmod(resolve(root, playerFilename), 0o755);
    await chmod(resolve(root, helperFilename), 0o755);

    const manifest = await createReleaseManifest({
      assetClass: "runtime",
      assetRoot: root,
      files: [
        {
          logicalDestination: "runtime/llm-now-kokoro-player",
          releaseFilename: playerFilename,
        },
        {
          logicalDestination: "llm-now-kokoro",
          releaseFilename: helperFilename,
        },
      ],
      target: "linux-x64",
    });

    expect(manifest.files.map((file) => file.logicalDestination)).toEqual([
      "llm-now-kokoro",
      "runtime/llm-now-kokoro-player",
    ]);
    expect(manifest.files[0]).toMatchObject({
      bytes: 6,
      mode: "0755",
      sha256:
        "e81d3b0e9d82feaaf5f6e55bdff24731d7eee08632ffa63801e6397290c5d20a",
    });
    expect(manifest.dependencies).toEqual({
      bun: "1.3.14",
      kokoroJs: "1.2.1",
      onnxruntimeNode: "1.21.0",
      transformersJs: "3.5.1",
    });
    expect(manifest.modelRevision).toBe(
      "1939ad2a8e416c0acfeecc08a694d14ef25f2231",
    );
    expect(manifest.embeddedComponents).toEqual([
      expect.objectContaining({
        embeddedWithin: "llm-now-kokoro-helper",
        name: "espeak-ng-phonemizer",
        runtimeFormat: "emscripten-javascript-with-embedded-gzip-data",
        bundle: expect.objectContaining({
          bytes: 1_322_380,
          sha256:
            "193481f474f7c1ea81df3195d18b45df8ef7254dbdccb3f193d60215c4897bec",
        }),
        embeddedPayload: expect.objectContaining({
          compressedBytes: 452_273,
          compressedSha256:
            "4b4454422468c6195d70a3f50eaed157293d6a7af3e509a0612c2abcdb7defa5",
        }),
      }),
    ]);
    expect(manifest.protocol.capabilities).toContain("native-onnx-cpu");
    await expect(validateReleaseManifest(manifest, root)).resolves.toBeUndefined();
  });

  test("rejects tampering, links, absolute paths, traversal, and undeclared files", async () => {
    const root = await temporaryDirectory();
    const filename = "llm-now-kokoro-0.1.0-shared-model-config.json";
    await Bun.write(resolve(root, filename), "expected");
    const manifest = await createReleaseManifest({
      assetClass: "shared",
      assetRoot: root,
      files: [
        {
          logicalDestination: "model/config.json",
          releaseFilename: filename,
        },
      ],
      target: null,
    });

    await Bun.write(resolve(root, filename), "tampered");
    await expect(validateReleaseManifest(manifest, root)).rejects.toThrow(
      "release-file-digest-mismatch",
    );
    await Bun.write(resolve(root, "extra"), "undeclared");
    await expect(validateReleaseManifest(manifest, root)).rejects.toThrow(
      "release-file-inventory-mismatch",
    );

    for (const logicalDestination of ["/absolute", "../escape", "a/../../b"]) {
      await expect(
        createReleaseManifest({
          assetClass: "shared",
          assetRoot: root,
          files: [
            {
              logicalDestination,
              releaseFilename: "safe-name",
              sourcePath: filename,
            },
          ],
          target: null,
        }),
      ).rejects.toThrow("unsafe-release-path");
    }
  });

  test("enforces the first-target download and installed size ceilings", () => {
    expect(() =>
      assertFirstTargetSizeBudget({
        runtimeBytes: 1,
        sharedBytes: DOWNLOAD_BUDGET_BYTES - 1,
      }),
    ).not.toThrow();
    expect(() =>
      assertFirstTargetSizeBudget({
        runtimeBytes: DOWNLOAD_BUDGET_BYTES,
        sharedBytes: 1,
      }),
    ).toThrow("release-download-budget-exceeded");
    expect(() =>
      assertFirstTargetSizeBudget({
        installedBytes: INSTALLED_BUDGET_BYTES + 1,
        runtimeBytes: 1,
        sharedBytes: 1,
      }),
    ).toThrow("release-installed-budget-exceeded");
  });
});
