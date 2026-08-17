# Releasing the Kokoro speech pack

The release pipeline is fail-closed. It may publish only an immutable
`v0.1.0-rc.N` release candidate from a full commit SHA that is already merged
to `main` through a reviewed pull request. Stable promotion belongs to U10 and
is not performed by this repository workflow.

## Current release decision

**BLOCKED.** This is a NO-GO. Unsigned local validation is useful, but
publication is blocked by:

- missing preferred eSpeak/phonemizer source, reproducible build provenance,
  and a usable relink path for the embedded Emscripten JavaScript/data payload;
- unresolved Bun/JavaScriptCore redistribution and relink obligations;
- incomplete Kokoro model/training-data attribution review;
- unapproved Windows app-local runtime files and redistribution evidence;
- unavailable protected signing identities and native minimum-host evidence;
- the U4 compatibility blockers recorded by each native validation report,
  including the macOS 13.3 native floor versus the declared macOS 13 floor.

`scripts/validate-collected-release.ts` enforces these as publication blockers.
Removing a blocker from documentation is not sufficient; its machine-readable
compliance or native evidence must become complete and the focused tests must
continue to pass.

## Repository settings required before any RC attempt

Create a GitHub Actions environment named exactly `release-signing` and set:

- required reviewers with at least two maintainers eligible to approve;
- deployment branches/tags restricted to the default branch and
  `v0.1.0-rc.*` tags;
- self-approval disabled;
- environment secrets unavailable until review approval;
- branch protection on `main` requiring pull-request review and all unsigned
  native/release checks.

In repository **Settings → General → Releases**, enable **Immutable releases**.
The workflow still checks for an existing tag/release and never uses asset
replacement; the repository setting is the server-side enforcement layer.

The pull-request workflow has only `contents: read`, has no
`release-signing` environment, and references no signing secret. The protected
workflow is manual-only. Only its final publication job receives
`contents: write`, `id-token: write`, and `attestations: write`; build and
signing jobs retain `contents: read`.

Configure these environment secrets, with no values committed:

- `APPLE_DEVELOPER_ID_P12_BASE64`
- `APPLE_DEVELOPER_ID_P12_PASSWORD`
- `APPLE_DEVELOPER_ID_IDENTITY`
- `APPLE_NOTARY_PRIVATE_KEY_BASE64`
- `APPLE_NOTARY_KEY_ID`
- `APPLE_NOTARY_ISSUER_ID`
- `APPLE_NOTARY_TEAM_ID`
- `WINDOWS_CODESIGN_PFX_BASE64`
- `WINDOWS_CODESIGN_PFX_PASSWORD`
- `WINDOWS_RFC3161_TIMESTAMP_URL`

Ownership, rotation, recovery, and compromise response are in
[`SIGNING_KEYS.md`](SIGNING_KEYS.md).

## Compliance and produced files

Every payload manifest entry carries its fixed release filename, logical
destination, runtime/shared class and target, exact bytes, SHA-256, mode,
protocol/capabilities, dependency pins, source revisions, license, and
redistribution obligations. The eSpeak payload embedded in the helper is
listed separately from the native ONNX inference runtime; it is not described
as ONNX WASM.

The protected workflow gathers five runtime sets and one shared set, then
mechanically produces from the final signed bytes:

- the root release manifest and RC catalog input;
- `SHA256SUMS` after signing;
- per-target validation and signing receipts;
- the compliance report;
- the normative contract and fixtures;
- complete GPL terms and third-party notices;
- a source archive, lockfile, patches/build source, and source-offer report.

The source-offer report explicitly records unsupported materials. It is not a
written GPL offer and does not claim the eSpeak relink gate has been resolved.
Publication remains blocked until every shipped file has complete, reviewed
obligations and source/relink material where required.

## Protected RC sequence

1. Merge the implementation pull request after every unsigned target and
   compliance gate is green.
2. Manually dispatch `Protected immutable release candidate` with a new
   `v0.1.0-rc.N` and the merged 40-character source SHA.
3. The workflow proves the SHA is on `main`, is associated with a merged PR,
   and has no existing tag or release.
4. Five native jobs build and validate without access to signing identities.
5. A collected unsigned gate validates inventory, q8/all pinned voices, protocol,
   provenance, native reports, size budgets, and compliance before signing.
6. macOS signs addon/dylibs/player/helper inside-out and submits a build-only
   ZIP to notarization. Individual files are not claimed to be stapled.
7. Windows Authenticode-signs and RFC3161-timestamps every EXE, DLL, and native
   addon, then verifies Windows trust policy. Linux retains exact checksums.
8. Root metadata and final digests are generated only from those signed bytes.
9. GitHub build attestations are created and verified for every final file.
10. The workflow creates the prerelease once. It never uploads with
    `--clobber`; a defect requires a new RC number.
11. Redownload every public asset on representative clean hosts and verify
    byte counts, hashes, signatures/notarization, attestations, catalog
    assembly, blocked-network behavior, and real launch/playback before the RC
    is accepted for consumer work.

Do not rerun publication for an existing tag, replace an asset, resolve
`latest`, call the RC stable, or copy hand-written URLs/hashes into `llm-now`.
Stable catalog generation and promotion happen only after U10 cross-repository
validation.

## Local unsigned validation

Run focused checks without publishing:

```sh
bun run release:test
bun run typecheck
bun run release:validate
```

`release:validate` may report `releaseEligible: false`; that is the expected
honest result while native compatibility evidence is incomplete. A collected
release validation is expected to fail at the first remaining compatibility or
compliance blocker. Signing, tagging, GitHub release creation, and stable
publication are not local validation steps.
