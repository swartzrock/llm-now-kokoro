import { describe, expect, test } from "bun:test";

import { synthesizeSpeech } from "./tts";

describe("synthesizeSpeech", () => {
  test("uses the fixed q8 CPU model, af_heart voice, and speed", async () => {
    const events: string[] = [];
    let modelRequest: unknown;
    let synthesisRequest: unknown;
    const output = {
      audio: new Float32Array([0.25]),
      sampling_rate: 24_000,
      save: async () => {},
    };

    const result = await synthesizeSpeech("Hello", {
      homeDirectory: "/Users/alice",
      prepareCache: async () => {
        events.push("prepare-cache");
        return "/Users/alice/Library/Caches/kokoro-cli/transformers";
      },
      configureCache: (cachePath) => {
        events.push(`configure-cache:${cachePath}`);
      },
      createModel: async (modelId, options) => {
        events.push("create-model");
        modelRequest = { modelId, options };
        return {
          generate: async (text, options) => {
            synthesisRequest = { text, options };
            return output;
          },
        };
      },
      reportProgress: (message) => events.push(`progress:${message}`),
    });

    expect(result).toBe(output);
    expect(events.slice(0, 3)).toEqual([
      "prepare-cache",
      "configure-cache:/Users/alice/Library/Caches/kokoro-cli/transformers",
      expect.stringContaining("progress:Loading Kokoro q8 model"),
    ]);
    expect(events[3]).toBe("create-model");
    expect(modelRequest).toEqual({
      modelId: "onnx-community/Kokoro-82M-v1.0-ONNX",
      options: {
        dtype: "q8",
        device: "cpu",
        progress_callback: expect.any(Function),
      },
    });
    expect(synthesisRequest).toEqual({
      text: "Hello",
      options: { voice: "af_heart", speed: 1.0 },
    });
  });

  test("reports a concise model-load error that names the cache", async () => {
    const failure = synthesizeSpeech("Hello", {
      homeDirectory: "/Users/alice",
      prepareCache: async () =>
        "/Users/alice/Library/Caches/kokoro-cli/transformers",
      configureCache: () => {},
      createModel: async () => {
        throw new Error("download failed\n    at internal-loader.ts:42:1");
      },
      reportProgress: () => {},
    });

    await expect(failure).rejects.toThrow(
      "Unable to load Kokoro q8 model using cache /Users/alice/Library/Caches/kokoro-cli/transformers: download failed",
    );

    try {
      await failure;
    } catch (error) {
      expect((error as Error).message).not.toContain("internal-loader.ts");
      expect((error as Error).message).not.toContain("\n");
    }
  });
});
