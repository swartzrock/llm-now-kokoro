import { ADDON_NAME } from "../src/native-runtime";
import { resolveRuntimeTarget } from "../src/backend";
import { MODEL_ASSETS } from "../src/model-assets";

export function assertInferenceArtifactPolicy(
  relativePaths: readonly string[],
  platform = process.platform,
  architecture = process.arch,
): void {
  const normalized = relativePaths.map((path) => path.replaceAll("\\", "/"));
  for (const path of normalized) {
    const lower = path.toLowerCase();
    if (
      lower.includes("ort-wasm") ||
      lower.includes("cuda") ||
      lower.includes("directml") ||
      lower.includes("providers_dml") ||
      (/\/voices\/[^/]+\.bin$/.test(lower) &&
        !lower.endsWith("/voices/af_heart.bin"))
    ) {
      throw new Error("forbidden-inference-artifact");
    }
  }

  const target = resolveRuntimeTarget(platform, architecture);
  const helperName = platform === "win32" ? "llm-now-kokoro.exe" : "llm-now-kokoro";
  const playerName =
    platform === "win32"
      ? "runtime/llm-now-kokoro-player.exe"
      : "runtime/llm-now-kokoro-player";
  const expected = [
    helperName,
    playerName,
    `runtime/onnx/${ADDON_NAME}`,
    `runtime/onnx/${target.libraryName}`,
    ...MODEL_ASSETS.map((asset) => asset.relativePath),
  ].sort();
  if (normalized.sort().join("\n") !== expected.join("\n")) {
    throw new Error("inference-artifact-layout-invalid");
  }
}
