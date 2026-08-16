import { isAbsolute } from "node:path";

import type { SupportedRuntimeTarget } from "../src/backend";
import { SUPPORTED_RUNTIME_TARGETS } from "../src/backend";
import { MODEL_ASSETS } from "../src/model-assets";
import type { ReleaseManifest } from "./release-manifest";
import { SHARED_RELEASE_FILES, runtimeReleaseFiles } from "./release-inventory";

export interface OnnxInspection {
  externalData: string[];
  operators: string[];
  opsets: Array<{ domain: string; version: number }>;
}

export interface TargetCompatibilityEvidence {
  audioBackends: string[];
  baselineCpuVerified: boolean;
  blockedNetworkingVerified: boolean;
  bunVersion: string;
  floorVerified: boolean;
  nativeDependencies: {
    declared: string[];
    undeclared: string[];
    unresolved: string[];
  };
  ordinaryLoaderPathVerified: boolean;
  promptFailureVerified: boolean;
  runnerCpu: string;
  runnerOs: string;
  target: SupportedRuntimeTarget;
  windowsAppLocalRuntimeApproved?: boolean;
}

interface ProtobufField {
  field: number;
  value: bigint | Uint8Array;
  wire: number;
}

export function inspectOnnxModel(
  bytes: Uint8Array,
  declaredExternalData: readonly string[],
): OnnxInspection {
  try {
    const model = readFields(bytes);
    const opsets = model
      .filter((field) => field.field === 8 && field.value instanceof Uint8Array)
      .map((field) => {
        const fields = readFields(field.value as Uint8Array);
        const domain = readString(fields, 1) || "ai.onnx";
        const version = Number(readInteger(fields, 2));
        if (!Number.isSafeInteger(version) || version <= 0) {
          throw new Error("invalid-onnx-opset");
        }
        return { domain, version };
      });
    const operators = new Set<string>();
    const externalData: string[] = [];

    for (const graphField of model.filter(
      (field) => field.field === 7 && field.value instanceof Uint8Array,
    )) {
      const graph = readFields(graphField.value as Uint8Array);
      for (const nodeField of graph.filter(
        (field) => field.field === 1 && field.value instanceof Uint8Array,
      )) {
        const node = readFields(nodeField.value as Uint8Array);
        const operator = readString(node, 4);
        if (!operator) throw new Error("invalid-onnx-node");
        operators.add(`${readString(node, 7) || "ai.onnx"}:${operator}`);
      }
      for (const tensorField of graph.filter(
        (field) => field.field === 5 && field.value instanceof Uint8Array,
      )) {
        const tensor = readFields(tensorField.value as Uint8Array);
        if (Number(readInteger(tensor, 14, 0n)) !== 1) continue;
        for (const dataField of tensor.filter(
          (field) => field.field === 13 && field.value instanceof Uint8Array,
        )) {
          const entry = readFields(dataField.value as Uint8Array);
          if (readString(entry, 1) !== "location") continue;
          const location = readString(entry, 2);
          assertSafeExternalReference(location);
          if (!declaredExternalData.includes(location)) {
            throw new Error("undeclared-onnx-external-reference");
          }
          externalData.push(location);
        }
      }
    }

    return {
      externalData: [...new Set(externalData)].sort(),
      operators: [...operators].sort(),
      opsets: opsets.sort((left, right) => left.domain.localeCompare(right.domain)),
    };
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message.startsWith("unsafe-onnx-") ||
        error.message.startsWith("undeclared-onnx-"))
    ) {
      throw error;
    }
    throw new Error("invalid-onnx-model");
  }
}

export function assertTargetCompatibilityEvidence(
  evidence: TargetCompatibilityEvidence,
): void {
  const [blocker] = compatibilityBlockers(evidence);
  if (blocker) throw new Error(blocker);
}

export function compatibilityBlockers(
  evidence: TargetCompatibilityEvidence,
): string[] {
  const blockers: string[] = [];
  if (!SUPPORTED_RUNTIME_TARGETS.includes(evidence.target)) {
    blockers.push("unsupported-evidence-target");
  }
  if (evidence.bunVersion !== "1.3.14") blockers.push("bun-version-mismatch");
  if (!evidence.floorVerified) blockers.push("platform-floor-unverified");
  if (!evidence.baselineCpuVerified) blockers.push("baseline-cpu-unverified");
  if (!evidence.blockedNetworkingVerified) {
    blockers.push("blocked-networking-unverified");
  }
  if (!evidence.ordinaryLoaderPathVerified) {
    blockers.push("ordinary-loader-path-unverified");
  }
  if (evidence.nativeDependencies.unresolved.length > 0) {
    blockers.push("unresolved-native-dependency");
  }
  if (evidence.nativeDependencies.undeclared.length > 0) {
    blockers.push("undeclared-native-dependency");
  }
  if (!evidence.runnerCpu.trim() || !evidence.runnerOs.trim()) {
    blockers.push("runner-identity-missing");
  }
  if (evidence.target.startsWith("linux-")) {
    for (const backend of ["alsa", "pulseaudio", "pipewire"]) {
      if (!evidence.audioBackends.includes(backend)) {
        blockers.push("linux-audio-envelope-incomplete");
        break;
      }
    }
    if (!evidence.promptFailureVerified) {
      blockers.push("audio-prompt-failure-unverified");
    }
  }
  if (
    evidence.target === "win32-x64" &&
    evidence.windowsAppLocalRuntimeApproved !== true
  ) {
    blockers.push("windows-app-local-runtime-unapproved");
  }
  return blockers;
}

export function assertReleaseInventory(manifest: ReleaseManifest): void {
  const expected = manifest.target
    ? runtimeReleaseFiles(manifest.target)
    : SHARED_RELEASE_FILES;
  const actualIdentity = manifest.files.map((file) => ({
    logicalDestination: file.logicalDestination,
    releaseFilename: file.releaseFilename,
  }));
  const expectedIdentity = expected
    .map((file) => ({
      logicalDestination: file.logicalDestination,
      releaseFilename: file.releaseFilename,
    }))
    .sort((left, right) =>
      left.logicalDestination.localeCompare(right.logicalDestination, "en"),
    );
  if (JSON.stringify(actualIdentity) !== JSON.stringify(expectedIdentity)) {
    throw new Error("release-inventory-policy-mismatch");
  }
  for (const file of manifest.files) {
    const lower = `${file.logicalDestination}/${file.releaseFilename}`.toLowerCase();
    if (
      lower.includes("ort-wasm") ||
      lower.includes("onnxruntime-web") ||
      lower.includes("cuda") ||
      lower.includes("directml") ||
      lower.includes("node_modules") ||
      (/voices\/.+\.bin$/.test(lower) && !lower.includes("voices/af_heart.bin"))
    ) {
      throw new Error("forbidden-release-artifact");
    }
  }
}

export function assertPinnedSharedManifest(manifest: ReleaseManifest): void {
  if (manifest.assetClass !== "shared" || manifest.target !== null) {
    throw new Error("shared-manifest-required");
  }
  const byDestination = new Map(
    manifest.files.map((file) => [file.logicalDestination, file]),
  );
  for (const asset of MODEL_ASSETS) {
    const file = byDestination.get(asset.relativePath);
    if (
      !file ||
      file.bytes !== asset.bytes ||
      file.sha256 !== asset.sha256
    ) {
      throw new Error(`pinned-shared-asset-mismatch:${asset.id}`);
    }
  }
}

function assertSafeExternalReference(path: string): void {
  if (
    !path ||
    isAbsolute(path) ||
    /^[A-Za-z]:[\\/]/.test(path) ||
    path.includes("\\") ||
    path.split("/").some((component) => component === "" || component === "." || component === "..")
  ) {
    throw new Error("unsafe-onnx-external-reference");
  }
}

function readFields(bytes: Uint8Array): ProtobufField[] {
  const fields: ProtobufField[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    const tag = readVarint(bytes, offset);
    offset = tag.offset;
    const field = Number(tag.value >> 3n);
    const wire = Number(tag.value & 7n);
    if (field <= 0) throw new Error("invalid-protobuf-field");
    if (wire === 0) {
      const result = readVarint(bytes, offset);
      offset = result.offset;
      fields.push({ field, value: result.value, wire });
    } else if (wire === 1) {
      if (offset + 8 > bytes.length) throw new Error("truncated-protobuf-field");
      fields.push({ field, value: bytes.subarray(offset, offset + 8), wire });
      offset += 8;
    } else if (wire === 2) {
      const length = readVarint(bytes, offset);
      offset = length.offset;
      const end = offset + Number(length.value);
      if (!Number.isSafeInteger(end) || end > bytes.length) {
        throw new Error("truncated-protobuf-field");
      }
      fields.push({ field, value: bytes.subarray(offset, end), wire });
      offset = end;
    } else if (wire === 5) {
      if (offset + 4 > bytes.length) throw new Error("truncated-protobuf-field");
      fields.push({ field, value: bytes.subarray(offset, offset + 4), wire });
      offset += 4;
    } else {
      throw new Error("unsupported-protobuf-wire-type");
    }
  }
  return fields;
}

function readVarint(
  bytes: Uint8Array,
  start: number,
): { offset: number; value: bigint } {
  let offset = start;
  let shift = 0n;
  let value = 0n;
  while (offset < bytes.length && shift <= 63n) {
    const byte = bytes[offset++]!;
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { offset, value };
    shift += 7n;
  }
  throw new Error("invalid-protobuf-varint");
}

function readString(fields: ProtobufField[], field: number): string {
  const value = fields.find(
    (candidate) =>
      candidate.field === field && candidate.value instanceof Uint8Array,
  )?.value;
  return value instanceof Uint8Array
    ? new TextDecoder("utf-8", { fatal: true }).decode(value)
    : "";
}

function readInteger(
  fields: ProtobufField[],
  field: number,
  fallback?: bigint,
): bigint {
  const value = fields.find(
    (candidate) => candidate.field === field && typeof candidate.value === "bigint",
  )?.value;
  if (typeof value === "bigint") return value;
  if (fallback !== undefined) return fallback;
  throw new Error("missing-protobuf-integer");
}
