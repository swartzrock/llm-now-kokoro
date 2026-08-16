import { chmod, cp, mkdir, readdir, rm } from "node:fs/promises";
import { basename, relative, resolve } from "node:path";

import {
  resolveBunCompileTarget,
  resolveRuntimeTarget,
  SUPPORTED_RUNTIME_TARGETS,
} from "../src/backend";
import {
  verifyLocalModelAssets,
  verifyPinnedPhonemizerBundle,
} from "../src/model-assets";
import { ADDON_NAME } from "../src/native-runtime";
import { assertInferenceArtifactPolicy } from "./artifact-policy";
import {
  ARCHITECTURE_ASSET_ROOT,
  ARCHITECTURE_CACHE_ROOT,
  MINIAUDIO_HEADER_PATH,
  verifyArchitectureAssets,
} from "./architecture-assets";
import { omitUnusedSharpPlugin } from "./build-plugins";

export const ARCHITECTURE_DIST_ROOT = resolve(
  import.meta.dir,
  "../dist/architecture-smoke",
);
export const ARCHITECTURE_INSTALL_ROOT = resolve(
  ARCHITECTURE_DIST_ROOT,
  "installed pack ユニコード",
);
export const ARCHITECTURE_RUNTIME_ROOT = resolve(
  ARCHITECTURE_INSTALL_ROOT,
  "runtime/onnx",
);
export const ARCHITECTURE_HELPER_PATH = resolve(
  ARCHITECTURE_INSTALL_ROOT,
  process.platform === "win32" ? "llm-now-kokoro.exe" : "llm-now-kokoro",
);
export const ARCHITECTURE_PLAYER_PATH = resolve(
  ARCHITECTURE_INSTALL_ROOT,
  "runtime",
  process.platform === "win32"
    ? "llm-now-kokoro-player.exe"
    : "llm-now-kokoro-player",
);

const TARGET = `${process.platform}-${process.arch}`;
const SUPPORTED_TARGETS = new Set<string>(SUPPORTED_RUNTIME_TARGETS);

export async function buildArchitectureSmoke(): Promise<void> {
  if (Bun.version !== "1.3.14") {
    throw new Error(`Bun 1.3.14 is required; found ${Bun.version}`);
  }
  if (!SUPPORTED_TARGETS.has(TARGET)) {
    throw new Error(`Unsupported architecture-smoke target: ${TARGET}`);
  }
  const expectedTarget = process.env.KOKORO_EXPECTED_TARGET;
  if (expectedTarget && expectedTarget !== TARGET) {
    throw new Error(
      `Runner target mismatch: expected ${expectedTarget}, found ${TARGET}`,
    );
  }

  await verifyArchitectureAssets();
  await verifyPinnedPhonemizerBundle(resolve(import.meta.dir, ".."));
  await rm(ARCHITECTURE_DIST_ROOT, { recursive: true, force: true });
  await mkdir(ARCHITECTURE_RUNTIME_ROOT, { recursive: true });
  await Promise.all([
    copyNativeRuntime(),
    cp(
      resolve(ARCHITECTURE_ASSET_ROOT, "model"),
      resolve(ARCHITECTURE_INSTALL_ROOT, "model"),
      { recursive: true },
    ),
    buildPlayer(),
  ]);

  const result = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "../index.ts")],
    compile: {
      target: resolveBunCompileTarget(),
      outfile: ARCHITECTURE_HELPER_PATH,
      autoloadBunfig: false,
      autoloadDotenv: false,
      autoloadPackageJson: false,
      autoloadTsconfig: false,
    },
    minify: true,
    plugins: [
      omitUnusedSharpPlugin(
        "architecture-smoke-sharp",
        "Sharp is unavailable in the TTS helper",
      ),
    ],
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
  await verifyLocalModelAssets(ARCHITECTURE_INSTALL_ROOT);
  assertInferenceArtifactPolicy(
    await listRelativeFiles(ARCHITECTURE_INSTALL_ROOT),
  );
}

async function copyNativeRuntime(): Promise<void> {
  const sourceRoot = resolve(
    import.meta.dir,
    `../node_modules/onnxruntime-node/bin/napi-v3/${process.platform}/${process.arch}`,
  );
  const names = [ADDON_NAME, resolveRuntimeTarget().libraryName];

  for (const name of names) {
    await cp(resolve(sourceRoot, name), resolve(ARCHITECTURE_RUNTIME_ROOT, name));
  }
}

async function listRelativeFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
      } else if (entry.isFile()) {
        files.push(relative(root, path).replaceAll("\\", "/"));
      } else {
        throw new Error("Unsupported architecture artifact entry");
      }
    }
  }
  await walk(root);
  return files;
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
            "-mmacosx-version-min=13.0",
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
