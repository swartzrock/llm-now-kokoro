import { lstat, readdir } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import { resolveRuntimeTarget } from "./backend";

export const ADDON_NAME = "onnxruntime_binding.node";
export const ONNX_BINDING_PATH_SYMBOL = Symbol.for(
  "llm-now-kokoro.onnx-binding-path",
);

interface NativeRuntimeDependencies {
  architecture?: NodeJS.Architecture;
  inspectRegularFile?: (path: string) => Promise<boolean>;
  listEntries?: (path: string) => Promise<string[]>;
  platform?: NodeJS.Platform;
  setBindingPath?: (path: string) => void;
}

export interface NativeRuntime {
  addonPath: string;
  libraryPath: string;
  root: string;
  target: string;
}

export async function prepareNativeRuntime(
  packRoot = process.cwd(),
  dependencies: NativeRuntimeDependencies = {},
): Promise<NativeRuntime> {
  if (!isAbsolute(packRoot)) throw new Error("pack-root-not-absolute");
  const target = resolveRuntimeTarget(
    dependencies.platform ?? process.platform,
    dependencies.architecture ?? process.arch,
  );
  const root = resolve(packRoot, "runtime/onnx");
  const addonPath = resolve(root, ADDON_NAME);
  const libraryPath = resolve(root, target.libraryName);
  const listEntries = dependencies.listEntries ?? readdir;
  const inspectRegularFile =
    dependencies.inspectRegularFile ??
    (async (path: string) => (await lstat(path)).isFile());

  let entries: string[];
  try {
    entries = (await listEntries(root)).sort();
  } catch {
    throw new Error("native-runtime-layout-invalid");
  }
  const expected = [ADDON_NAME, target.libraryName].sort();
  if (entries.join("\n") !== expected.join("\n")) {
    throw new Error("native-runtime-layout-invalid");
  }
  try {
    if (
      !(await inspectRegularFile(addonPath)) ||
      !(await inspectRegularFile(libraryPath))
    ) {
      throw new Error("invalid");
    }
  } catch {
    throw new Error("native-runtime-layout-invalid");
  }

  (dependencies.setBindingPath ?? setGlobalBindingPath)(addonPath);
  return { addonPath, libraryPath, root, target: target.id };
}

function setGlobalBindingPath(path: string): void {
  Object.defineProperty(globalThis, ONNX_BINDING_PATH_SYMBOL, {
    configurable: true,
    value: path,
  });
}
