export const SUPPORTED_RUNTIME_TARGETS = [
  "darwin-x64",
  "darwin-arm64",
  "linux-x64",
  "linux-arm64",
  "win32-x64",
] as const;

export type SupportedRuntimeTarget =
  (typeof SUPPORTED_RUNTIME_TARGETS)[number];

export interface NativeRuntimeTarget {
  id: SupportedRuntimeTarget;
  libraryName: string;
}

const TARGETS: Readonly<Record<SupportedRuntimeTarget, NativeRuntimeTarget>> = {
  "darwin-x64": {
    id: "darwin-x64",
    libraryName: "libonnxruntime.1.21.0.dylib",
  },
  "darwin-arm64": {
    id: "darwin-arm64",
    libraryName: "libonnxruntime.1.21.0.dylib",
  },
  "linux-x64": {
    id: "linux-x64",
    libraryName: "libonnxruntime.so.1",
  },
  "linux-arm64": {
    id: "linux-arm64",
    libraryName: "libonnxruntime.so.1",
  },
  "win32-x64": {
    id: "win32-x64",
    libraryName: "onnxruntime.dll",
  },
};

export function resolveRuntimeTarget(
  platform = process.platform,
  architecture = process.arch,
): NativeRuntimeTarget {
  const target = TARGETS[`${platform}-${architecture}` as SupportedRuntimeTarget];
  if (!target) {
    throw new Error("unsupported-runtime-target");
  }
  return target;
}
