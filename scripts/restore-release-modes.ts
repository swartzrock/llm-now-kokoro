import { chmod } from "node:fs/promises";
import { basename, resolve } from "node:path";

import type { ReleaseManifest } from "./release-manifest";
import { readCanonicalReleaseManifest } from "./release-manifest";

export async function restoreReleaseModes(setRoots: readonly string[]): Promise<void> {
  for (const setRoot of setRoots) {
    const candidates = Array.from(
      new Bun.Glob("llm-now-kokoro-*-manifest.json").scanSync({ cwd: setRoot }),
    );
    if (candidates.length !== 1) throw new Error("release-set-manifest-count-invalid");
    const manifest = await readCanonicalReleaseManifest(resolve(setRoot, candidates[0]!));
    for (const file of manifest.files) await restoreFileMode(setRoot, file);
  }
}

async function restoreFileMode(
  setRoot: string,
  file: ReleaseManifest["files"][number],
): Promise<void> {
  if (basename(file.releaseFilename) !== file.releaseFilename ||
      (file.mode !== "0644" && file.mode !== "0755")) {
    throw new Error("release-mode-entry-invalid");
  }
  await chmod(
    resolve(setRoot, "assets", file.releaseFilename),
    file.mode === "0755" ? 0o755 : 0o644,
  );
}

if (import.meta.main) {
  const setRoots = process.argv.slice(2);
  if (setRoots.length === 0) throw new Error("usage: restore-release-modes <set-root> [...]");
  await restoreReleaseModes(setRoots);
}
