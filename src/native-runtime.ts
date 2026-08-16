import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { PreparedRuntime } from "./backend";

export const ADDON_NAME = "onnxruntime_binding.node";
export const DYLIB_NAME = "libonnxruntime.1.21.0.dylib";
const BINDING_PATH_VARIABLE = "KOKORO_ONNX_BINDING_PATH";

type EmbeddedAsset = Blob | Uint8Array;

export interface NativeRuntimeDependencies {
  makeTempDirectory?: () => Promise<string>;
  readAsset?: (path: string) => Promise<EmbeddedAsset>;
  writeAsset?: (path: string, asset: EmbeddedAsset) => Promise<void>;
  removeDirectory?: (directory: string) => Promise<void>;
  getBindingPath?: () => string | undefined;
  setBindingPath?: (path: string | undefined) => void;
}

export async function prepareNativeRuntime(
  dependencies: NativeRuntimeDependencies = {},
): Promise<PreparedRuntime> {
  const makeTempDirectory =
    dependencies.makeTempDirectory ??
    (() => mkdtemp(join(tmpdir(), "kokoro-cli-onnx-")));
  const readAsset =
    dependencies.readAsset ?? readEmbeddedAsset;
  const writeAsset =
    dependencies.writeAsset ??
    (async (path: string, asset: EmbeddedAsset) => {
      await Bun.write(path, asset);
    });
  const removeDirectory =
    dependencies.removeDirectory ??
    ((directory: string) => rm(directory, { recursive: true, force: true }));
  const getBindingPath =
    dependencies.getBindingPath ?? (() => process.env[BINDING_PATH_VARIABLE]);
  const setBindingPath =
    dependencies.setBindingPath ??
    ((path: string | undefined) => {
      if (path === undefined) {
        delete process.env[BINDING_PATH_VARIABLE];
      } else {
        process.env[BINDING_PATH_VARIABLE] = path;
      }
    });

  const previousBindingPath = getBindingPath();
  const directory = await makeTempDirectory();
  const addonPath = resolve(directory, ADDON_NAME);
  let cleaned = false;

  try {
    await writeAsset(
      resolve(directory, DYLIB_NAME),
      await readAsset(DYLIB_NAME),
    );
    await writeAsset(addonPath, await readAsset(ADDON_NAME));
    setBindingPath(addonPath);
  } catch (error) {
    setBindingPath(previousBindingPath);
    await removeDirectory(directory);
    throw error;
  }

  return {
    cleanup: async () => {
      if (cleaned) return;
      cleaned = true;
      setBindingPath(previousBindingPath);
      await removeDirectory(directory);
    },
  };
}

async function readEmbeddedAsset(name: string): Promise<Blob> {
  const asset = Bun.embeddedFiles.find(
    (file) => (file as Blob & { name: string }).name === name,
  );
  if (!asset) {
    throw new Error(`Embedded native runtime asset not found: ${name}`);
  }

  return asset;
}
