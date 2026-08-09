# kokoro-cli

`kokoro-cli` speaks one quoted text argument through the macOS default audio
output. It uses the q8 CPU build of
`onnx-community/Kokoro-82M-v1.0-ONNX`, voice `af_heart`, and speed `1.0`, then
waits for `/usr/bin/afplay` to finish before exiting.

This version supports only Apple silicon (`arm64`) macOS on the current build
host. It is not a universal or cross-platform binary. The interface deliberately
has no flags, stdin mode, or output-file mode.

## Run from source

Install exactly [Bun 1.3.14](https://bun.sh), then install dependencies and pass
the text as one shell argument:

```bash
bun install
bun index.ts "How was your day?"
```

The quotes keep a multiword utterance in one argument. Missing text, whitespace-only
text, or additional arguments fail before the model loads.

## Build and run the executable

Build on the Apple silicon Mac where the executable will run:

```bash
bun run build
./dist/kokoro-cli "How was your day?"
```

The build produces:

- `dist/kokoro-cli`: the standalone current-host executable. The verified build
  is 126,092,642 bytes (about 120 MiB).
- `dist/embedded-voices.manifest.json`: a build-audit manifest; the executable
  does not need this file at runtime.

The executable embeds the CLI and Kokoro code, all 54 voice `.bin` files from
the pinned `kokoro-js` package, and the Apple silicon ONNX host native runtime.
It runs without Bun, project `node_modules`, or persistent native sidecars. The
q8 model weights are downloaded and cached; they are not embedded in the binary.

## First run and model cache

The first valid invocation reports model loading and downloads on stderr while
it populates:

```text
~/Library/Caches/kokoro-cli/transformers
```

In a fresh cold-cache measurement on 2026-08-08, the four cached artifacts—the
q8 ONNX model plus its config and tokenizer JSON files—used approximately 96 MiB
on disk. Treat this as a dated estimate because upstream artifacts and filesystem
allocation can change.

Later runs reuse the complete cache instead of downloading the same artifacts,
and a warmed cache supports offline reuse. If the cache becomes incomplete or
corrupt, quit the CLI and delete only
`~/Library/Caches/kokoro-cli/transformers` (for example, with Finder's **Go to
Folder**). The next invocation recreates that directory and downloads the model
artifacts again.

## Verification

Run the focused gates with Bun 1.3.14:

```bash
bun run typecheck
bun run test
bun run smoke:model-cache
bun run build
bun run smoke:standalone
```

`bun run test` is the default offline suite. `smoke:model-cache` is the opt-in
network check for cold q8 download and warm offline reuse. After a build,
`smoke:standalone` checks the executable in a clean temporary directory, including
embedded voices, cold and warm inference, native-library paths, playback, and
the absence of persistent sidecars.

Finally, run both playback paths in a normal logged-in Mac audio session:

```bash
bun index.ts "Source playback check."
./dist/kokoro-cli "Compiled playback check."
```

The automated/focused behavior checks, q8 cold and warm synthesis, compiled
asset checks, native-path isolation, and sidecar cleanup passed on 2026-08-08.
`/usr/bin/afplay` was invoked and awaited, but the verification host returned
`AudioQueueStart failed (-1)` even outside the sandbox. That is an audible-check
gap on the execution host, not skipped playback; confirm the two commands above
on a Mac with an active audio session.
