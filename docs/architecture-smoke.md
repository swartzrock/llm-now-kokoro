# Native architecture smoke

This pre-implementation gate proves the Phase 1 process and packaging boundary
before the helper protocol is rewritten. It is intentionally not a public CLI.

The smoke build compiles a Bun executable, copies only the current target's CPU
ONNX addon and colocated runtime library to a real runtime directory, loads the
q8 model and `af_heart` from a pinned local asset tree with remote models
disabled, synthesizes one fixed phrase, and pipes the resulting bounded WAV to
the proposed miniaudio player. CI uses the player's silent validation mode;
`bun run smoke:architecture -- --play` exercises the audio device locally.

The preparation command is build/test tooling, not helper behavior. It fetches
only the model files at revision
`1939ad2a8e416c0acfeecc08a694d14ef25f2231` and miniaudio at commit
`350784a9467a79d0fa65802132668e5afbcf3777`, then enforces their fixed sizes and
SHA-256 digests. The compiled helper itself has no download operation or remote
fallback.

The GitHub Actions matrix runs natively on macOS x64, macOS arm64, Linux x64,
Linux arm64, and Windows x64. It checks the real runner architecture, compiles
both processes on that host, runs native q8 inference, and invokes the bundled
player without relying on a system audio command.
