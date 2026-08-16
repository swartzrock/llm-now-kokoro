import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import { MAX_AUDIO_SAMPLES, MAX_NON_SPECIAL_TOKENS } from "./limits";
import {
  createNativeHelperDependencies,
  createNativeSpeechEngine,
  type SpeechEngineDependencies,
} from "./tts";

const signal = new AbortController().signal;
const voiceProviderSymbol = Symbol.for("kokoro-js.voice-provider");

function mockDependencies(options: {
  audioSamples?: number;
  tokenLength?: number;
} = {}) {
  const events: unknown[] = [];
  const environment = {
    allowLocalModels: false,
    allowRemoteModels: true,
    localModelPath: "/untrusted",
    useBrowserCache: true,
    useFSCache: true,
  };
  const inputIds = { dims: [1, options.tokenLength ?? 7] };
  const model = {
    tokenizer: (phonemes: string, tokenizerOptions: { truncation: false }) => {
      events.push(["tokenize", phonemes, tokenizerOptions]);
      return { input_ids: inputIds };
    },
    generate_from_ids: async (
      receivedIds: typeof inputIds,
      generateOptions: { voice: "af_heart"; speed: 1 },
    ) => {
      events.push(["infer", receivedIds, generateOptions]);
      const samples = new Float32Array(options.audioSamples ?? 2);
      return {
        audio: samples,
        sampling_rate: 24_000,
        toWav: () => new Uint8Array([82, 73, 70, 70]).buffer,
      };
    },
  };
  const dependencies: SpeechEngineDependencies = {
    verifyAssets: async (packRoot) => {
      events.push(["verify", packRoot]);
    },
    prepareRuntime: async (packRoot) => {
      events.push(["runtime", packRoot]);
    },
    verifyPlayer: async (packRoot) => {
      events.push(["player", packRoot]);
    },
    play: async (audio, packRoot, _signal, options) => {
      events.push(["play", packRoot, audio.sampleCount, options?.checkOnly ?? false]);
    },
    readVoice: async (path) => {
      events.push(["voice", path]);
      return new ArrayBuffer(4);
    },
    loadLibraries: async () => {
      events.push(["load"]);
      return {
        env: environment,
        phonemize: async (text: string, language: "a") => {
          events.push(["phonemize", text, language]);
          return "həlˈoʊ";
        },
        loadTokenizer: async (modelId) => {
          events.push(["tokenizer", modelId]);
          return model.tokenizer;
        },
        fromPretrained: async (modelId, modelOptions) => {
          events.push(["model", modelId, modelOptions]);
          return model;
        },
      };
    },
  };
  return { dependencies, environment, events, inputIds };
}

describe("native local-only speech engine", () => {
  test("loads verified files and sidecars before importing a fixed q8 CPU model", async () => {
    const { dependencies, environment, events } = mockDependencies();
    const packRoot = resolve("/packs/with spaces/Unicode ✓");
    const engine = await createNativeSpeechEngine(
      packRoot,
      dependencies,
    );

    expect(events.slice(0, 5)).toEqual([
      ["verify", packRoot],
      ["runtime", packRoot],
      ["player", packRoot],
      ["load"],
      ["tokenizer", "model"],
    ]);
    expect(environment).toEqual({
      allowLocalModels: true,
      allowRemoteModels: false,
      localModelPath: packRoot,
      useBrowserCache: false,
      useFSCache: false,
    });

    const provider = (
      globalThis as typeof globalThis & Record<symbol, unknown>
    )[voiceProviderSymbol] as (voice: string) => Promise<ArrayBuffer>;
    await provider("af_heart");
    await expect(provider("af_bella")).rejects.toThrow("unsupported-voice");
    expect(events).toContainEqual([
      "voice",
      resolve(packRoot, "model/voices/af_heart.bin"),
    ]);

    const analysis = await engine.inspectText("Hello", signal);
    const audio = await engine.synthesize(analysis, signal);
    expect(analysis.nonSpecialTokenCount).toBe(5);
    expect(audio).toEqual({
      bytes: new Uint8Array([82, 73, 70, 70]),
      sampleCount: 2,
    });
    expect(events).toContainEqual(["phonemize", "Hello", "a"]);
    expect(events).toContainEqual([
      "tokenize",
      "həlˈoʊ",
      { truncation: false },
    ]);
    expect(events).toContainEqual([
      "infer",
      analysis.synthesisInput,
      { voice: "af_heart", speed: 1 },
    ]);
    expect(events).toContainEqual([
      "model",
      "model",
      { device: "cpu", dtype: "q8" },
    ]);
  });

  test("uses generate_from_ids and has no generate text path", async () => {
    const { dependencies, events } = mockDependencies();
    const engine = await createNativeSpeechEngine("/pack", dependencies);
    const analysis = await engine.inspectText("text never reaches ONNX", signal);
    await engine.synthesize(analysis, signal);

    expect(events.filter((event) => (event as unknown[])[0] === "infer")).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain("truncation\":true");
  });

  test("reports 509 non-special tokens without truncating", async () => {
    const { dependencies, events } = mockDependencies({
      tokenLength: MAX_NON_SPECIAL_TOKENS + 2,
    });
    const engine = await createNativeSpeechEngine("/pack", dependencies);
    const analysis = await engine.inspectText("boundary", signal);

    expect(analysis.nonSpecialTokenCount).toBe(MAX_NON_SPECIAL_TOKENS);
    expect(events).toContainEqual([
      "tokenize",
      "həlˈoʊ",
      { truncation: false },
    ]);
  });

  test("rejects over-limit tokens before native inference", async () => {
    const { dependencies, events } = mockDependencies({
      tokenLength: MAX_NON_SPECIAL_TOKENS + 3,
    });
    const engine = await createNativeSpeechEngine("/pack", dependencies);
    const analysis = await engine.inspectText("expanded", signal);

    await expect(engine.synthesize(analysis, signal)).rejects.toThrow(
      "invalid-synthesis-input",
    );
    expect(events.some((event) => (event as unknown[])[0] === "infer")).toBe(false);
    expect(events.some((event) => (event as unknown[])[0] === "model")).toBe(false);
  });

  test("rejects audio longer than 1,800,000 samples", async () => {
    const { dependencies } = mockDependencies({
      audioSamples: MAX_AUDIO_SAMPLES + 1,
    });
    const engine = await createNativeSpeechEngine("/pack", dependencies);
    const analysis = await engine.inspectText("long", signal);

    await expect(engine.synthesize(analysis, signal)).rejects.toThrow(
      "audio-sample-limit",
    );
  });

  test("reuses one verified native model across sequential calls", async () => {
    const { dependencies, events } = mockDependencies();
    const helper = createNativeHelperDependencies("/pack", dependencies);
    await helper.preflight!(signal);
    for (const text of ["first", "second"]) {
      const analysis = await helper.inspectText!(text, signal);
      await helper.synthesize!(analysis, signal);
    }

    expect(events.filter((event) => (event as unknown[])[0] === "model")).toHaveLength(1);
    expect(events.filter((event) => (event as unknown[])[0] === "infer")).toHaveLength(2);
  });

  test("preflight verifies fixed files and sidecars without starting ONNX", async () => {
    const { dependencies, events } = mockDependencies();
    const helper = createNativeHelperDependencies("/pack", dependencies);

    await helper.preflight!(signal);

    expect(events).toEqual([
      ["verify", "/pack"],
      ["runtime", "/pack"],
      ["player", "/pack"],
    ]);
  });

  test("silent self-test executes fixed synthesis and clears its WAV bytes", async () => {
    const { dependencies, events } = mockDependencies();
    const helper = createNativeHelperDependencies("/pack", dependencies);
    await helper.selfTest!(signal);

    expect(events).toContainEqual([
      "phonemize",
      "Native speech engine self test.",
      "a",
    ]);
    expect(events.filter((event) => (event as unknown[])[0] === "infer")).toHaveLength(1);
    expect(events).toContainEqual(["play", "/pack", 2, true]);
  });

  test("normal helper playback uses the same synthesized WAV without check mode", async () => {
    const { dependencies, events } = mockDependencies();
    const helper = createNativeHelperDependencies("/pack", dependencies);
    const analysis = await helper.inspectText!("Hello", signal);
    const audio = await helper.synthesize!(analysis, signal);
    await helper.play!(audio, signal);

    expect(events).toContainEqual(["play", "/pack", 2, false]);
    expect(events.filter((event) => (event as unknown[])[0] === "infer")).toHaveLength(1);
  });
});
