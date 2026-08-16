# Releasing the Kokoro speech pack

No release may be published from Phase 1. This document records gates for a
later release phase; it does not authorize a release or replace the source
implementation plan.

## Current decision

**BLOCKED.** The installed phonemizer artifact contains eSpeak-derived compiled
JavaScript/data but does not match the plan's WASM description. Its exact
preferred source, build scripts, GPL notices, corresponding source, and usable
source/relink path have not been demonstrated. Windows app-local runtime
redistribution, macOS signing/notarization, Windows Authenticode credentials,
and minimum-host validation are also unresolved.

## Required compliance gate

- Map every final runtime/shared file to an upstream source pin, license,
  copyright notice, digest, size, and target.
- Reproduce the phonemizer payload from reviewed source and provide all GPL
  corresponding-source/relink material with the release.
- Include the complete GPL-3.0-or-later terms, third-party license texts,
  notices, the helper source and patches, and any required object/relink files.
- Resolve model/training-data attribution and Bun/JavaScriptCore obligations.
- Establish the exact Windows Visual C++ runtime file set and redistribution
  terms. If it cannot be shipped legally and loaded on a clean host, do not
  publish the Windows target.
- Run a release payload scan that rejects ONNX inference WASM (`ort-wasm*`),
  CUDA/provider libraries, voices other than `af_heart`, and unrelated target
  runtimes.

## Required technical and trust gate

- Validate the canonical contract and fixtures under `protocol/v1` in both
  producer and consumer repositories byte-for-byte.
- Assemble and run the pack in an arbitrary path containing spaces and Unicode
  with no Bun, Node, `node_modules`, system player command, cache, or network.
- Pass native sidecar, q8/`af_heart`, bounded protocol, cancellation, playback,
  artifact, and clean-host tests on macOS x64/arm64, Linux x64/arm64, and
  Windows x64.
- Sign helper/addon/libraries/player inside-out on macOS and notarize the
  payload; Authenticode-sign and timestamp Windows executables and DLLs.
- Generate per-file hashes, byte sizes, modes, attestations, and catalog input
  from the exact immutable release bytes. Do not resolve `latest`.
- Confirm all plan quality, latency, reliability, memory, platform-floor, and
  size gates. Audible hardware output remains a real-host manual gate.

Only a later release branch may create an immutable release candidate. Stable
publication remains blocked until that candidate passes the real `llm-now`
installer/client compatibility matrix.
