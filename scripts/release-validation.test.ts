import { describe, expect, test } from "bun:test";

import { SUPPORTED_RUNTIME_TARGETS } from "../src/backend";
import { MODEL_ASSETS, MODEL_REVISION } from "../src/model-assets";
import {
  SHARED_RELEASE_FILES,
  TARGET_COMPATIBILITY,
  runtimeReleaseFiles,
} from "./release-inventory";
import {
  assertTargetCompatibilityEvidence,
  compatibilityBlockers,
  inspectOnnxModel,
} from "./release-validation";

function varint(value: number): number[] {
  const bytes: number[] = [];
  do {
    let byte = value & 0x7f;
    value >>>= 7;
    if (value) byte |= 0x80;
    bytes.push(byte);
  } while (value);
  return bytes;
}

function bytesField(field: number, bytes: number[]): number[] {
  return [(field << 3) | 2, ...varint(bytes.length), ...bytes];
}

function stringField(field: number, value: string): number[] {
  return bytesField(field, [...new TextEncoder().encode(value)]);
}

function intField(field: number, value: number): number[] {
  return [(field << 3) | 0, ...varint(value)];
}

function tinyOnnx(externalReference?: string): Uint8Array {
  const opset = [...stringField(1, ""), ...intField(2, 17)];
  const node = [...stringField(4, "Add")];
  const tensor = externalReference
    ? [
        ...bytesField(13, [
          ...stringField(1, "location"),
          ...stringField(2, externalReference),
        ]),
        ...intField(14, 1),
      ]
    : [];
  const graph = [...bytesField(1, node), ...bytesField(5, tensor)];
  return new Uint8Array([...bytesField(7, graph), ...bytesField(8, opset)]);
}

describe("fixed release inventory", () => {
  test("defines five narrow native sets and one pinned shared set", () => {
    expect(SUPPORTED_RUNTIME_TARGETS).toHaveLength(5);
    for (const target of SUPPORTED_RUNTIME_TARGETS) {
      const files = runtimeReleaseFiles(target);
      expect(files.map((file) => file.logicalDestination)).toHaveLength(4);
      expect(files.some((file) => file.logicalDestination.includes("cuda"))).toBe(false);
      expect(files.some((file) => file.logicalDestination.includes("ort-wasm"))).toBe(false);
      expect(TARGET_COMPATIBILITY[target].bunTarget).toContain(
        target.startsWith("win32-") ? "windows" : target.split("-")[0]!,
      );
    }
    expect(SHARED_RELEASE_FILES.map((file) => file.logicalDestination)).toEqual([
      ...MODEL_ASSETS.map((asset) => asset.relativePath),
      "protocol/v1/contract.json",
      "protocol/v1/fixtures/info-success.stdout.json",
      "protocol/v1/fixtures/speak-valid.stdin.json",
      "LICENSE",
      "THIRD_PARTY_NOTICES.md",
    ]);
    expect(MODEL_REVISION).toBe(
      "1939ad2a8e416c0acfeecc08a694d14ef25f2231",
    );
  });
});

describe("ONNX structure audit", () => {
  test("records opsets and operators for a self-contained model", () => {
    expect(inspectOnnxModel(tinyOnnx(), [])).toEqual({
      externalData: [],
      operators: ["ai.onnx:Add"],
      opsets: [{ domain: "ai.onnx", version: 17 }],
    });
  });

  test.each(["../weights.bin", "/tmp/weights.bin", "C:\\weights.bin"]) (
    "rejects unsafe external-data reference %s",
    (reference) => {
      expect(() => inspectOnnxModel(tinyOnnx(reference), [reference])).toThrow(
        "unsafe-onnx-external-reference",
      );
    },
  );

  test("rejects a safe-looking but undeclared external-data reference", () => {
    expect(() => inspectOnnxModel(tinyOnnx("weights.bin"), [])).toThrow(
      "undeclared-onnx-external-reference",
    );
  });
});

describe("target compatibility evidence", () => {
  test("accepts complete local native dependency and floor evidence", () => {
    expect(() =>
      assertTargetCompatibilityEvidence({
        audioBackends: ["alsa", "pulseaudio", "pipewire"],
        baselineCpuVerified: true,
        blockedNetworkingVerified: true,
        bunVersion: "1.3.14",
        floorVerified: true,
        nativeDependencies: {
          declared: ["libonnxruntime.so.1"],
          undeclared: [],
          unresolved: [],
        },
        ordinaryLoaderPathVerified: true,
        promptFailureVerified: true,
        realDevicePlaybackVerified: true,
        reproducibilityVerified: true,
        runnerCpu: "representative generic aarch64",
        runnerOs: "Linux",
        target: "linux-arm64",
      }),
    ).not.toThrow();
  });

  test.each([
    ["floorVerified", false, "platform-floor-unverified"],
    ["baselineCpuVerified", false, "baseline-cpu-unverified"],
    ["ordinaryLoaderPathVerified", false, "ordinary-loader-path-unverified"],
    ["promptFailureVerified", false, "audio-prompt-failure-unverified"],
    ["realDevicePlaybackVerified", false, "real-device-playback-unverified"],
    ["reproducibilityVerified", false, "reproducibility-unverified"],
  ] as const)("rejects missing %s evidence", (field, value, message) => {
    expect(() =>
      assertTargetCompatibilityEvidence({
        audioBackends: ["alsa", "pulseaudio", "pipewire"],
        baselineCpuVerified: true,
        blockedNetworkingVerified: true,
        bunVersion: "1.3.14",
        floorVerified: true,
        nativeDependencies: { declared: [], undeclared: [], unresolved: [] },
        ordinaryLoaderPathVerified: true,
        promptFailureVerified: true,
        realDevicePlaybackVerified: true,
        reproducibilityVerified: true,
        runnerCpu: "cpu",
        runnerOs: "os",
        target: "linux-arm64",
        [field]: value,
      }),
    ).toThrow(message);
  });

  test.each([...SUPPORTED_RUNTIME_TARGETS])(
    "requires real-device playback evidence for %s",
    (target) => {
      expect(
        compatibilityBlockers({
          audioBackends: target.startsWith("linux-")
            ? ["alsa", "pulseaudio", "pipewire"]
            : [],
          baselineCpuVerified: true,
          blockedNetworkingVerified: true,
          bunVersion: "1.3.14",
          floorVerified: true,
          nativeDependencies: { declared: [], undeclared: [], unresolved: [] },
          ordinaryLoaderPathVerified: true,
          promptFailureVerified: true,
          realDevicePlaybackVerified: false,
          reproducibilityVerified: true,
          runnerCpu: "cpu",
          runnerOs: "os",
          target,
          windowsAppLocalRuntimeApproved: true,
        }),
      ).toContain("real-device-playback-unverified");
    },
  );
});
