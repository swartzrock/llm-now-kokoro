import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { InferenceBackend } from "../src/backend";
import { ADDON_NAME, DYLIB_NAME } from "../src/native-runtime";

const integrationEnabled = process.env.KOKORO_MODEL_CACHE_TEST === "1";
const ttsModulePath = fileURLToPath(new URL("../src/tts.ts", import.meta.url));

async function runSynthesis(
  homeDirectory: string,
  allowRemoteModels: boolean,
  backend: InferenceBackend = "native",
) {
  const script = `
    const backend = ${JSON.stringify(backend)};
    const runtime = backend === "wasm"
      ? await (await import(${JSON.stringify(fileURLToPath(new URL("../src/wasm-runtime.ts", import.meta.url)))})).prepareWasmRuntime()
      : { cleanup: async () => {} };
    try {
      const { env } = await import("@huggingface/transformers");
      const { synthesizeSpeech } = await import(${JSON.stringify(ttsModulePath)});
      env.allowRemoteModels = ${allowRemoteModels};
      const result = await synthesizeSpeech(
        "Model cache integration check.",
        "jf_alpha",
        backend,
        { homeDirectory: process.env.KOKORO_TEST_HOME },
      );
      if (result.audio.length === 0) process.exit(1);
    } finally {
      await runtime.cleanup();
    }
  `;
  const synthesisProcess = Bun.spawn([process.execPath, "--eval", script], {
    env: {
      ...process.env,
      KOKORO_TEST_HOME: homeDirectory,
      ...(backend === "wasm" ? { DYLD_PRINT_LIBRARIES: "1" } : {}),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stderr] = await Promise.all([
    synthesisProcess.exited,
    new Response(synthesisProcess.stderr).text(),
  ]);

  return { exitCode, stderr };
}

test.skipIf(!integrationEnabled)(
  "downloads q8 into an empty cache and reuses it offline in a fresh process",
  async () => {
    const temporaryHome = await mkdtemp(
      join(import.meta.dir, "..", ".tmp-kokoro-model-cache-"),
    );

    try {
      const coldRun = await runSynthesis(temporaryHome, true);
      expect(coldRun.exitCode).toBe(0);
      expect(coldRun.stderr).toContain("Loading Kokoro q8 model");
      expect(coldRun.stderr).toContain("Downloading onnx/model_quantized.onnx");

      const cachePath = join(
        temporaryHome,
        "Library",
        "Caches",
        "kokoro-cli",
        "transformers",
      );
      expect((await readdir(cachePath, { recursive: true })).length).toBeGreaterThan(0);

      const warmRun = await runSynthesis(temporaryHome, false);
      expect(warmRun.exitCode).toBe(0);
      expect(warmRun.stderr).toContain("Loading Kokoro q8 model");
      expect(warmRun.stderr).not.toContain("Downloading ");

      const wasmRun = await runSynthesis(temporaryHome, false, "wasm");
      if (wasmRun.exitCode !== 0) {
        throw new Error(`WASM synthesis failed: ${wasmRun.stderr}`);
      }
      expect(wasmRun.stderr).toContain("Loading Kokoro q8 model");
      expect(wasmRun.stderr).not.toContain("Downloading ");
      expect(wasmRun.stderr).not.toContain(ADDON_NAME);
      expect(wasmRun.stderr).not.toContain(DYLIB_NAME);
    } finally {
      await rm(temporaryHome, { recursive: true, force: true });
    }
  },
  300_000,
);
