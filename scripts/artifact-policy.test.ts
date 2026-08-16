import { describe, expect, test } from "bun:test";

import { assertInferenceArtifactPolicy } from "./artifact-policy";

const linuxArm64 = [
  "llm-now-kokoro",
  "runtime/llm-now-kokoro-player",
  "runtime/onnx/onnxruntime_binding.node",
  "runtime/onnx/libonnxruntime.so.1",
  "model/config.json",
  "model/tokenizer.json",
  "model/tokenizer_config.json",
  "model/onnx/model_quantized.onnx",
  "model/voices/af_heart.bin",
];

describe("inference artifact policy", () => {
  test("accepts exactly one native target and the fixed voice", () => {
    expect(() =>
      assertInferenceArtifactPolicy(linuxArm64, "linux", "arm64"),
    ).not.toThrow();
  });

  test.each([
    "runtime/ort-wasm-simd-threaded.wasm",
    "runtime/libonnxruntime_providers_cuda.so",
    "runtime/onnxruntime_providers_dml.dll",
    "model/voices/af_bella.bin",
  ])("rejects forbidden artifact %s", (path) => {
    expect(() =>
      assertInferenceArtifactPolicy([...linuxArm64, path], "linux", "arm64"),
    ).toThrow("forbidden-inference-artifact");
  });

  test("rejects a library from another target", () => {
    expect(() =>
      assertInferenceArtifactPolicy(
        [...linuxArm64, "runtime/onnx/onnxruntime.dll"],
        "linux",
        "arm64",
      ),
    ).toThrow("inference-artifact-layout-invalid");
  });

  test("rejects a missing helper, player, model, or target sidecar", () => {
    for (const missing of linuxArm64) {
      expect(() =>
        assertInferenceArtifactPolicy(
          linuxArm64.filter((path) => path !== missing),
          "linux",
          "arm64",
        ),
      ).toThrow("inference-artifact-layout-invalid");
    }
  });
});
