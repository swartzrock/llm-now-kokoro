import { describe, expect, test } from "bun:test";

import {
  WASM_BINARY_NAME,
  WASM_MODULE_NAME,
  prepareWasmRuntime,
} from "./wasm-runtime";

describe("prepareWasmRuntime", () => {
  test("installs the web runtime, hands off colocated assets, and restores state", async () => {
    const events: string[] = [];
    const globals = globalThis as typeof globalThis & Record<symbol, unknown>;
    const runtimeSymbol = Symbol.for("onnxruntime");
    const previousRuntime = { name: "previous" };
    const webRuntime = { env: { wasm: { wasmPaths: "previous-path" } } };
    globals[runtimeSymbol] = previousRuntime;

    const runtime = await prepareWasmRuntime({
      hasEmbeddedRuntime: () => true,
      makeTempDirectory: async () => "/tmp/kokoro-wasm-test",
      readAsset: async (name) => new TextEncoder().encode(name),
      writeAsset: async (path) => {
        events.push(`write:${path}`);
      },
      removeDirectory: async (path) => {
        events.push(`remove:${path}`);
      },
      loadRuntime: async () => webRuntime,
    });

    expect(events).toEqual([
      `write:/tmp/kokoro-wasm-test/${WASM_MODULE_NAME}`,
      `write:/tmp/kokoro-wasm-test/${WASM_BINARY_NAME}`,
    ]);
    expect(webRuntime.env.wasm.wasmPaths).toBe(
      "file:///tmp/kokoro-wasm-test/",
    );
    expect(globals[runtimeSymbol]).toBe(webRuntime);

    await runtime.cleanup();
    await runtime.cleanup();

    expect(webRuntime.env.wasm.wasmPaths).toBe("previous-path");
    expect(globals[runtimeSymbol]).toBe(previousRuntime);
    expect(events.filter((event) => event.startsWith("remove:"))).toEqual([
      "remove:/tmp/kokoro-wasm-test",
    ]);
    delete globals[runtimeSymbol];
  });

  test("removes an installed global when no runtime existed before setup", async () => {
    const globals = globalThis as typeof globalThis & Record<symbol, unknown>;
    const runtimeSymbol = Symbol.for("onnxruntime");
    const webRuntime = { env: { wasm: {} } };
    delete globals[runtimeSymbol];

    const runtime = await prepareWasmRuntime({
      hasEmbeddedRuntime: () => false,
      loadRuntime: async () => webRuntime,
    });

    expect(globals[runtimeSymbol]).toBe(webRuntime);
    await runtime.cleanup();
    expect(runtimeSymbol in globals).toBe(false);
  });

  test("removes the temporary directory when runtime installation fails", async () => {
    const events: string[] = [];

    await expect(
      prepareWasmRuntime({
        hasEmbeddedRuntime: () => true,
        makeTempDirectory: async () => "/tmp/kokoro-wasm-failure",
        readAsset: async (name) => {
          if (name === WASM_BINARY_NAME) throw new Error("missing wasm");
          return new Uint8Array();
        },
        writeAsset: async () => {},
        removeDirectory: async (path) => {
          events.push(`remove:${path}`);
        },
        loadRuntime: async () => ({ env: { wasm: {} } }),
      }),
    ).rejects.toThrow("missing wasm");

    expect(events).toEqual(["remove:/tmp/kokoro-wasm-failure"]);
  });

  test("waits for every started asset write before failure cleanup", async () => {
    const events: string[] = [];
    let releaseModuleWrite!: () => void;
    let markModuleStarted!: () => void;
    const moduleStarted = new Promise<void>((resolve) => {
      markModuleStarted = resolve;
    });
    const moduleMayFinish = new Promise<void>((resolve) => {
      releaseModuleWrite = resolve;
    });

    const preparation = prepareWasmRuntime({
      hasEmbeddedRuntime: () => true,
      makeTempDirectory: async () => "/tmp/kokoro-wasm-parallel",
      readAsset: async () => new Uint8Array(),
      writeAsset: async (path) => {
        if (path.endsWith(WASM_MODULE_NAME)) {
          events.push("module-started");
          markModuleStarted();
          await moduleMayFinish;
          events.push("module-finished");
          return;
        }
        await moduleStarted;
        throw new Error("binary write failed");
      },
      removeDirectory: async () => {
        events.push("removed");
      },
    });

    await moduleStarted;
    await Promise.resolve();
    expect(events).toEqual(["module-started"]);
    releaseModuleWrite();

    await expect(preparation).rejects.toThrow("binary write failed");
    expect(events).toEqual(["module-started", "module-finished", "removed"]);
  });

  test("preserves setup and cleanup failures", async () => {
    let error: unknown;
    try {
      await prepareWasmRuntime({
        hasEmbeddedRuntime: () => true,
        makeTempDirectory: async () => "/tmp/kokoro-wasm-cleanup-failure",
        readAsset: async () => new Uint8Array(),
        writeAsset: async () => {},
        loadRuntime: async () => {
          throw new Error("runtime setup failed");
        },
        removeDirectory: async () => {
          throw new Error("directory cleanup failed");
        },
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([
      new Error("runtime setup failed"),
      new Error("directory cleanup failed"),
    ]);
  });
});
