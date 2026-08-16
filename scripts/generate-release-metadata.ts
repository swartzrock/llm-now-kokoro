import { copyFile, mkdir, rm } from "node:fs/promises";
import { basename, resolve } from "node:path";

import { SUPPORTED_RUNTIME_TARGETS } from "../src/backend";
import { HELPER_VERSION } from "../src/protocol";
import {
  createComplianceReport,
  RELEASE_COMPLIANCE_BLOCKERS,
  type AdditionalComplianceFile,
} from "./release-compliance";
import type { ReleaseManifest } from "./release-manifest";
import {
  inspectRegularFile,
  readCanonicalReleaseManifest,
} from "./release-manifest";
import {
  canonicalRootManifestJson,
  createRootReleaseManifest,
  renderChecksums,
  renderReleaseCatalog,
  type SupplementalReleaseFile,
} from "./secure-release";
import { generateSourceMaterials } from "./source-materials";

const REPOSITORY = "swartzrock/llm-now-kokoro";

export async function generateReleaseMetadata(input: {
  releaseRoot: string;
  releaseTag: string;
  repositoryRoot: string;
  sourceCommit: string;
}): Promise<{ blockers: string[]; outputRoot: string }> {
  const outputRoot = resolve(input.releaseRoot, "publish");
  await rm(outputRoot, { recursive: true, force: true });
  await mkdir(outputRoot, { recursive: true });

  const setNames = [...SUPPORTED_RUNTIME_TARGETS, "shared"] as const;
  const releaseSets: Array<{ assetRoot: string; manifest: ReleaseManifest }> = [];
  const supplementalFiles: SupplementalReleaseFile[] = [];
  for (const setName of setNames) {
    const setRoot = resolve(input.releaseRoot, setName);
    const manifestPath = resolve(
      setRoot,
      `llm-now-kokoro-${HELPER_VERSION}-${setName}-manifest.json`,
    );
    const manifest = await readCanonicalReleaseManifest(manifestPath);
    if ((manifest.target ?? "shared") !== setName) {
      throw new Error("root-manifest-target-mismatch");
    }
    if (manifest.files.some((file) =>
      file.provenance.sourceRevision === "source-commit-bound-by-root-manifest"
    )) {
      throw new Error(`published-manifest-source-placeholder:${setName}`);
    }
    const assetRoot = resolve(setRoot, "assets");
    releaseSets.push({ assetRoot, manifest });
    for (const file of manifest.files) {
      await copyFile(resolve(assetRoot, file.releaseFilename), resolve(outputRoot, file.releaseFilename));
    }
    await copyFile(manifestPath, resolve(outputRoot, basename(manifestPath)));
    supplementalFiles.push(metadataFile(
      manifestPath,
      basename(manifestPath),
      `evidence/manifests/${basename(manifestPath)}`,
      input.sourceCommit,
    ));
    if (manifest.target) {
      const reportPath = resolve(setRoot, "unsigned-build-report.json");
      const reportName = `llm-now-kokoro-${HELPER_VERSION}-${setName}-validation-report.json`;
      await copyFile(reportPath, resolve(outputRoot, reportName));
      supplementalFiles.push(metadataFile(
        reportPath,
        reportName,
        `evidence/validation/${reportName}`,
        input.sourceCommit,
      ));
      const receiptPath = resolve(setRoot, "signing-receipt.json");
      const receiptName = `llm-now-kokoro-${HELPER_VERSION}-${setName}-signing-receipt.json`;
      try {
        await copyFile(receiptPath, resolve(outputRoot, receiptName));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          throw new Error(`signing-receipt-missing:${setName}`);
        }
        throw error;
      }
      supplementalFiles.push(metadataFile(
        receiptPath,
        receiptName,
        `evidence/signing/${receiptName}`,
        input.sourceCommit,
      ));
    }
  }

  const source = await generateSourceMaterials({
    outputRoot,
    repositoryRoot: input.repositoryRoot,
    sourceCommit: input.sourceCommit,
  });
  supplementalFiles.push(
    sourceFile(source.archivePath, "source/repository.tar.gz", input.sourceCommit),
    sourceFile(source.offerPath, "source/source-offer.json", input.sourceCommit),
  );
  for (const name of ["LICENSE", "THIRD_PARTY_NOTICES.md", "bun.lock"]) {
    supplementalFiles.push(sourceFile(
      resolve(outputRoot, name),
      `source/${name}`,
      input.sourceCommit,
    ));
  }

  const complianceAdditional: AdditionalComplianceFile[] = [
    ...supplementalFiles.map((file) => ({
      assetClass: "release-metadata" as const,
      license: file.provenance.license,
      logicalDestination: file.logicalDestination,
      obligations: [...file.provenance.obligations],
      releaseFilename: file.releaseFilename,
      sourceRevision: file.provenance.sourceRevision,
      target: null,
    })),
    ...[
      `llm-now-kokoro-${HELPER_VERSION}-compliance-report.json`,
      `llm-now-kokoro-${HELPER_VERSION}-root-manifest.json`,
      `llm-now-kokoro-${HELPER_VERSION}-rc-catalog.json`,
      "SHA256SUMS",
    ].map((releaseFilename) => ({
      assetClass: "release-metadata" as const,
      license: "GPL-3.0-or-later",
      logicalDestination: `evidence/generated/${releaseFilename}`,
      obligations: ["integrity", "provenance", "redistribution-obligations"],
      releaseFilename,
      sourceRevision: input.sourceCommit,
      target: null,
    })),
  ];
  const compliance = createComplianceReport(
    releaseSets.map((set) => set.manifest),
    RELEASE_COMPLIANCE_BLOCKERS,
    complianceAdditional,
  );
  const complianceName = `llm-now-kokoro-${HELPER_VERSION}-compliance-report.json`;
  const compliancePath = resolve(outputRoot, complianceName);
  await Bun.write(compliancePath, `${JSON.stringify(compliance, null, 2)}\n`);
  supplementalFiles.push(metadataFile(
    compliancePath,
    complianceName,
    `evidence/compliance/${complianceName}`,
    input.sourceCommit,
  ));

  const rootManifest = await createRootReleaseManifest({
    bunLockPath: resolve(input.repositoryRoot, "bun.lock"),
    releaseSets,
    releaseTag: input.releaseTag,
    repository: REPOSITORY,
    sourceCommit: input.sourceCommit,
    supplementalFiles,
  });
  const rootName = `llm-now-kokoro-${HELPER_VERSION}-root-manifest.json`;
  const catalogName = `llm-now-kokoro-${HELPER_VERSION}-rc-catalog.json`;
  await Bun.write(resolve(outputRoot, rootName), canonicalRootManifestJson(rootManifest));
  await Bun.write(resolve(outputRoot, catalogName), renderReleaseCatalog(rootManifest));
  const checksums = [
    renderChecksums(rootManifest).trimEnd(),
    await checksumLine(resolve(outputRoot, rootName), rootName),
    await checksumLine(resolve(outputRoot, catalogName), catalogName),
  ].join("\n");
  await Bun.write(resolve(outputRoot, "SHA256SUMS"), `${checksums}\n`);
  return { blockers: [...RELEASE_COMPLIANCE_BLOCKERS], outputRoot };
}

function metadataFile(
  sourcePath: string,
  releaseFilename: string,
  logicalDestination: string,
  sourceCommit: string,
): SupplementalReleaseFile {
  return {
    logicalDestination,
    provenance: {
      component: "release-evidence",
      license: "GPL-3.0-or-later",
      obligations: ["integrity", "provenance"],
      sourceRevision: sourceCommit,
    },
    releaseFilename,
    sourcePath,
  };
}

function sourceFile(
  sourcePath: string,
  logicalDestination: string,
  sourceCommit: string,
): SupplementalReleaseFile {
  return {
    logicalDestination,
    provenance: {
      component: "corresponding-source-material",
      license: "GPL-3.0-or-later",
      obligations: ["corresponding-source", "relink-materials"],
      sourceRevision: sourceCommit,
    },
    releaseFilename: basename(sourcePath),
    sourcePath,
  };
}

async function checksumLine(path: string, filename: string): Promise<string> {
  return `${(await inspectRegularFile(path)).sha256}  ${filename}`;
}

if (import.meta.main) {
  const [releaseTag, sourceCommit] = process.argv.slice(2);
  if (!releaseTag || !sourceCommit) {
    throw new Error("usage: generate-release-metadata <rc-tag> <source-commit>");
  }
  console.log(JSON.stringify(await generateReleaseMetadata({
    releaseRoot: resolve(import.meta.dir, "../dist/release"),
    releaseTag,
    repositoryRoot: resolve(import.meta.dir, ".."),
    sourceCommit,
  })));
}
