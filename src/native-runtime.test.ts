import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import {
  ADDON_NAME,
  ONNX_BINDING_PATH_SYMBOL,
  prepareNativeRuntime,
} from "./native-runtime";

describe("native ONNX sidecar resolution", () => {
  test.each([
    ["darwin", "x64", "libonnxruntime.1.21.0.dylib"],
    ["darwin", "arm64", "libonnxruntime.1.21.0.dylib"],
    ["linux", "x64", "libonnxruntime.so.1"],
    ["linux", "arm64", "libonnxruntime.so.1"],
    ["win32", "x64", "onnxruntime.dll"],
  ] as const)("selects only %s-%s sidecars", async (platform, architecture, library) => {
    const assigned: string[] = [];
    const packRoot = resolve("/packs/space ü");
    const runtimeRoot = resolve(packRoot, "runtime/onnx");
    const result = await prepareNativeRuntime(packRoot, {
      platform,
      architecture,
      listEntries: async () => [library, ADDON_NAME],
      inspectRegularFile: async () => true,
      setBindingPath: (path) => assigned.push(path),
    });

    expect(result).toEqual({
      addonPath: resolve(runtimeRoot, ADDON_NAME),
      libraryPath: resolve(runtimeRoot, library),
      root: runtimeRoot,
      target: `${platform}-${architecture}`,
    });
    expect(assigned).toEqual([result.addonPath]);
  });

  test("rejects wrong-target, CUDA, DirectML, or extra sidecars", async () => {
    for (const unexpected of [
      "onnxruntime.dll",
      "libonnxruntime_providers_cuda.so",
      "onnxruntime_providers_dml.dll",
      "darwin-x64",
    ]) {
      await expect(
        prepareNativeRuntime("/pack", {
          platform: "linux",
          architecture: "arm64",
          listEntries: async () => [
            ADDON_NAME,
            "libonnxruntime.so.1",
            unexpected,
          ],
          inspectRegularFile: async () => true,
        }),
      ).rejects.toThrow("native-runtime-layout-invalid");
    }
  });

  test("ignores a hostile legacy environment loader value", async () => {
    const previous = process.env.KOKORO_ONNX_BINDING_PATH;
    process.env.KOKORO_ONNX_BINDING_PATH = "/hostile/answer-bearing/path";
    try {
      const packRoot = resolve("/verified");
      await prepareNativeRuntime(packRoot, {
        platform: "darwin",
        architecture: "arm64",
        listEntries: async () => [
          ADDON_NAME,
          "libonnxruntime.1.21.0.dylib",
        ],
        inspectRegularFile: async () => true,
      });
      expect(
        (globalThis as typeof globalThis & Record<symbol, unknown>)[
          ONNX_BINDING_PATH_SYMBOL
        ],
      ).toBe(resolve(packRoot, "runtime/onnx/onnxruntime_binding.node"));
    } finally {
      if (previous === undefined) delete process.env.KOKORO_ONNX_BINDING_PATH;
      else process.env.KOKORO_ONNX_BINDING_PATH = previous;
    }
  });

  test("performs no extraction or temporary-file writes", async () => {
    const calls: string[] = [];
    const packRoot = resolve("/read-only-pack");
    const runtimeRoot = resolve(packRoot, "runtime/onnx");
    await prepareNativeRuntime(packRoot, {
      platform: "win32",
      architecture: "x64",
      listEntries: async (path) => {
        calls.push(`list:${path}`);
        return [ADDON_NAME, "onnxruntime.dll"];
      },
      inspectRegularFile: async (path) => {
        calls.push(`inspect:${path}`);
        return true;
      },
      setBindingPath: (path) => calls.push(`bind:${path}`),
    });
    expect(calls).toEqual([
      `list:${runtimeRoot}`,
      `inspect:${resolve(runtimeRoot, "onnxruntime_binding.node")}`,
      `inspect:${resolve(runtimeRoot, "onnxruntime.dll")}`,
      `bind:${resolve(runtimeRoot, "onnxruntime_binding.node")}`,
    ]);
  });
});
