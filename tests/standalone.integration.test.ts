import { expect, test } from "bun:test";

import { buildStandalone } from "../build";
import { verifyStandalone } from "../scripts/verify-standalone";

const integrationEnabled = process.env.KOKORO_STANDALONE_TEST === "1";

test.skipIf(!integrationEnabled)(
  "compiled executable synthesizes a multilingual voice with English phonemes",
  async () => {
    await buildStandalone();
    const result = await verifyStandalone();

    expect(result.binaryBytes).toBeGreaterThan(0);
    expect(result.cold.stdout).toBe("");
    expect(result.cold.stderr).toContain("Loading Kokoro q8 model");
    expect(result.cold.stderr).toContain("Downloading onnx/model_quantized.onnx");
    expect(result.warm.stdout).toBe("");
    expect(result.warm.stderr).toContain("Loading Kokoro q8 model");
    expect(result.warm.stderr).not.toContain("Downloading ");
    expect(result.sidecars).toEqual([]);
    expect(result.pathAudit).toBe("verified");
  },
  600_000,
);
