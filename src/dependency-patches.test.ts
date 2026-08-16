import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");

describe("native-only dependency patch anchors", () => {
  test("onnxruntime-node requires only the verified global sidecar path", async () => {
    const [installed, patch] = await Promise.all([
      Bun.file(
        resolve(root, "node_modules/onnxruntime-node/dist/binding.js"),
      ).text(),
      Bun.file(resolve(root, "patches/onnxruntime-node@1.21.0.patch")).text(),
    ]);

    for (const source of [
      installed,
      patch
        .split("\n")
        .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
        .join("\n"),
    ]) {
      expect(source).toContain("llm-now-kokoro.onnx-binding-path");
      expect(source).toContain("native-binding-path-unavailable");
      expect(source).not.toContain(
        "../bin/napi-v3/${process.platform}/${process.arch}",
      );
      expect(source).not.toContain("KOKORO_ONNX_BINDING_PATH");
    }
  });

  test("Transformers' Node build cannot accept an injected Wasm runtime", async () => {
    const patch = await Bun.file(
      resolve(
        root,
        "patches/@huggingface%2ftransformers@3.5.1.patch",
      ),
    ).text();

    expect(patch).toContain('await import("onnxruntime-node")');
    expect(patch).toContain("-const ORT_SYMBOL = Symbol.for('onnxruntime')");
    expect(patch).not.toContain("supportedDevices.push('wasm')");
  });

  test("Kokoro exports its upstream phonemizer and requires the fixed provider", async () => {
    const [runtime, types, patch] = await Promise.all([
      Bun.file(resolve(root, "node_modules/kokoro-js/dist/kokoro.js")).text(),
      Bun.file(resolve(root, "node_modules/kokoro-js/types/kokoro.d.ts")).text(),
      Bun.file(resolve(root, "patches/kokoro-js@1.2.1.patch")).text(),
    ]);

    for (const source of [runtime, patch]) {
      expect(source).toContain('"af_heart"!==e');
      expect(source).toContain("voice-provider-unavailable");
      expect(source).toContain("m as phonemize");
    }
    expect(types).toContain('export { phonemize } from "./phonemize";');
    const patchedLoader = runtime.slice(
      runtime.indexOf("async function k(e)"),
      runtime.indexOf("class M"),
    );
    expect(patchedLoader).not.toContain("fetch(");
    expect(patchedLoader).not.toContain("../voices/");
  });

  test("the helper has no direct inference-Wasm dependency or source module", async () => {
    const packageJson = await Bun.file(resolve(root, "package.json")).json();
    expect(packageJson.dependencies).not.toHaveProperty("onnxruntime-web");
    expect(await Bun.file(resolve(root, "src/wasm-runtime.ts")).exists()).toBe(
      false,
    );
  });
});
