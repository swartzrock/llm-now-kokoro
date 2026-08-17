import { resolve } from "node:path";

import { SUPPORTED_RUNTIME_TARGETS } from "../src/backend";
import { HELPER_VERSION } from "../src/protocol";
import {
  assertComplianceComplete,
  createComplianceReport,
} from "./release-compliance";
import {
  readCanonicalReleaseManifest,
  type ReleaseManifest,
  validateReleaseManifest,
} from "./release-manifest";
import {
  assertPinnedSharedManifest,
  assertReleaseInventory,
  compatibilityBlockers,
} from "./release-validation";

export async function validateCollectedUnsignedRelease(
  releaseRoot: string,
): Promise<void> {
  const manifests: ReleaseManifest[] = [];
  for (const setName of [...SUPPORTED_RUNTIME_TARGETS, "shared"] as const) {
    const setRoot = resolve(releaseRoot, setName);
    const path = resolve(
      setRoot,
      `llm-now-kokoro-${HELPER_VERSION}-${setName}-manifest.json`,
    );
    const manifest = await readCanonicalReleaseManifest(path);
    if ((manifest.target ?? "shared") !== setName) {
      throw new Error("collected-release-target-mismatch");
    }
    await validateReleaseManifest(manifest, resolve(setRoot, "assets"));
    assertReleaseInventory(manifest);
    if (!manifest.target) {
      assertPinnedSharedManifest(manifest);
    } else {
      const report = await Bun.file(resolve(setRoot, "unsigned-build-report.json")).json() as {
        compatibilityEvidence: Parameters<typeof compatibilityBlockers>[0];
        releaseBlockers: string[];
        releaseEligible: boolean;
      };
      const blockers = compatibilityBlockers(report.compatibilityEvidence);
      if (
        blockers.length > 0 ||
        report.releaseEligible !== true ||
        JSON.stringify(report.releaseBlockers) !== JSON.stringify(blockers)
      ) {
        throw new Error(`unsigned-target-blocked:${setName}:${blockers.join(",")}`);
      }
    }
    manifests.push(manifest);
  }
  assertComplianceComplete(createComplianceReport(manifests));
}

if (import.meta.main) {
  await validateCollectedUnsignedRelease(
    process.argv[2] ?? resolve(import.meta.dir, "../dist/release"),
  );
  console.log(JSON.stringify({ status: "ok" }));
}
