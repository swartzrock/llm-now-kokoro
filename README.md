# llm-now-kokoro

`llm-now-kokoro` builds the optional Kokoro speech pack used internally by
`llm-now`. It is not a second user-facing CLI, is not installed on `PATH`, and
does not download or update models at runtime.

The v1 helper uses native ONNX Runtime CPU inference, the q8
`onnx-community/Kokoro-82M-v1.0-ONNX` model, all 55 voice assets at the pinned
model revision, and speed `1.0`. `af_heart` remains the default. ONNX inference
through WebAssembly, GPU use, streaming synthesis, a daemon, installers, and a
public standalone command are outside this repository phase.

## Internal protocol

The helper exposes only the versioned `info`, silent `self-test`, and `speak`
operations. Protocol controls are fixed argv fields. `speak` reads one bounded
UTF-8 JSON object from stdin; answer text is forbidden from argv, environment
variables, filenames, diagnostics, and the info response. Successful
`self-test` and `speak` produce no output.

`speak` accepts an optional `voice`. The selected voice also selects its
pronunciation language: American English (`a*`), British English (`b*`),
Spanish (`e*`), French (`f*`), Hindi (`h*`), Italian (`i*`), Japanese (`j*`),
Portuguese (`p*`), or Mandarin Chinese (`z*`). For French, use `ff_siwis`:

```bash
cd "/absolute/path/to/installed pack"
printf '%s' '{"text":"Bonjour, comment allez-vous ?","voice":"ff_siwis"}' \
  | ./llm-now-kokoro speak --protocol-major 1
```

Omit `voice` to use `af_heart`. Run
`./llm-now-kokoro info --protocol-major 1` to read the exact `voices` allowlist.

The normative machine-readable contract and golden fixtures are under
[`protocol/v1`](protocol/v1). `llm-now` will be the only supported caller and
must require protocol major `1` plus every capability it depends on.

## Development

Use exactly Bun 1.3.14:

```bash
ONNXRUNTIME_NODE_INSTALL_CUDA=skip bun install --frozen-lockfile
bun test src/protocol.test.ts src/voices.test.ts src/cli.test.ts src/compliance.test.ts
bun run typecheck
bun run smoke:offline -- "/absolute/assembled/pack root"
bun run smoke:architecture
```

Pass an assembled pack root to `smoke:offline`; it replaces `fetch` with a hard
failure and performs fixed q8 inference from installed files. The
architecture smoke is test scaffolding for a fixed, non-user phrase. It does
not establish a general CLI surface. Model preparation may use the network only
in build or CI setup; the installed helper never may.

## Release status

No release is authorized from Phase 1. The code is GPL-3.0-or-later while the
eSpeak-derived phonemizer remains in the payload. Redistribution review,
corresponding-source/relink materials, five-target runtime inventories,
macOS signing/notarization, Windows signing/runtime redistribution, and the
remaining gates in [`docs/RELEASING.md`](docs/RELEASING.md) must be complete
before publication.
