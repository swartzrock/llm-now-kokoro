import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat } from "node:fs/promises";
import { resolve } from "node:path";

import { HELPER_VERSION } from "../src/protocol";
import type { ReleaseManifest, ReleaseManifestFile } from "./release-manifest";
import {
  inspectRegularFile,
  releaseFileProvenance,
  validateReleaseManifest,
} from "./release-manifest";

export interface RootReleaseFile extends ReleaseManifestFile {
  assetClass: ReleaseManifest["assetClass"] | "release-metadata";
  dependencies: ReleaseManifest["dependencies"];
  modelRevision: ReleaseManifest["modelRevision"];
  protocol: ReleaseManifest["protocol"];
  sourceRevisions: ReleaseManifest["sourceRevisions"];
  target: ReleaseManifest["target"];
}

export interface RootReleaseManifest {
  files: RootReleaseFile[];
  formatVersion: 1;
  generatedFiles: Array<{
    digestRecordedIn: "SHA256SUMS" | "not-applicable-self";
    license: string;
    obligations: string[];
    releaseFilename: string;
    sourceRevision: string;
  }>;
  provenance: {
    bunLockSha256: string;
    bunVersion: "1.3.14";
    sourceCommit: string;
  };
  releaseTag: string;
  repository: string;
}

interface CreateRootReleaseManifestInput {
  bunLockPath: string;
  releaseSets: ReadonlyArray<{
    assetRoot: string;
    manifest: ReleaseManifest;
  }>;
  releaseTag: string;
  repository: string;
  sourceCommit: string;
  supplementalFiles?: readonly SupplementalReleaseFile[];
}

export interface SupplementalReleaseFile {
  logicalDestination: string;
  provenance: ReleaseManifestFile["provenance"];
  releaseFilename: string;
  sourcePath: string;
}

export interface SignatureEvidenceFile {
  attestationVerified?: boolean;
  authenticodeVerified?: boolean;
  codeSignatureVerified?: boolean;
  notarizationVerified?: boolean;
  releaseFilename: string;
  sha256: string;
  timestampVerified?: boolean;
}

export interface SigningEvidence {
  bunLockSha256: string;
  files: SignatureEvidenceFile[];
  sourceCommit: string;
}

export async function createRootReleaseManifest(
  input: CreateRootReleaseManifestInput,
): Promise<RootReleaseManifest> {
  assertReleaseCandidateTag(input.releaseTag);
  if (!/^[0-9a-f]{40}$/.test(input.sourceCommit)) {
    throw new Error("invalid-source-commit");
  }
  const files: RootReleaseFile[] = [];
  for (const releaseSet of input.releaseSets) {
    await validateReleaseManifest(releaseSet.manifest, releaseSet.assetRoot);
    for (const file of releaseSet.manifest.files) {
      const provenance = structuredClone(file.provenance);
      if (releaseFileProvenance(file.logicalDestination).sourceRevision ===
          "source-commit-bound-by-root-manifest") {
        if (provenance.sourceRevision === "source-commit-bound-by-root-manifest") {
          provenance.sourceRevision = input.sourceCommit;
        } else if (provenance.sourceRevision !== input.sourceCommit) {
          throw new Error(`release-file-source-commit-mismatch:${file.releaseFilename}`);
        }
      }
      files.push({
        ...structuredClone(file),
        assetClass: releaseSet.manifest.assetClass,
        dependencies: { ...releaseSet.manifest.dependencies },
        modelRevision: releaseSet.manifest.modelRevision,
        protocol: structuredClone(releaseSet.manifest.protocol),
        provenance,
        sourceRevisions: { ...releaseSet.manifest.sourceRevisions },
        target: releaseSet.manifest.target,
      });
    }
  }
  const reference = input.releaseSets[0]?.manifest;
  if (!reference) throw new Error("root-release-set-missing");
  for (const supplemental of input.supplementalFiles ?? []) {
    const inspected = await inspectRegularFile(supplemental.sourcePath);
    files.push({
      ...inspected,
      assetClass: "release-metadata",
      dependencies: { ...reference.dependencies },
      logicalDestination: supplemental.logicalDestination,
      modelRevision: reference.modelRevision,
      protocol: structuredClone(reference.protocol),
      provenance: structuredClone(supplemental.provenance),
      releaseFilename: supplemental.releaseFilename,
      sourceRevisions: { ...reference.sourceRevisions },
      target: null,
    });
  }
  files.sort((left, right) =>
    left.releaseFilename.localeCompare(right.releaseFilename, "en"),
  );
  const names = new Set(files.map((file) => file.releaseFilename));
  if (names.size !== files.length) throw new Error("duplicate-root-release-filename");
  return {
    files,
    formatVersion: 1,
    generatedFiles: [
      `llm-now-kokoro-${HELPER_VERSION}-root-manifest.json`,
      `llm-now-kokoro-${HELPER_VERSION}-rc-catalog.json`,
      "SHA256SUMS",
    ].map((releaseFilename) => ({
      digestRecordedIn:
        releaseFilename === "SHA256SUMS" ? "not-applicable-self" as const : "SHA256SUMS" as const,
      license: "GPL-3.0-or-later",
      obligations: ["integrity", "provenance", "redistribution-obligations"],
      releaseFilename,
      sourceRevision: input.sourceCommit,
    })),
    provenance: {
      bunLockSha256: await sha256File(input.bunLockPath),
      bunVersion: "1.3.14",
      sourceCommit: input.sourceCommit,
    },
    releaseTag: input.releaseTag,
    repository: input.repository,
  };
}

export function canonicalRootManifestJson(manifest: RootReleaseManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export function renderChecksums(manifest: RootReleaseManifest): string {
  return `${manifest.files
    .map((file) => `${file.sha256}  ${file.releaseFilename}`)
    .join("\n")}\n`;
}

export function renderReleaseCatalog(manifest: RootReleaseManifest): string {
  const base = `https://github.com/${manifest.repository}/releases/download/${manifest.releaseTag}`;
  return `${JSON.stringify({
    files: manifest.files.map((file) => ({
      ...file,
      url: `${base}/${file.releaseFilename}`,
    })),
    formatVersion: 1,
    generatedFiles: manifest.generatedFiles,
    packVersion: manifest.releaseTag,
    provenance: manifest.provenance,
  }, null, 2)}\n`;
}

export function assertReleaseCandidateTag(tag: string): void {
  if (!/^v0\.1\.0-rc\.[1-9][0-9]*$/.test(tag)) {
    throw new Error("invalid-rc-tag");
  }
}

export function assertProtectedReleaseWorkflow(source: string): void {
  if (/\bpull_request(?:_target)?\s*:/.test(source)) {
    throw new Error("protected-workflow-pr-trigger");
  }
  if (!source.includes("workflow_dispatch:") || !source.includes("environment: release-signing")) {
    throw new Error("protected-environment-missing");
  }
  for (const match of source.matchAll(/\buses:\s*([^\s#]+)/g)) {
    if (!/@[0-9a-f]{40}$/.test(match[1] ?? "")) {
      throw new Error("workflow-action-not-pinned");
    }
  }
  for (const permission of ["contents: write", "id-token: write", "attestations: write"]) {
    if (!source.includes(permission)) throw new Error("publish-permission-missing");
  }
  if (/packages:\s*write|actions:\s*write|pull-requests:\s*write/.test(source)) {
    throw new Error("publish-permission-excessive");
  }
  if (source.includes("--clobber") || source.includes("gh release upload")) {
    throw new Error("mutable-release-command");
  }
  if (!source.includes("gh release view") || !source.includes("gh release create")) {
    throw new Error("immutable-release-guard-missing");
  }
}

export function assertSigningAndProvenance(
  manifest: RootReleaseManifest,
  evidence: SigningEvidence,
): void {
  if (evidence.sourceCommit !== manifest.provenance.sourceCommit) {
    throw new Error("provenance-source-mismatch");
  }
  if (evidence.bunLockSha256 !== manifest.provenance.bunLockSha256) {
    throw new Error("provenance-lockfile-mismatch");
  }
  const byName = new Map(evidence.files.map((file) => [file.releaseFilename, file]));
  const nativeFiles = manifest.files.filter((file) => file.target !== null);
  for (const file of nativeFiles) {
    const signature = byName.get(file.releaseFilename);
    if (!signature) throw new Error(`signature-evidence-missing:${file.releaseFilename}`);
    if (signature.sha256 !== file.sha256) {
      throw new Error(`signature-evidence-digest-mismatch:${file.releaseFilename}`);
    }
    if (file.target?.startsWith("darwin-") &&
      (!signature.codeSignatureVerified || !signature.notarizationVerified)) {
      throw new Error(`macos-trust-evidence-missing:${file.releaseFilename}`);
    }
    if (file.target === "win32-x64" &&
      (!signature.authenticodeVerified || !signature.timestampVerified)) {
      throw new Error(`windows-trust-evidence-missing:${file.releaseFilename}`);
    }
    if (file.target?.startsWith("linux-") && !signature.attestationVerified) {
      throw new Error(`linux-attestation-evidence-missing:${file.releaseFilename}`);
    }
  }
  if (byName.size !== nativeFiles.length) {
    throw new Error("signature-evidence-inventory-mismatch");
  }
}

async function sha256File(path: string): Promise<string> {
  const metadata = await lstat(path);
  if (!metadata.isFile()) throw new Error("provenance-input-not-regular");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(resolve(path))) hash.update(chunk);
  return hash.digest("hex");
}
