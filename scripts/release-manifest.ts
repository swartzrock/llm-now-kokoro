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
  releaseFilename: string;
  sha256: string;
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
    files.push({
      bytes: inspected.bytes,
      logicalDestination: file.logicalDestination,
      mode: inspected.mode,
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
    if (inspected.mode !== file.mode) {
      throw new Error("release-file-mode-mismatch");
    }
  }
}

export function canonicalManifestJson(manifest: ReleaseManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
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

function assertSafeLogicalPath(path: string): void {
  if (
    path.length === 0 ||
    isAbsolute(path) ||
    path.includes("\\") ||
    path.split("/").some((component) => component === "" || component === "." || component === "..")
  ) {
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

async function inspectRegularFile(path: string): Promise<{
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
