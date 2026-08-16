import type { SupportedRuntimeTarget } from "../src/backend";
import { resolveRuntimeTarget } from "../src/backend";
import { MODEL_ASSETS } from "../src/model-assets";
import { HELPER_VERSION } from "../src/protocol";
import type { ReleaseFileInput } from "./release-manifest";

export interface TargetCompatibilityPolicy {
  bunTarget: Bun.Build.CompileTarget;
  minimum: Readonly<Record<string, string>>;
  requiredEvidence: readonly string[];
}

export const TARGET_COMPATIBILITY: Readonly<
  Record<SupportedRuntimeTarget, TargetCompatibilityPolicy>
> = Object.freeze({
  "darwin-x64": {
    bunTarget: "bun-darwin-x64-baseline",
    minimum: { macos: "13" },
    requiredEvidence: [
      "native-runner",
      "minimum-os",
      "bun-x64-baseline-cpu",
      "loader-relative-sidecars",
    ],
  },
  "darwin-arm64": {
    bunTarget: "bun-darwin-arm64",
    minimum: { macos: "13" },
    requiredEvidence: ["native-runner", "minimum-os", "loader-relative-sidecars"],
  },
  "linux-x64": {
    bunTarget: "bun-linux-x64-baseline",
    minimum: { glibc: "2.27", kernel: "5.1" },
    requiredEvidence: [
      "native-runner",
      "glibc-symbol-floor",
      "bun-x64-baseline-cpu",
      "origin-relative-sidecars",
      "local-audio-envelope",
    ],
  },
  "linux-arm64": {
    bunTarget: "bun-linux-arm64",
    minimum: { glibc: "2.17", kernel: "5.1", cpu: "generic-aarch64" },
    requiredEvidence: [
      "native-runner-exact-cpu",
      "glibc-symbol-floor",
      "origin-relative-sidecars",
      "local-audio-envelope",
    ],
  },
  "win32-x64": {
    bunTarget: "bun-windows-x64-baseline",
    minimum: { windows: "10.0.17763" },
    requiredEvidence: [
      "native-runner",
      "minimum-os",
      "bun-x64-baseline-cpu",
      "adjacent-dll-sidecars",
      "approved-app-local-runtime",
    ],
  },
});

export function runtimeReleaseFiles(
  target: SupportedRuntimeTarget,
): readonly ReleaseFileInput[] {
  const runtime = resolveRuntimeTarget(...targetParts(target));
  const windows = target === "win32-x64";
  const prefix = `llm-now-kokoro-${HELPER_VERSION}-${target}`;
  return Object.freeze([
    {
      logicalDestination: windows ? "llm-now-kokoro.exe" : "llm-now-kokoro",
      releaseFilename: `${prefix}-helper${windows ? ".exe" : ""}`,
    },
    {
      logicalDestination: windows
        ? "runtime/llm-now-kokoro-player.exe"
        : "runtime/llm-now-kokoro-player",
      releaseFilename: `${prefix}-player${windows ? ".exe" : ""}`,
    },
    {
      logicalDestination: "runtime/onnx/onnxruntime_binding.node",
      releaseFilename: `${prefix}-onnxruntime-binding.node`,
    },
    {
      logicalDestination: `runtime/onnx/${runtime.libraryName}`,
      releaseFilename: `${prefix}-${runtime.libraryName}`,
    },
  ]);
}

const SHARED_PREFIX = `llm-now-kokoro-${HELPER_VERSION}-shared`;

export const SHARED_RELEASE_FILES: readonly ReleaseFileInput[] = Object.freeze([
  ...MODEL_ASSETS.map((asset) => ({
    logicalDestination: asset.relativePath,
    releaseFilename: `${SHARED_PREFIX}-${asset.id}${extension(asset.relativePath)}`,
  })),
  {
    logicalDestination: "protocol/v1/contract.json",
    releaseFilename: `${SHARED_PREFIX}-protocol-contract.json`,
  },
  {
    logicalDestination: "protocol/v1/fixtures/info-success.stdout.json",
    releaseFilename: `${SHARED_PREFIX}-fixture-info-success.json`,
  },
  {
    logicalDestination: "protocol/v1/fixtures/speak-valid.stdin.json",
    releaseFilename: `${SHARED_PREFIX}-fixture-speak-valid.json`,
  },
  {
    logicalDestination: "LICENSE",
    releaseFilename: `${SHARED_PREFIX}-license.txt`,
  },
  {
    logicalDestination: "THIRD_PARTY_NOTICES.md",
    releaseFilename: `${SHARED_PREFIX}-third-party-notices.md`,
  },
]);

function extension(path: string): string {
  const match = /(?:\.[A-Za-z0-9]+)+$/.exec(path);
  return match?.[0] ?? "";
}

function targetParts(
  target: SupportedRuntimeTarget,
): [NodeJS.Platform, NodeJS.Architecture] {
  const [platform, architecture] = target.split("-");
  return [platform as NodeJS.Platform, architecture as NodeJS.Architecture];
}
