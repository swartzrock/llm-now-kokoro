import { resolve } from "node:path";

import {
  canonicalManifestJson,
  createReleaseManifest,
  readCanonicalReleaseManifest,
  validateReleaseManifest,
} from "./release-manifest";

export async function refreshSignedReleaseManifest(
  setRoot: string,
  sourceCommit: string,
): Promise<void> {
  if (!/^[0-9a-f]{40}$/.test(sourceCommit)) throw new Error("invalid-source-commit");
  const candidates = Array.from(
    new Bun.Glob("llm-now-kokoro-*-manifest.json").scanSync({ cwd: setRoot }),
  );
  if (candidates.length !== 1) throw new Error("release-set-manifest-count-invalid");
  const manifestPath = resolve(setRoot, candidates[0]!);
  const previous = await readCanonicalReleaseManifest(manifestPath);
  const assetRoot = resolve(setRoot, "assets");
  const refreshed = await createReleaseManifest({
    assetClass: previous.assetClass,
    assetRoot,
    files: previous.files.map((file) => ({
      logicalDestination: file.logicalDestination,
      releaseFilename: file.releaseFilename,
    })),
    sourceCommit,
    target: previous.target,
  });
  await validateReleaseManifest(refreshed, assetRoot);
  await Bun.write(manifestPath, canonicalManifestJson(refreshed));
}

if (import.meta.main) {
  const [setRoot, sourceCommit] = process.argv.slice(2);
  if (!setRoot || !sourceCommit) throw new Error("usage: refresh-signed-release-manifest <set-root> <source-commit>");
  await refreshSignedReleaseManifest(setRoot, sourceCommit);
}
