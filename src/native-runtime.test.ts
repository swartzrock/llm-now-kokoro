import { expect, test } from "bun:test";

import { prepareNativeRuntime } from "./native-runtime";

test("removes the unique native directory when materialization fails", async () => {
  const removed: string[] = [];
  let writes = 0;

  await expect(
    prepareNativeRuntime({
      makeTempDirectory: async () => "/tmp/kokoro-cli-onnx-test",
      readAsset: async () => new Uint8Array([1, 2, 3]),
      writeAsset: async () => {
        writes += 1;
        if (writes === 2) {
          throw new Error("forced addon write failure");
        }
      },
      removeDirectory: async (directory) => {
        removed.push(directory);
      },
    }),
  ).rejects.toThrow("forced addon write failure");

  expect(removed).toEqual(["/tmp/kokoro-cli-onnx-test"]);
});

test("hands off an absolute addon path and cleans it after a consumer failure", async () => {
  const written: string[] = [];
  const removed: string[] = [];
  const environment: Record<string, string | undefined> = {};
  const runtime = await prepareNativeRuntime({
    makeTempDirectory: async () => "/tmp/kokoro-cli-onnx-test",
    readAsset: async () => new Uint8Array([1, 2, 3]),
    writeAsset: async (path) => {
      written.push(path);
    },
    removeDirectory: async (directory) => {
      removed.push(directory);
    },
    getBindingPath: () => environment.KOKORO_ONNX_BINDING_PATH,
    setBindingPath: (path) => {
      environment.KOKORO_ONNX_BINDING_PATH = path;
    },
  });

  expect(written).toEqual([
    "/tmp/kokoro-cli-onnx-test/libonnxruntime.1.21.0.dylib",
    "/tmp/kokoro-cli-onnx-test/onnxruntime_binding.node",
  ]);
  expect(environment.KOKORO_ONNX_BINDING_PATH).toBe(
    "/tmp/kokoro-cli-onnx-test/onnxruntime_binding.node",
  );

  await expect(
    (async () => {
      try {
        throw new Error("forced inference failure");
      } finally {
        await runtime.cleanup();
      }
    })(),
  ).rejects.toThrow("forced inference failure");

  expect(environment.KOKORO_ONNX_BINDING_PATH).toBeUndefined();
  expect(removed).toEqual(["/tmp/kokoro-cli-onnx-test"]);
});
