import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import { assembleReleaseSet } from "../scripts/release-sets";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

describe("shared model-cache release assembly", () => {
  test("copies only declared files and hashes the copied bytes", async () => {
    const sourceRoot = await mkdtemp(join(import.meta.dir, ".tmp-model-source-"));
    const outputRoot = await mkdtemp(join(import.meta.dir, ".tmp-model-release-"));
    temporaryDirectories.push(sourceRoot, outputRoot);
    await Bun.write(resolve(sourceRoot, "model/config.json"), "config");
    await Bun.write(resolve(sourceRoot, "model/voices/af_heart.bin"), "voice");
    await Bun.write(resolve(sourceRoot, "model/voices/af_bella.bin"), "extra");

    const result = await assembleReleaseSet({
      assetClass: "shared",
      files: [
        {
          logicalDestination: "model/config.json",
          releaseFilename: "llm-now-kokoro-0.1.0-shared-model-config.json",
        },
        {
          logicalDestination: "model/voices/af_heart.bin",
          releaseFilename: "llm-now-kokoro-0.1.0-shared-voice-af-heart.bin",
        },
      ],
      outputRoot,
      sourceRoot,
      target: null,
    });

    expect(result.manifest.files.map((file) => file.logicalDestination)).toEqual([
      "model/config.json",
      "model/voices/af_heart.bin",
    ]);
    expect(result.manifest.files.map((file) => file.bytes)).toEqual([6, 5]);
    expect(result.manifest.files.some((file) => file.releaseFilename.includes("bella"))).toBe(false);
    expect(await Bun.file(result.manifestPath).exists()).toBe(true);
  });

  test("rejects a source path that escapes the declared source root", async () => {
    const sourceRoot = await mkdtemp(join(import.meta.dir, ".tmp-model-source-"));
    const outputRoot = await mkdtemp(join(import.meta.dir, ".tmp-model-release-"));
    temporaryDirectories.push(sourceRoot, outputRoot);

    await expect(
      assembleReleaseSet({
        assetClass: "shared",
        files: [
          {
            logicalDestination: "model/config.json",
            releaseFilename: "llm-now-kokoro-0.1.0-shared-model-config.json",
            sourcePath: "../outside-source",
          },
        ],
        outputRoot,
        sourceRoot,
        target: null,
      }),
    ).rejects.toThrow("unsafe-release-source-path");
  });
});
