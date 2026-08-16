import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve } from "node:path";

import {
  SUPPORTED_RUNTIME_TARGETS,
  type SupportedRuntimeTarget,
} from "../src/backend";
import { MODEL_REVISION, PHONEMIZER_INVENTORY } from "../src/model-assets";
import {
  HELPER_VERSION,
  PROTOCOL_CAPABILITIES,
  PROTOCOL_MAJOR,
} from "../src/protocol";
import { MINIAUDIO_REVISION } from "./architecture-assets";

export const DOWNLOAD_BUDGET_BYTES = 250 * 1024 * 1024;
export const INSTALLED_BUDGET_BYTES = 300 * 1024 * 1024;
export const RELEASE_MANIFEST_VERSION = 1;

export type ReleaseAssetClass = "runtime" | "shared";

export interface ReleaseFileInput {
  logicalDestination: string;
  releaseFilename: string;
  sourcePath?: string;
}

export interface ReleaseManifestFile {
  bytes: number;
  logicalDestination: string;
  mode: "0644" | "0755";
  provenance: ReleaseFileProvenance;
  releaseFilename: string;
  sha256: string;
}

export interface ReleaseFileProvenance {
  component: string;
  license: string;
  obligations: string[];
  sourceRevision: string;
}

export interface ReleaseManifest {
  assetClass: ReleaseAssetClass;
  dependencies: {
    bun: "1.3.14";
    kokoroJs: "1.2.1";
    onnxruntimeNode: "1.21.0";
    transformersJs: "3.5.1";
  };
  embeddedComponents: readonly [
    {
      bundle: {
        bytes: number;
        sha256: string;
        sourcePath: string;
      };
      embeddedPayload: {
        compressedBytes: number;
        compressedSha256: string;
        decompressedBytes: number;
        decompressedSha256: string;
      };
      embeddedWithin: "llm-now-kokoro-helper";
      license: string;
      name: "espeak-ng-phonemizer";
      releaseGate: string;
      runtimeFormat: string;
      upstreamCommit: string;
    },
  ];
  files: ReleaseManifestFile[];
  formatVersion: typeof RELEASE_MANIFEST_VERSION;
  helperVersion: typeof HELPER_VERSION;
  modelRevision: typeof MODEL_REVISION;
  protocol: {
    capabilities: readonly string[];
    major: typeof PROTOCOL_MAJOR;
  };
  sourceRevisions: {
    miniaudio: typeof MINIAUDIO_REVISION;
    phonemizer: typeof PHONEMIZER_INVENTORY.upstreamCommit;
  };
  target: SupportedRuntimeTarget | null;
}

interface CreateManifestInput {
  assetClass: ReleaseAssetClass;
  assetRoot: string;
  files: readonly ReleaseFileInput[];
  sourceCommit?: string;
  target: SupportedRuntimeTarget | null;
}

const DEPENDENCIES = Object.freeze({
  bun: "1.3.14",
  kokoroJs: "1.2.1",
  onnxruntimeNode: "1.21.0",
  transformersJs: "3.5.1",
} as const);

const EMBEDDED_COMPONENTS: ReleaseManifest["embeddedComponents"] = Object.freeze([
  Object.freeze({
    bundle: Object.freeze({
      bytes: PHONEMIZER_INVENTORY.bundle.bytes,
      sha256: PHONEMIZER_INVENTORY.bundle.sha256,
      sourcePath: PHONEMIZER_INVENTORY.bundle.relativePath,
    }),
    embeddedPayload: Object.freeze({
      compressedBytes: PHONEMIZER_INVENTORY.embeddedGzip.bytes,
      compressedSha256: PHONEMIZER_INVENTORY.embeddedGzip.sha256,
      decompressedBytes: PHONEMIZER_INVENTORY.decompressedData.bytes,
      decompressedSha256: PHONEMIZER_INVENTORY.decompressedData.sha256,
    }),
    embeddedWithin: "llm-now-kokoro-helper",
    license: PHONEMIZER_INVENTORY.licenseAudit.embeddedEngineLicense,
    name: "espeak-ng-phonemizer",
    releaseGate: PHONEMIZER_INVENTORY.releaseStatus,
    runtimeFormat: PHONEMIZER_INVENTORY.runtimeFormat,
    upstreamCommit: PHONEMIZER_INVENTORY.upstreamCommit,
  }),
]);

export async function createReleaseManifest(
  input: CreateManifestInput,
): Promise<ReleaseManifest> {
  assertClassAndTarget(input.assetClass, input.target);
  const seenDestinations = new Set<string>();
  const seenFilenames = new Set<string>();
  const files: ReleaseManifestFile[] = [];

  for (const file of input.files) {
    assertSafeLogicalPath(file.logicalDestination);
    assertSafeReleaseFilename(file.releaseFilename);
    const sourcePath = file.sourcePath ?? file.releaseFilename;
    assertSafeLogicalPath(sourcePath);
    if (!seenDestinations.add(file.logicalDestination)) {
      throw new Error("duplicate-logical-destination");
    }
    if (!seenFilenames.add(file.releaseFilename)) {
      throw new Error("duplicate-release-filename");
    }
    const inspected = await inspectRegularFile(resolve(input.assetRoot, sourcePath));
    const provenance = releaseFileProvenance(file.logicalDestination);
    if (provenance.sourceRevision === "source-commit-bound-by-root-manifest" && input.sourceCommit) {
      if (!/^[0-9a-f]{40}$/.test(input.sourceCommit)) throw new Error("invalid-source-commit");
      provenance.sourceRevision = input.sourceCommit;
    }
    const expectedMode = expectedReleaseFileMode(file.logicalDestination);
    if (process.platform !== "win32" && inspected.mode !== expectedMode) {
      throw new Error("release-file-mode-mismatch");
    }
    files.push({
      bytes: inspected.bytes,
      logicalDestination: file.logicalDestination,
      mode: expectedMode,
      provenance,
      releaseFilename: file.releaseFilename,
      sha256: inspected.sha256,
    });
  }

  files.sort((left, right) =>
    left.logicalDestination.localeCompare(right.logicalDestination, "en"),
  );
  return {
    assetClass: input.assetClass,
    dependencies: { ...DEPENDENCIES },
    embeddedComponents: structuredClone(EMBEDDED_COMPONENTS),
    files,
    formatVersion: RELEASE_MANIFEST_VERSION,
    helperVersion: HELPER_VERSION,
    modelRevision: MODEL_REVISION,
    protocol: {
      capabilities: [...PROTOCOL_CAPABILITIES],
      major: PROTOCOL_MAJOR,
    },
    sourceRevisions: {
      miniaudio: MINIAUDIO_REVISION,
      phonemizer: PHONEMIZER_INVENTORY.upstreamCommit,
    },
    target: input.target,
  };
}

export async function validateReleaseManifest(
  manifest: ReleaseManifest,
  assetRoot: string,
): Promise<void> {
  assertClassAndTarget(manifest.assetClass, manifest.target);
  assertManifestMetadata(manifest);
  const actualFiles = await listRelativeFiles(assetRoot);
  const expectedFiles = manifest.files
    .map((file) => file.releaseFilename)
    .sort((left, right) => left.localeCompare(right, "en"));
  if (actualFiles.join("\n") !== expectedFiles.join("\n")) {
    throw new Error("release-file-inventory-mismatch");
  }

  let previousDestination = "";
  const seenDestinations = new Set<string>();
  const seenFilenames = new Set<string>();
  for (const file of manifest.files) {
    assertSafeLogicalPath(file.logicalDestination);
    assertSafeReleaseFilename(file.releaseFilename);
    if (!seenDestinations.add(file.logicalDestination)) {
      throw new Error("duplicate-logical-destination");
    }
    if (!seenFilenames.add(file.releaseFilename)) {
      throw new Error("duplicate-release-filename");
    }
    if (!matchesReleaseFileProvenance(file.logicalDestination, file.provenance)) {
      throw new Error("release-file-provenance-mismatch");
    }
    if (
      previousDestination &&
      previousDestination.localeCompare(file.logicalDestination, "en") >= 0
    ) {
      throw new Error("release-manifest-not-canonical");
    }
    previousDestination = file.logicalDestination;

    const inspected = await inspectRegularFile(
      resolve(assetRoot, file.releaseFilename),
    );
    if (inspected.bytes !== file.bytes || inspected.sha256 !== file.sha256) {
      throw new Error("release-file-digest-mismatch");
    }
    const expectedMode = expectedReleaseFileMode(file.logicalDestination);
    if (
      file.mode !== expectedMode ||
      (process.platform !== "win32" && inspected.mode !== expectedMode)
    ) {
      throw new Error("release-file-mode-mismatch");
    }
  }
}

export function releaseFileProvenance(
  logicalDestination: string,
): ReleaseFileProvenance {
  if (logicalDestination === "llm-now-kokoro") {
    return {
      component: "llm-now-kokoro",
      license: "GPL-3.0-or-later",
      obligations: ["complete-license", "corresponding-source", "relink-materials"],
      sourceRevision: "source-commit-bound-by-root-manifest",
    };
  }
  if (logicalDestination === "llm-now-kokoro.exe") {
    return {
      component: "llm-now-kokoro-and-windows-runtime",
      license: "GPL-3.0-or-later AND LicenseRef-Microsoft-Visual-CPP-Runtime",
      obligations: ["complete-license", "corresponding-source", "windows-redistribution-evidence"],
      sourceRevision: "source-commit-bound-by-root-manifest",
    };
  }
  if (logicalDestination.includes("llm-now-kokoro-player")) {
    return {
      component: "miniaudio-player",
      license: "MIT-0 OR Unlicense",
      obligations: ["license-text", "source"],
      sourceRevision: MINIAUDIO_REVISION,
    };
  }
  if (logicalDestination.startsWith("runtime/onnx/")) {
    return {
      component: "onnxruntime-node",
      license: "MIT",
      obligations: ["license-text", "source-offer-link"],
      sourceRevision: "v1.21.0",
    };
  }
  if (logicalDestination.startsWith("model/")) {
    return {
      component: "Kokoro-82M-v1.0-ONNX",
      license: "Apache-2.0",
      obligations: ["license-text", "model-card", "training-data-attribution"],
      sourceRevision: MODEL_REVISION,
    };
  }
  if (logicalDestination.startsWith("protocol/")) {
    return {
      component: "llm-now-kokoro-protocol",
      license: "GPL-3.0-or-later",
      obligations: ["complete-license", "corresponding-source"],
      sourceRevision: "source-commit-bound-by-root-manifest",
    };
  }
  if (logicalDestination === "LICENSE") {
    return {
      component: "GNU-GPL-3.0-or-later-terms",
      license: "GPL-3.0-or-later",
      obligations: ["complete-license"],
      sourceRevision: "GPL-3.0",
    };
  }
  if (logicalDestination === "THIRD_PARTY_NOTICES.md") {
    return {
      component: "third-party-notices",
      license: "LicenseRef-Notice-Collection",
      obligations: ["attribution", "redistribution-obligations"],
      sourceRevision: "source-commit-bound-by-root-manifest",
    };
  }
  throw new Error("release-file-provenance-unmapped");
}

function matchesReleaseFileProvenance(
  logicalDestination: string,
  actual: ReleaseFileProvenance,
): boolean {
  const expected = releaseFileProvenance(logicalDestination);
  if (expected.sourceRevision === "source-commit-bound-by-root-manifest") {
    if (!/^[0-9a-f]{40}$/.test(actual.sourceRevision) &&
        actual.sourceRevision !== expected.sourceRevision) {
      return false;
    }
    expected.sourceRevision = actual.sourceRevision;
  }
  return JSON.stringify(actual) === JSON.stringify(expected);
}

export function canonicalManifestJson(manifest: ReleaseManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export async function readCanonicalReleaseManifest(
  path: string,
): Promise<ReleaseManifest> {
  const source = await Bun.file(path).text();
  const manifest = JSON.parse(source) as ReleaseManifest;
  if (source !== canonicalManifestJson(manifest)) {
    throw new Error("release-manifest-not-canonical");
  }
  return manifest;
}

export function manifestBytes(manifest: ReleaseManifest): number {
  return manifest.files.reduce((total, file) => total + file.bytes, 0);
}

export function assertFirstTargetSizeBudget(input: {
  installedBytes?: number;
  runtimeBytes: number;
  sharedBytes: number;
}): void {
  const downloadBytes = input.runtimeBytes + input.sharedBytes;
  if (downloadBytes > DOWNLOAD_BUDGET_BYTES) {
    throw new Error("release-download-budget-exceeded");
  }
  const installedBytes = input.installedBytes ?? downloadBytes;
  if (installedBytes > INSTALLED_BUDGET_BYTES) {
    throw new Error("release-installed-budget-exceeded");
  }
}

function assertClassAndTarget(
  assetClass: ReleaseAssetClass,
  target: SupportedRuntimeTarget | null,
): void {
  if (assetClass !== "runtime" && assetClass !== "shared") {
    throw new Error("release-class-invalid");
  }
  if (target !== null && !SUPPORTED_RUNTIME_TARGETS.includes(target)) {
    throw new Error("release-target-invalid");
  }
  if (
    (assetClass === "runtime" && target === null) ||
    (assetClass === "shared" && target !== null)
  ) {
    throw new Error("release-class-target-mismatch");
  }
}

function assertManifestMetadata(manifest: ReleaseManifest): void {
  if (
    manifest.formatVersion !== RELEASE_MANIFEST_VERSION ||
    manifest.helperVersion !== HELPER_VERSION ||
    manifest.modelRevision !== MODEL_REVISION ||
    manifest.protocol.major !== PROTOCOL_MAJOR ||
    manifest.protocol.capabilities.join("\n") !==
      PROTOCOL_CAPABILITIES.join("\n") ||
    JSON.stringify(manifest.dependencies) !== JSON.stringify(DEPENDENCIES) ||
    JSON.stringify(manifest.embeddedComponents) !==
      JSON.stringify(EMBEDDED_COMPONENTS) ||
    manifest.sourceRevisions.miniaudio !== MINIAUDIO_REVISION ||
    manifest.sourceRevisions.phonemizer !== PHONEMIZER_INVENTORY.upstreamCommit
  ) {
    throw new Error("release-manifest-metadata-mismatch");
  }
}

export function isSafeRelativeReleasePath(path: string): boolean {
  return path.length > 0 &&
    !isAbsolute(path) &&
    !path.includes("\\") &&
    path.split("/").every(
      (component) => component !== "" && component !== "." && component !== "..",
    );
}

export function expectedReleaseFileMode(
  logicalDestination: string,
): "0644" | "0755" {
  return logicalDestination === "llm-now-kokoro" ||
      logicalDestination === "llm-now-kokoro.exe" ||
      logicalDestination.endsWith("llm-now-kokoro-player") ||
      logicalDestination.endsWith("llm-now-kokoro-player.exe")
    ? "0755"
    : "0644";
}

function assertSafeLogicalPath(path: string): void {
  if (!isSafeRelativeReleasePath(path)) {
    throw new Error("unsafe-release-path");
  }
}

function assertSafeReleaseFilename(filename: string): void {
  if (
    basename(filename) !== filename ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(filename)
  ) {
    throw new Error("unsafe-release-filename");
  }
}

export async function inspectRegularFile(path: string): Promise<{
  bytes: number;
  mode: "0644" | "0755";
  sha256: string;
}> {
  const metadata = await lstat(path);
  if (!metadata.isFile()) throw new Error("release-file-not-regular");
  const executable = (metadata.mode & 0o111) !== 0;
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return {
    bytes: metadata.size,
    mode: executable ? "0755" : "0644",
    sha256: hash.digest("hex"),
  };
}

async function listRelativeFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
      } else if (entry.isFile()) {
        files.push(relative(root, path).replaceAll("\\", "/"));
      } else {
        throw new Error("release-file-not-regular");
      }
    }
  }
  await walk(root);
  return files.sort((left, right) => left.localeCompare(right, "en"));
}
