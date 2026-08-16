import { resolve } from "node:path";

import { SUPPORTED_RUNTIME_TARGETS } from "../src/backend";
import type { RootReleaseManifest, SigningEvidence, SignatureEvidenceFile } from "./secure-release";
import { assertSigningAndProvenance } from "./secure-release";

export async function validateFinalRelease(input: {
  attestationsVerified: boolean;
  releaseRoot: string;
  rootManifestPath: string;
}): Promise<void> {
  const root = await Bun.file(input.rootManifestPath).json() as RootReleaseManifest;
  const files: SignatureEvidenceFile[] = [];
  let sourceCommit: string | null = null;
  let bunLockSha256: string | null = null;
  for (const target of SUPPORTED_RUNTIME_TARGETS) {
    const receipt = await Bun.file(
      resolve(input.releaseRoot, target, "signing-receipt.json"),
    ).json() as SigningEvidence & { kind: string; releaseTag: string };
    if (receipt.releaseTag !== root.releaseTag) throw new Error("signing-receipt-tag-mismatch");
    if (sourceCommit && sourceCommit !== receipt.sourceCommit) throw new Error("signing-receipt-source-mismatch");
    if (bunLockSha256 && bunLockSha256 !== receipt.bunLockSha256) throw new Error("signing-receipt-lockfile-mismatch");
    sourceCommit = receipt.sourceCommit;
    bunLockSha256 = receipt.bunLockSha256;
    files.push(...receipt.files.map((file) => ({
      ...file,
      attestationVerified:
        target.startsWith("linux-") ? input.attestationsVerified : file.attestationVerified,
    })));
  }
  assertSigningAndProvenance(root, {
    bunLockSha256: bunLockSha256 ?? "",
    files,
    sourceCommit: sourceCommit ?? "",
  });
}

if (import.meta.main) {
  const [releaseRoot, rootManifestPath, attestations] = process.argv.slice(2);
  if (!releaseRoot || !rootManifestPath || attestations !== "verified") {
    throw new Error("usage: validate-final-release <release-root> <root-manifest> verified");
  }
  await validateFinalRelease({
    attestationsVerified: true,
    releaseRoot,
    rootManifestPath,
  });
}
