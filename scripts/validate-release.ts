import { resolve } from "node:path";

import { resolveRuntimeTarget } from "../src/backend";
import type { ReleaseManifest } from "./release-manifest";
import {
  assertFirstTargetSizeBudget,
  canonicalManifestJson,
  manifestBytes,
  validateReleaseManifest,
} from "./release-manifest";
import {
  assertPinnedSharedManifest,
  assertReleaseInventory,
  compatibilityBlockers,
} from "./release-validation";
import {
  assertNativeInspectionReceipt,
  type NativeInspectionReport,
} from "./native-inspection";

const releaseRoot = resolve(import.meta.dir, "../dist/release");
const target = resolveRuntimeTarget().id;

const runtime = await readManifest(
  resolve(
    releaseRoot,
    target,
    `llm-now-kokoro-0.1.0-${target}-manifest.json`,
  ),
);
const shared = await readManifest(
  resolve(releaseRoot, "shared/llm-now-kokoro-0.1.0-shared-manifest.json"),
);
if (runtime.target !== target) throw new Error("release-runner-target-mismatch");

await Promise.all([
  validateReleaseManifest(runtime, resolve(releaseRoot, target, "assets")),
  validateReleaseManifest(shared, resolve(releaseRoot, "shared/assets")),
]);
assertReleaseInventory(runtime);
assertReleaseInventory(shared);
assertPinnedSharedManifest(shared);
assertFirstTargetSizeBudget({
  runtimeBytes: manifestBytes(runtime),
  sharedBytes: manifestBytes(shared),
});
const reportPath = resolve(releaseRoot, target, "unsigned-build-report.json");
const report = (await Bun.file(reportPath).json()) as {
  compatibilityEvidence: NativeInspectionReport;
  releaseBlockers: string[];
  releaseEligible: boolean;
};
assertNativeInspectionReceipt(report.compatibilityEvidence, runtime);
if (report.compatibilityEvidence.target !== target) {
  throw new Error("compatibility-report-target-mismatch");
}
const expectedBlockers = compatibilityBlockers(report.compatibilityEvidence);
if (
  JSON.stringify(report.releaseBlockers) !== JSON.stringify(expectedBlockers) ||
  report.releaseEligible !== (expectedBlockers.length === 0)
) {
  throw new Error("compatibility-report-dishonest");
}

console.log(
  JSON.stringify({
    compatibilityEvidence: report.compatibilityEvidence,
    downloadBytes: manifestBytes(runtime) + manifestBytes(shared),
    runtimeFiles: runtime.files.length,
    releaseBlockers: report.releaseBlockers,
    releaseEligible: report.releaseEligible,
    sharedFiles: shared.files.length,
    status: "ok",
    target,
  }),
);

async function readManifest(path: string): Promise<ReleaseManifest> {
  const source = await Bun.file(path).text();
  const manifest = JSON.parse(source) as ReleaseManifest;
  if (source !== canonicalManifestJson(manifest)) {
    throw new Error("release-manifest-not-canonical");
  }
  return manifest;
}
