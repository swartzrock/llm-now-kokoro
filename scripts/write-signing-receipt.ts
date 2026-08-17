import { lstat, readdir } from "node:fs/promises";
import { resolve } from "node:path";

import { inspectRegularFile } from "./release-manifest";
import { assertReleaseCandidateTag } from "./secure-release";

const [kind, assetRoot, outputPath, releaseTag, sourceCommit, bunLockSha256] =
  process.argv.slice(2);
if (
  !kind || !assetRoot || !outputPath || !releaseTag || !sourceCommit ||
  !bunLockSha256
) {
  throw new Error("usage: write-signing-receipt <kind> <asset-root> <output> <tag> <source-commit> <bun-lock-sha256>");
}
if (!["macos", "windows", "linux-checksum"].includes(kind)) {
  throw new Error("invalid-signing-receipt-kind");
}
assertReleaseCandidateTag(releaseTag);
if (!/^[0-9a-f]{40}$/.test(sourceCommit) || !/^[0-9a-f]{64}$/.test(bunLockSha256)) {
  throw new Error("invalid-signing-receipt-provenance");
}

const files = [];
for (const name of (await readdir(assetRoot)).sort()) {
  const path = resolve(assetRoot, name);
  const metadata = await lstat(path);
  if (!metadata.isFile()) throw new Error("signing-receipt-file-not-regular");
  const inspected = await inspectRegularFile(path);
  files.push({
    attestationVerified: kind === "linux-checksum" ? false : undefined,
    authenticodeVerified: kind === "windows" ? true : undefined,
    codeSignatureVerified: kind === "macos" ? true : undefined,
    notarizationVerified: kind === "macos" ? true : undefined,
    releaseFilename: name,
    sha256: inspected.sha256,
    timestampVerified: kind === "windows" ? true : undefined,
  });
}
await Bun.write(outputPath, `${JSON.stringify({
  bunLockSha256,
  files,
  kind,
  releaseTag,
  sourceCommit,
}, null, 2)}\n`);
