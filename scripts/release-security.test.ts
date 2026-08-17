import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";

import { createReleaseManifest, type ReleaseManifest } from "./release-manifest";
import {
  assertComplianceComplete,
  createComplianceReport,
} from "./release-compliance";
import { canonicalManifestJson, validateReleaseManifest } from "./release-manifest";
import { refreshSignedReleaseManifest } from "./refresh-signed-release-manifest";
import { restoreReleaseModes } from "./restore-release-modes";
import {
  assertProtectedReleaseWorkflow,
  assertReleaseCandidateTag,
  assertSigningAndProvenance,
  createRootReleaseManifest,
  renderChecksums,
  renderReleaseCatalog,
} from "./secure-release";

async function temporaryDirectory(): Promise<string> {
  return mkdtemp(resolve(import.meta.dir, ".tmp-secure-release-"));
}

function manifest(
  target: ReleaseManifest["target"],
  files: ReleaseManifest["files"],
): ReleaseManifest {
  return {
    assetClass: target ? "runtime" : "shared",
    dependencies: {
      bun: "1.3.14",
      kokoroJs: "1.2.1",
      onnxruntimeNode: "1.21.0",
      transformersJs: "3.5.1",
    },
    embeddedComponents: [],
    files,
    formatVersion: 1,
    helperVersion: "0.1.0",
    modelRevision: "1939ad2a8e416c0acfeecc08a694d14ef25f2231",
    protocol: { capabilities: ["native-onnx-cpu"], major: 1 },
    sourceRevisions: {
      miniaudio: "350784a9467a79d0fa65802132668e5afbcf3777",
      phonemizer: "6835144b7ee9043129222549c1ed2f6a27216278",
    },
    target,
  } as unknown as ReleaseManifest;
}

describe("release compliance gate", () => {
  test("maps every shipped file and keeps unresolved obligations blocking", () => {
    const report = createComplianceReport([
      manifest("darwin-arm64", [
        {
          bytes: 1,
          logicalDestination: "llm-now-kokoro",
          mode: "0755",
          releaseFilename: "helper",
          sha256: "a".repeat(64),
          provenance: {
            component: "llm-now-kokoro",
            license: "GPL-3.0-or-later",
            obligations: ["complete-license", "corresponding-source"],
            sourceRevision: "source-commit",
          },
        },
      ]),
    ]);

    expect(report.files).toHaveLength(1);
    expect(report.files[0]?.releaseFilename).toBe("helper");
    expect(report.blockers).toContain("phonemizer-espeak-source-relink-unresolved");
    expect(report.blockers).toContain("bun-jsc-redistribution-unresolved");
    expect(report.blockers).toContain("model-training-attribution-unresolved");
    expect(report.blockers).toContain("windows-app-local-runtime-unresolved");
    expect(() => assertComplianceComplete(report)).toThrow(
      "release-compliance-blocked",
    );
  });

  test("rejects an unmapped shipped file even when blockers are waived", () => {
    const report = createComplianceReport([
      manifest(null, [
        {
          bytes: 1,
          logicalDestination: "mystery.bin",
          mode: "0644",
          releaseFilename: "mystery.bin",
          sha256: "b".repeat(64),
        } as ReleaseManifest["files"][number],
      ]),
    ], []);
    expect(() => assertComplianceComplete(report)).toThrow(
      "release-file-compliance-unmapped",
    );
  });

  test("maps generated metadata including self-referential checksum obligations", () => {
    const names = ["root-manifest.json", "catalog.json", "SHA256SUMS"];
    const report = createComplianceReport([], [], names.map((releaseFilename) => ({
      assetClass: "release-metadata",
      license: "GPL-3.0-or-later",
      logicalDestination: `evidence/generated/${releaseFilename}`,
      obligations: ["integrity", "provenance"],
      releaseFilename,
      sourceRevision: "f".repeat(40),
      target: null,
    })));
    expect(report.files.map((file) => file.releaseFilename).sort()).toEqual(names.sort());
    expect(() => assertComplianceComplete(report)).not.toThrow();
  });
});

describe("mechanical root manifest and catalog", () => {
  test("derives bytes, hashes, modes, checksums, and immutable URLs from files", async () => {
    const root = await temporaryDirectory();
    try {
      const assetRoot = resolve(root, "assets");
      await Bun.write(resolve(assetRoot, "helper"), "signed-helper");
      await chmod(resolve(assetRoot, "helper"), 0o755);
      await Bun.write(resolve(root, "bun.lock"), "lock");
      const runtime = await createReleaseManifest({
        assetClass: "runtime",
        assetRoot,
        files: [{
          logicalDestination: "llm-now-kokoro",
          releaseFilename: "helper",
        }],
        target: "darwin-arm64",
      });

      const first = await createRootReleaseManifest({
        bunLockPath: resolve(root, "bun.lock"),
        releaseSets: [{ assetRoot, manifest: runtime }],
        releaseTag: "v0.1.0-rc.1",
        repository: "swartzrock/llm-now-kokoro",
        sourceCommit: "f".repeat(40),
      });
      const second = await createRootReleaseManifest({
        bunLockPath: resolve(root, "bun.lock"),
        releaseSets: [{ assetRoot, manifest: runtime }],
        releaseTag: "v0.1.0-rc.1",
        repository: "swartzrock/llm-now-kokoro",
        sourceCommit: "f".repeat(40),
      });

      expect(second).toEqual(first);
      expect(first.files[0]).toMatchObject({
        assetClass: "runtime",
        bytes: 13,
        logicalDestination: "llm-now-kokoro",
        mode: "0755",
        releaseFilename: "helper",
        target: "darwin-arm64",
      });
      expect(first.files[0]?.provenance.sourceRevision).toBe("f".repeat(40));
      expect(first.generatedFiles.map((file) => file.releaseFilename)).toEqual([
        "llm-now-kokoro-0.1.0-root-manifest.json",
        "llm-now-kokoro-0.1.0-rc-catalog.json",
        "SHA256SUMS",
      ]);
      expect(renderChecksums(first)).toContain(`${first.files[0]?.sha256}  helper`);
      expect(renderReleaseCatalog(first)).toContain(
        "https://github.com/swartzrock/llm-now-kokoro/releases/download/v0.1.0-rc.1/helper",
      );

      await Bun.write(resolve(assetRoot, "helper"), "tampered");
      await expect(createRootReleaseManifest({
        bunLockPath: resolve(root, "bun.lock"),
        releaseSets: [{ assetRoot, manifest: runtime }],
        releaseTag: "v0.1.0-rc.1",
        repository: "swartzrock/llm-now-kokoro",
        sourceCommit: "f".repeat(40),
      })).rejects.toThrow("release-file-digest-mismatch");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("replaces an unsigned set manifest with hashes from signed bytes", async () => {
    const root = await temporaryDirectory();
    try {
      const assetRoot = resolve(root, "assets");
      await Bun.write(resolve(assetRoot, "helper"), "unsigned");
      await chmod(resolve(assetRoot, "helper"), 0o755);
      const unsigned = await createReleaseManifest({
        assetClass: "runtime",
        assetRoot,
        files: [{ logicalDestination: "llm-now-kokoro", releaseFilename: "helper" }],
        target: "darwin-arm64",
      });
      await Bun.write(resolve(root, "llm-now-kokoro-0.1.0-darwin-arm64-manifest.json"), canonicalManifestJson(unsigned));
      await Bun.write(resolve(assetRoot, "helper"), "signed-and-timestamped");
      await chmod(resolve(assetRoot, "helper"), 0o755);

      await refreshSignedReleaseManifest(root, "f".repeat(40));
      const refreshed = await Bun.file(resolve(root, "llm-now-kokoro-0.1.0-darwin-arm64-manifest.json")).json();
      expect(refreshed.files[0].sha256).not.toBe(unsigned.files[0]?.sha256);
      expect(refreshed.files[0].provenance.sourceRevision).toBe("f".repeat(40));
      await expect(validateReleaseManifest(refreshed, assetRoot)).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("restores executable modes from the canonical manifest after artifact transport", async () => {
    const root = await temporaryDirectory();
    try {
      const assetRoot = resolve(root, "assets");
      const helperPath = resolve(assetRoot, "helper");
      await Bun.write(helperPath, "helper");
      await chmod(helperPath, 0o755);
      const releaseManifest = await createReleaseManifest({
        assetClass: "runtime",
        assetRoot,
        files: [{ logicalDestination: "llm-now-kokoro", releaseFilename: "helper" }],
        target: "darwin-arm64",
      });
      await Bun.write(
        resolve(root, "llm-now-kokoro-0.1.0-darwin-arm64-manifest.json"),
        canonicalManifestJson(releaseManifest),
      );
      await chmod(helperPath, 0o644);

      await restoreReleaseModes([root]);

      await expect(validateReleaseManifest(releaseManifest, assetRoot)).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("protected publication policy", () => {
  test.each(["v0.1.0", "v0.1.0-rc.0", "latest", "v0.1.0-rc.1/evil"])(
    "rejects non-RC tag %s",
    (tag) => expect(() => assertReleaseCandidateTag(tag)).toThrow("invalid-rc-tag"),
  );
  test("accepts monotonically named RC tags", () => {
    expect(() => assertReleaseCandidateTag("v0.1.0-rc.1")).not.toThrow();
  });

  test("requires protected environment, minimal publish permissions, pinned actions, and no PR trigger", () => {
    const valid = `
on:\n  workflow_dispatch:\npermissions:\n  contents: read\njobs:\n  publish:\n    environment: release-signing\n    permissions:\n      contents: write\n      id-token: write\n      attestations: write\n    steps:\n      - uses: actions/checkout@${"a".repeat(40)}\n      - run: gh release view "$TAG" && exit 1 || true\n      - run: gh release create "$TAG" --verify-tag\n+`;
    expect(() => assertProtectedReleaseWorkflow(valid)).not.toThrow();
    expect(() => assertProtectedReleaseWorkflow(valid.replace("workflow_dispatch", "pull_request"))).toThrow("protected-workflow-pr-trigger");
    expect(() => assertProtectedReleaseWorkflow(valid.replace("release-signing", "production"))).toThrow("protected-environment-missing");
    expect(() => assertProtectedReleaseWorkflow(valid.replace(`@${"a".repeat(40)}`, "@v4"))).toThrow("workflow-action-not-pinned");
    expect(() => assertProtectedReleaseWorkflow(valid.replace("gh release view", "gh release upload --clobber\n      # gh release view"))).toThrow("mutable-release-command");
  });

  test("repository workflows isolate PRs from release identities", async () => {
    const protectedSource = (await Bun.file(resolve(
      import.meta.dir,
      "../.github/workflows/release-rc.yml",
    )).text()).replaceAll("\r\n", "\n");
    expect(() => assertProtectedReleaseWorkflow(protectedSource)).not.toThrow();
    const prSource = (await Bun.file(resolve(
      import.meta.dir,
      "../.github/workflows/architecture-smoke.yml",
    )).text()).replaceAll("\r\n", "\n");
    expect(prSource).toContain("pull_request:");
    expect(prSource).not.toContain("release-signing");
    expect(prSource).not.toContain("secrets.");
    expect(prSource).not.toContain("id-token: write");
    expect(prSource).not.toContain("contents: write");
    expect(protectedSource.indexOf("actions/attest-build-provenance@")).toBeLessThan(
      protectedSource.indexOf("bun scripts/validate-final-release.ts"),
    );
    expect(protectedSource.indexOf("bun scripts/validate-final-release.ts")).toBeLessThan(
      protectedSource.indexOf("gh release create"),
    );
    expect(protectedSource).toContain("verify-public-redownload:");
    const bunArchives = new Map([
      ["bun-darwin-aarch64.zip", "d8b96221828ad6f97ac7ac0ab7e95872341af763001e8803e8267652c2652620"],
      ["bun-darwin-x64-baseline.zip", "3e35ad6f53971a9834bf9e6786e2adf72b5f1921cc9a9c5fde073d2972944076"],
      ["bun-linux-aarch64.zip", "a27ffb63a8310375836e0d6f668ae17fa8d8d18b88c37c821c65331973a19a3b"],
      ["bun-linux-x64-baseline.zip", "a063908ae08b7852ca10939bbdc6ceed3ddabce8fb9402dce83d65d73b36e6c7"],
      ["bun-windows-x64-baseline.zip", "538f9c846355d9e847b2671bc00c47da4229a0befb24df3282b739770f3b475f"],
    ]);
    for (const source of [protectedSource, prSource]) {
      expect(source).not.toContain("oven-sh/setup-bun");
      for (const [archive, sha256] of bunArchives) {
        expect(source).toContain(archive);
        expect(source).toContain(sha256);
        for (const match of source.matchAll(new RegExp(archive.replaceAll(".", "\\."), "g"))) {
          expect(source.slice(match.index, match.index + archive.length + 180)).toContain(sha256);
        }
      }
      for (const job of source.split(/\n(?=  [a-z][a-z0-9-]+:\n)/)) {
        if (/\b(?:bun install|bun run|bun scripts\/)/.test(job)) {
          expect(job).toContain("install-verified-bun");
        }
      }
    }
    expect(protectedSource).toContain("WORKFLOW_SHA: ${{ github.sha }}");
    expect(protectedSource).toContain('test "$WORKFLOW_SHA" = "$SOURCE_SHA"');
    expect(protectedSource.indexOf('test "$WORKFLOW_SHA" = "$SOURCE_SHA"')).toBeLessThan(
      protectedSource.indexOf("unsigned-build:"),
    );
    for (const job of protectedSource.split(/\n(?=  [a-z][a-z0-9-]+:\n)/)) {
      if (!job.includes("actions/download-artifact@")) continue;
      const restoreIndex = job.indexOf("bun scripts/restore-release-modes.ts");
      expect(restoreIndex).toBeGreaterThan(job.lastIndexOf("actions/download-artifact@"));
      const downstreamIndex = [
        job.indexOf("bun scripts/validate-collected-release.ts"),
        job.indexOf("scripts/sign-macos-release.sh"),
        job.indexOf("scripts/sign-windows-release.ps1"),
        job.indexOf("bun scripts/refresh-signed-release-manifest.ts"),
        job.indexOf("bun scripts/generate-release-metadata.ts"),
      ].filter((index) => index >= 0).sort((left, right) => left - right)[0];
      expect(downstreamIndex).toBeGreaterThan(restoreIndex);
    }
  });
});

describe("signing and provenance evidence", () => {
  test("fails closed for missing signatures and provenance mismatch", () => {
    const root = {
      files: [
        {
          releaseFilename: "helper",
          sha256: "a".repeat(64),
          target: "darwin-arm64",
        },
      ],
      provenance: {
        bunLockSha256: "b".repeat(64),
        bunVersion: "1.3.14",
        sourceCommit: "c".repeat(40),
      },
    } as Parameters<typeof assertSigningAndProvenance>[0];
    expect(() => assertSigningAndProvenance(root, {
      bunLockSha256: "b".repeat(64),
      files: [],
      sourceCommit: "c".repeat(40),
    })).toThrow("signature-evidence-missing");
    expect(() => assertSigningAndProvenance(root, {
      bunLockSha256: "d".repeat(64),
      files: [{
        authenticodeVerified: false,
        codeSignatureVerified: true,
        notarizationVerified: true,
        releaseFilename: "helper",
        sha256: "a".repeat(64),
        timestampVerified: false,
      }],
      sourceCommit: "c".repeat(40),
    })).toThrow("provenance-lockfile-mismatch");
  });

  test.each([
    ["darwin-arm64", "codeSignatureVerified", false, "macos-trust-evidence-missing"],
    ["darwin-arm64", "codeSignatureVerified", undefined, "macos-trust-evidence-missing"],
    ["darwin-arm64", "notarizationVerified", false, "macos-trust-evidence-missing"],
    ["darwin-arm64", "notarizationVerified", undefined, "macos-trust-evidence-missing"],
    ["win32-x64", "authenticodeVerified", false, "windows-trust-evidence-missing"],
    ["win32-x64", "authenticodeVerified", undefined, "windows-trust-evidence-missing"],
    ["win32-x64", "timestampVerified", false, "windows-trust-evidence-missing"],
    ["win32-x64", "timestampVerified", undefined, "windows-trust-evidence-missing"],
    ["linux-x64", "attestationVerified", false, "linux-attestation-evidence-missing"],
    ["linux-x64", "attestationVerified", undefined, "linux-attestation-evidence-missing"],
  ] as const)("rejects %s evidence when %s is %s", (target, field, value, expected) => {
    const root = signingRoot(target);
    const file = {
      attestationVerified: true,
      authenticodeVerified: true,
      codeSignatureVerified: true,
      notarizationVerified: true,
      releaseFilename: "native-file",
      sha256: "a".repeat(64),
      timestampVerified: true,
      [field]: value,
    };
    expect(() => assertSigningAndProvenance(root, signingEvidence([file]))).toThrow(expected);
  });

  test("accepts valid Windows signing and timestamp evidence", () => {
    expect(() => assertSigningAndProvenance(
      signingRoot("win32-x64"),
      signingEvidence([{
        authenticodeVerified: true,
        releaseFilename: "native-file",
        sha256: "a".repeat(64),
        timestampVerified: true,
      }]),
    )).not.toThrow();
  });

  test.each([
    ["digest", [{ releaseFilename: "native-file", sha256: "f".repeat(64), attestationVerified: true }], "signature-evidence-digest-mismatch"],
    ["extra inventory", [
      { releaseFilename: "native-file", sha256: "a".repeat(64), attestationVerified: true },
      { releaseFilename: "unexpected", sha256: "b".repeat(64), attestationVerified: true },
    ], "signature-evidence-inventory-mismatch"],
  ] as const)("rejects %s mismatch", (_case, files, expected) => {
    expect(() => assertSigningAndProvenance(
      signingRoot("linux-x64"),
      signingEvidence([...files]),
    )).toThrow(expected);
  });

  test("accepts final macOS and post-attestation Linux evidence bound to exact bytes", () => {
    const root = {
      files: [
        { releaseFilename: "mac-helper", sha256: "a".repeat(64), target: "darwin-arm64" },
        { releaseFilename: "linux-helper", sha256: "b".repeat(64), target: "linux-x64" },
        { releaseFilename: "model", sha256: "c".repeat(64), target: null },
      ],
      provenance: {
        bunLockSha256: "d".repeat(64),
        bunVersion: "1.3.14",
        sourceCommit: "e".repeat(40),
      },
    } as Parameters<typeof assertSigningAndProvenance>[0];
    expect(() => assertSigningAndProvenance(root, {
      bunLockSha256: "d".repeat(64),
      files: [
        {
          codeSignatureVerified: true,
          notarizationVerified: true,
          releaseFilename: "mac-helper",
          sha256: "a".repeat(64),
        },
        {
          attestationVerified: true,
          releaseFilename: "linux-helper",
          sha256: "b".repeat(64),
        },
      ],
      sourceCommit: "e".repeat(40),
    })).not.toThrow();
  });
});

function signingRoot(target: "darwin-arm64" | "linux-x64" | "win32-x64") {
  return {
    files: [{ releaseFilename: "native-file", sha256: "a".repeat(64), target }],
    provenance: {
      bunLockSha256: "b".repeat(64),
      bunVersion: "1.3.14",
      sourceCommit: "c".repeat(40),
    },
  } as Parameters<typeof assertSigningAndProvenance>[0];
}

function signingEvidence(
  files: Parameters<typeof assertSigningAndProvenance>[1]["files"],
): Parameters<typeof assertSigningAndProvenance>[1] {
  return {
    bunLockSha256: "b".repeat(64),
    files,
    sourceCommit: "c".repeat(40),
  };
}
