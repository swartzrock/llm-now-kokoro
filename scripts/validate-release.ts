import { resolve } from "node:path";

import { resolveRuntimeTarget } from "../src/backend";
import { HELPER_VERSION } from "../src/protocol";
import {
  assertFirstTargetSizeBudget,
  manifestBytes,
  readCanonicalReleaseManifest,
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

const runtime = await readCanonicalReleaseManifest(
  resolve(
    releaseRoot,
    target,
    `llm-now-kokoro-${HELPER_VERSION}-${target}-manifest.json`,
  ),
);
const shared = await readCanonicalReleaseManifest(
  resolve(
    releaseRoot,
    `shared/llm-now-kokoro-${HELPER_VERSION}-shared-manifest.json`,
  ),
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
