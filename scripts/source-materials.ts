import { copyFile, mkdir } from "node:fs/promises";
import { basename, resolve } from "node:path";

export const SOURCE_MATERIAL_FILENAMES = Object.freeze({
  archive: "llm-now-kokoro-source.tar.gz",
  offer: "llm-now-kokoro-source-offer.json",
} as const);

export async function generateSourceMaterials(input: {
  outputRoot: string;
  repositoryRoot: string;
  sourceCommit: string;
}): Promise<{ archivePath: string; offerPath: string }> {
  if (!/^[0-9a-f]{40}$/.test(input.sourceCommit)) {
    throw new Error("invalid-source-commit");
  }
  await mkdir(input.outputRoot, { recursive: true });
  const archivePath = resolve(input.outputRoot, SOURCE_MATERIAL_FILENAMES.archive);
  const archive = Bun.spawn([
    "git",
    "archive",
    "--format=tar.gz",
    `--output=${archivePath}`,
    input.sourceCommit,
  ], {
    cwd: input.repositoryRoot,
    stderr: "pipe",
    stdout: "ignore",
  });
  if (await archive.exited !== 0) {
    throw new Error("source-archive-generation-failed");
  }

  for (const name of ["LICENSE", "THIRD_PARTY_NOTICES.md", "bun.lock"] as const) {
    await copyFile(resolve(input.repositoryRoot, name), resolve(input.outputRoot, name));
  }
  const offerPath = resolve(input.outputRoot, SOURCE_MATERIAL_FILENAMES.offer);
  await Bun.write(offerPath, `${JSON.stringify({
    archive: basename(archivePath),
    formatVersion: 1,
    includedSupportableMaterials: [
      "repository source at the bound commit",
      "dependency patch files",
      "native player source",
      "build scripts and lockfile",
      "complete GPL terms and third-party notices",
    ],
    publicationEligible: false,
    sourceCommit: input.sourceCommit,
    unresolved: [
      "preferred eSpeak/phonemizer source and reproducible build provenance",
      "usable eSpeak/phonemizer relink path",
      "Bun/JavaScriptCore redistribution and relink obligations",
      "Windows app-local runtime redistribution evidence",
    ],
    writtenOffer: null,
  }, null, 2)}\n`);
  return { archivePath, offerPath };
}
