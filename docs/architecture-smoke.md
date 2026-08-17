# Native architecture smoke

This gate proves the Phase 1 process and packaging boundary using the production
private helper protocol. It is intentionally not a public CLI.

The smoke build compiles the production Bun helper, copies only the current
target's CPU ONNX addon and colocated runtime library to a real runtime
directory, loads the q8 model and all 55 pinned voices from a local asset tree with
remote models disabled, runs the versioned `info` and silent `self-test`
operations from an installed path containing spaces and Unicode, synthesizes a
French phrase with `ff_siwis` through the multilingual phonemizer, and pipes the
resulting bounded WAV to the miniaudio player.
CI uses the player's silent validation mode;
`bun run smoke:architecture -- --play` exercises the audio device locally.

Phonemization and native inference run in a short-lived supervised copy of the
same helper executable. The parent sends the already bounded JSON request only
through that child's stdin, gives it a fixed control-only environment, and can
terminate and reap the native process at a stage deadline even while ONNX is
blocked in native code. The child returns only fixed protocol metadata and the
bounded WAV over Bun IPC; answer text never enters argv, environment variables,
filenames, or diagnostics.

Before signaling readiness, the child repeats Phase 1's model hashes, native
sidecar layout, and player checks. The signed complete-pack manifest plus
root ownership, permission, and link policy belong to U4/U6 and remain a
publication gate; Phase 1 does not treat a pathname as that future verified-pack
capability.

The preparation command is build/test tooling, not helper behavior. It fetches
only the model files at revision
`1939ad2a8e416c0acfeecc08a694d14ef25f2231` and miniaudio at commit
`350784a9467a79d0fa65802132668e5afbcf3777`, then enforces their fixed sizes and
SHA-256 digests. The smoke assembles the exact model tree and exact
current-target runtime tree, then rejects ONNX inference Wasm, CUDA/DirectML,
undeclared voices, unrelated native targets, missing helper/player files, and
undeclared model files. The compiled helper itself has no download operation or
remote fallback.

The GitHub Actions matrix runs natively on macOS x64, macOS arm64, Linux x64,
Linux arm64, and Windows x64. It checks the real runner architecture, compiles
both processes on that host, runs native q8 inference, and invokes the bundled
player without relying on a system audio command.

Hosted CI proves the player executable, stdin decoder, and check path, but it
does not prove audible hardware output. It also does not provide one equivalent
OS-level network namespace across all five hosted targets. Real-device playback
and a network-blocked installed-pack smoke remain required release gates; Phase
1 does not claim those publication gates are complete.
