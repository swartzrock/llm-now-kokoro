import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ADDON_NAME = "onnxruntime_binding.node";
const DYLIB_NAME = "libonnxruntime.1.21.0.dylib";
const BINDING_PATH_VARIABLE = "KOKORO_ONNX_BINDING_PATH";

export interface NativeRuntimeDependencies {
  makeTempDirectory?: () => Promise<string>;
  readAsset?: (path: string) => Promise<Uint8Array>;
  writeAsset?: (path: string, bytes: Uint8Array) => Promise<void>;
  removeDirectory?: (directory: string) => Promise<void>;
  getBindingPath?: () => string | undefined;
  setBindingPath?: (path: string | undefined) => void;
}

export interface PreparedNativeRuntime {
  addonPath: string;
  cleanup: () => Promise<void>;
}

export async function prepareNativeRuntime(
  dependencies: NativeRuntimeDependencies = {},
): Promise<PreparedNativeRuntime> {
  const makeTempDirectory =
    dependencies.makeTempDirectory ??
    (() => mkdtemp(join(tmpdir(), "kokoro-cli-onnx-")));
  const readAsset =
    dependencies.readAsset ?? readEmbeddedAsset;
  const writeAsset =
    dependencies.writeAsset ??
    (async (path: string, bytes: Uint8Array) => {
      await Bun.write(path, bytes);
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
    addonPath,
    cleanup: async () => {
      if (cleaned) return;
      cleaned = true;
      setBindingPath(previousBindingPath);
      await removeDirectory(directory);
    },
  };
}

async function readEmbeddedAsset(name: string): Promise<Uint8Array> {
  const asset = Bun.embeddedFiles.find(
    (file) => (file as Blob & { name: string }).name === name,
  );
  if (!asset) {
    throw new Error(`Embedded native runtime asset not found: ${name}`);
  }

  return new Uint8Array(await asset.arrayBuffer());
}
