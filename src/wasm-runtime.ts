import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { PreparedRuntime } from "./backend";
import { errorMessage } from "./error-message";

// @ts-expect-error Bun file-loader import
import wasmModuleAssetPath from "../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs" with { type: "file" };
// @ts-expect-error Bun file-loader import
import wasmBinaryAssetPath from "../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm" with { type: "file" };

export const WASM_MODULE_NAME = "ort-wasm-simd-threaded.mjs";
export const WASM_BINARY_NAME = "ort-wasm-simd-threaded.wasm";
export const WASM_ASSET_NAMES = [
  WASM_MODULE_NAME,
  WASM_BINARY_NAME,
] as const;

const ONNX_RUNTIME_SYMBOL = Symbol.for("onnxruntime");
const SOURCE_WASM_DIRECTORY = dirname(wasmModuleAssetPath);
const SOURCE_WASM_ASSET_PATHS = {
  [WASM_MODULE_NAME]: wasmModuleAssetPath,
  [WASM_BINARY_NAME]: wasmBinaryAssetPath,
};
type WasmAssetName = (typeof WASM_ASSET_NAMES)[number];

type EmbeddedAsset = Blob | Uint8Array;

interface WebOnnxRuntime {
  env: {
    wasm: {
      wasmPaths?: string;
    };
  };
}

export interface WasmRuntimeDependencies {
  makeTempDirectory?: () => Promise<string>;
  readAsset?: (name: WasmAssetName) => Promise<EmbeddedAsset>;
  writeAsset?: (path: string, asset: EmbeddedAsset) => Promise<void>;
  removeDirectory?: (directory: string) => Promise<void>;
  loadRuntime?: () => Promise<WebOnnxRuntime>;
  hasEmbeddedRuntime?: () => boolean;
}

export async function prepareWasmRuntime(
  dependencies: WasmRuntimeDependencies = {},
): Promise<PreparedRuntime> {
  const shouldMaterialize = (
    dependencies.hasEmbeddedRuntime ?? hasEmbeddedWasmRuntime
  )();
  const removeDirectory =
    dependencies.removeDirectory ??
    ((directory: string) => rm(directory, { recursive: true, force: true }));
  let directory: string | undefined;

  try {
    if (shouldMaterialize) {
      const makeTempDirectory =
        dependencies.makeTempDirectory ??
        (() => mkdtemp(join(tmpdir(), "kokoro-cli-wasm-")));
      const readAsset = dependencies.readAsset ?? readEmbeddedAsset;
      const writeAsset =
        dependencies.writeAsset ??
        (async (path: string, asset: EmbeddedAsset) => {
          await Bun.write(path, asset);
        });

      const runtimeDirectory = await makeTempDirectory();
      directory = runtimeDirectory;
      const writes = await Promise.allSettled(
        WASM_ASSET_NAMES.map(async (name) => {
          await writeAsset(
            resolve(runtimeDirectory, name),
            await readAsset(name),
          );
        }),
      );
      const failures = writes.filter(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      );
      if (failures.length === 1) throw failures[0]!.reason;
      if (failures.length > 1) {
        throw new AggregateError(
          failures.map((failure) => failure.reason),
          "Unable to stage WebAssembly runtime assets",
        );
      }
    }

    const runtime = await (dependencies.loadRuntime ?? loadWebRuntime)();
    const globals = globalThis as typeof globalThis & Record<symbol, unknown>;
    const previousRuntime = globals[ONNX_RUNTIME_SYMBOL];
    const previousWasmPaths = runtime.env.wasm.wasmPaths;
    runtime.env.wasm.wasmPaths = directoryUrl(
      directory ?? SOURCE_WASM_DIRECTORY,
    );
    globals[ONNX_RUNTIME_SYMBOL] = runtime;
    let cleaned = false;

    return {
      cleanup: async () => {
        if (cleaned) return;
        cleaned = true;
        runtime.env.wasm.wasmPaths = previousWasmPaths;
        if (previousRuntime === undefined) {
          delete globals[ONNX_RUNTIME_SYMBOL];
        } else {
          globals[ONNX_RUNTIME_SYMBOL] = previousRuntime;
        }
        if (directory !== undefined) {
          await removeDirectory(directory);
        }
      },
    };
  } catch (error) {
    if (directory !== undefined) {
      try {
        await removeDirectory(directory);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          `${errorMessage(error)}; Unable to clean WebAssembly runtime: ${errorMessage(cleanupError)}`,
        );
      }
    }
    throw error;
  }
}

function hasEmbeddedWasmRuntime(): boolean {
  const names = new Set(
    Bun.embeddedFiles.map((file) => (file as Blob & { name: string }).name),
  );
  return WASM_ASSET_NAMES.every((name) => names.has(name));
}

function directoryUrl(directory: string): string {
  return `${pathToFileURL(directory).href.replace(/\/$/, "")}/`;
}

async function loadWebRuntime(): Promise<WebOnnxRuntime> {
  // @ts-expect-error onnxruntime-web 1.21 omits its types from package exports.
  return import("onnxruntime-web") as Promise<unknown> as Promise<WebOnnxRuntime>;
}

async function readEmbeddedAsset(name: WasmAssetName): Promise<Blob> {
  const asset = Bun.embeddedFiles.find(
    (file) => (file as Blob & { name: string }).name === name,
  );
  if (!asset) {
    return Bun.file(SOURCE_WASM_ASSET_PATHS[name]);
  }
  return asset;
}
