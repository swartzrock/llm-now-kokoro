import { chmod, copyFile, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type { SupportedRuntimeTarget } from "../src/backend";
import type {
  ReleaseAssetClass,
  ReleaseFileInput,
  ReleaseManifest,
} from "./release-manifest";
import {
  canonicalManifestJson,
  createReleaseManifest,
  isSafeRelativeReleasePath,
  validateReleaseManifest,
} from "./release-manifest";

export interface ReleaseSetResult {
  assetRoot: string;
  manifest: ReleaseManifest;
  manifestPath: string;
}

interface AssembleReleaseSetInput {
  assetClass: ReleaseAssetClass;
  files: readonly ReleaseFileInput[];
  outputRoot: string;
  sourceRoot: string;
  target: SupportedRuntimeTarget | null;
}

export async function assembleReleaseSet(
  input: AssembleReleaseSetInput,
): Promise<ReleaseSetResult> {
  const setName = input.target ?? "shared";
  const setRoot = resolve(input.outputRoot, setName);
  const assetRoot = resolve(setRoot, "assets");
  await rm(setRoot, { recursive: true, force: true });
  await mkdir(assetRoot, { recursive: true });

  for (const file of input.files) {
    const logicalSourcePath = file.sourcePath ?? file.logicalDestination;
    if (!isSafeRelativeReleasePath(logicalSourcePath)) {
      throw new Error("unsafe-release-source-path");
    }
    const sourcePath = resolve(
      input.sourceRoot,
      logicalSourcePath,
    );
    const destinationPath = resolve(assetRoot, file.releaseFilename);
    await copyFile(sourcePath, destinationPath);
    const executable =
      file.logicalDestination === "llm-now-kokoro" ||
      file.logicalDestination === "llm-now-kokoro.exe" ||
      file.logicalDestination.endsWith("llm-now-kokoro-player") ||
      file.logicalDestination.endsWith("llm-now-kokoro-player.exe");
    await chmod(destinationPath, executable ? 0o755 : 0o644);
  }

  const manifest = await createReleaseManifest({
    assetClass: input.assetClass,
    assetRoot,
    files: input.files.map((file) => ({
      logicalDestination: file.logicalDestination,
      releaseFilename: file.releaseFilename,
    })),
    target: input.target,
  });
  await validateReleaseManifest(manifest, assetRoot);
  const manifestPath = resolve(
    setRoot,
    `llm-now-kokoro-${manifest.helperVersion}-${setName}-manifest.json`,
  );
  await Bun.write(manifestPath, canonicalManifestJson(manifest));
  return { assetRoot, manifest, manifestPath };
}

export async function installReleaseSets(
  releaseSets: readonly ReleaseSetResult[],
  installRoot: string,
): Promise<void> {
  await mkdir(installRoot, { recursive: true });
  const destinations = new Set<string>();
  for (const releaseSet of releaseSets) {
    await validateReleaseManifest(releaseSet.manifest, releaseSet.assetRoot);
    for (const file of releaseSet.manifest.files) {
      if (!destinations.add(file.logicalDestination)) {
        throw new Error("duplicate-installed-destination");
      }
      const destinationPath = resolve(installRoot, file.logicalDestination);
      await mkdir(dirname(destinationPath), { recursive: true });
      await copyFile(
        resolve(releaseSet.assetRoot, file.releaseFilename),
        destinationPath,
      );
      await chmod(destinationPath, file.mode === "0755" ? 0o755 : 0o644);
    }
  }
}
