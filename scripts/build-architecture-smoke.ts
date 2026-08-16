import { chmod, cp, mkdir, rm } from "node:fs/promises";
import { basename, resolve } from "node:path";

import {
  ARCHITECTURE_CACHE_ROOT,
  MINIAUDIO_HEADER_PATH,
  verifyArchitectureAssets,
} from "./architecture-assets";

export const ARCHITECTURE_DIST_ROOT = resolve(
  import.meta.dir,
  "../dist/architecture-smoke",
);
export const ARCHITECTURE_RUNTIME_ROOT = resolve(
  ARCHITECTURE_DIST_ROOT,
  "runtime",
);
export const ARCHITECTURE_HELPER_PATH = resolve(
  ARCHITECTURE_DIST_ROOT,
  process.platform === "win32" ? "llm-now-kokoro-smoke.exe" : "llm-now-kokoro-smoke",
);
export const ARCHITECTURE_PLAYER_PATH = resolve(
  ARCHITECTURE_RUNTIME_ROOT,
  process.platform === "win32" ? "llm-now-kokoro-player.exe" : "llm-now-kokoro-player",
);

const TARGET = `${process.platform}-${process.arch}`;
const SUPPORTED_TARGETS = new Set([
  "darwin-x64",
  "darwin-arm64",
  "linux-x64",
  "linux-arm64",
  "win32-x64",
]);

export async function buildArchitectureSmoke(): Promise<void> {
  if (Bun.version !== "1.3.14") {
    throw new Error(`Bun 1.3.14 is required; found ${Bun.version}`);
  }
  if (!SUPPORTED_TARGETS.has(TARGET)) {
    throw new Error(`Unsupported architecture-smoke target: ${TARGET}`);
  }
  const expectedTarget = process.env.KOKORO_EXPECTED_TARGET;
  if (expectedTarget && expectedTarget !== TARGET) {
    throw new Error(`Runner target mismatch: expected ${expectedTarget}, found ${TARGET}`);
  }

  await verifyArchitectureAssets();
  await rm(ARCHITECTURE_DIST_ROOT, { recursive: true, force: true });
  await mkdir(ARCHITECTURE_RUNTIME_ROOT, { recursive: true });
  await copyNativeRuntime();
  await buildPlayer();

  const result = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "architecture-smoke.ts")],
    compile: { outfile: ARCHITECTURE_HELPER_PATH },
    minify: true,
  });
  if (!result.success) {
    throw new AggregateError(result.logs, "Unable to compile architecture helper");
  }
  const [compiledHelper] = result.outputs;
  if (!compiledHelper || result.outputs.length !== 1) {
    throw new Error(`Expected one compiled helper; found ${result.outputs.length}`);
  }
  if (process.platform !== "win32") {
    await chmod(ARCHITECTURE_HELPER_PATH, 0o755);
  }
}

async function copyNativeRuntime(): Promise<void> {
  const sourceRoot = resolve(
    import.meta.dir,
    `../node_modules/onnxruntime-node/bin/napi-v3/${process.platform}/${process.arch}`,
  );
  const names =
    process.platform === "darwin"
      ? ["onnxruntime_binding.node", "libonnxruntime.1.21.0.dylib"]
      : process.platform === "linux"
        ? ["onnxruntime_binding.node", "libonnxruntime.so.1"]
        : ["onnxruntime_binding.node", "onnxruntime.dll"];

  for (const name of names) {
    await cp(resolve(sourceRoot, name), resolve(ARCHITECTURE_RUNTIME_ROOT, name));
  }
}

async function buildPlayer(): Promise<void> {
  const source = resolve(import.meta.dir, "../native/player.c");
  const includeDirectory = resolve(MINIAUDIO_HEADER_PATH, "..");
  const compilerTemporaryDirectory = resolve(
    ARCHITECTURE_CACHE_ROOT,
    "compiler-tmp",
  );
  await mkdir(compilerTemporaryDirectory, { recursive: true });
  const command =
    process.platform === "win32"
      ? [
          "cl",
          "/nologo",
          "/O2",
          `/I${includeDirectory}`,
          source,
          `/Fe:${ARCHITECTURE_PLAYER_PATH}`,
          "ole32.lib",
          "user32.lib",
          "advapi32.lib",
          "winmm.lib",
        ]
      : process.platform === "darwin"
        ? [
            "cc",
            "-std=c99",
            "-O2",
            `-I${includeDirectory}`,
            source,
            "-o",
            ARCHITECTURE_PLAYER_PATH,
            "-framework",
            "CoreAudio",
            "-framework",
            "AudioToolbox",
            "-framework",
            "Foundation",
            "-lpthread",
            "-lm",
          ]
        : [
            "cc",
            "-std=c99",
            "-O2",
            "-DMA_NO_JACK",
            `-I${includeDirectory}`,
            source,
            "-o",
            ARCHITECTURE_PLAYER_PATH,
            "-ldl",
            "-lpthread",
            "-lm",
          ];

  const child = Bun.spawn(command, {
    env: { ...process.env, TMPDIR: compilerTemporaryDirectory },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(
      `Player compilation failed (${exitCode}): ${(stderr || stdout).slice(0, 2_000)}`,
    );
  }
  if (process.platform !== "win32") {
    await chmod(ARCHITECTURE_PLAYER_PATH, 0o755);
  }

  const unexpected = basename(MINIAUDIO_HEADER_PATH) !== "miniaudio.h";
  if (unexpected || !MINIAUDIO_HEADER_PATH.startsWith(ARCHITECTURE_CACHE_ROOT)) {
    throw new Error("Unexpected miniaudio source location");
  }
}
