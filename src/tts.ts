import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import type {
  HelperDependencies,
  SpeechAnalysis,
  SynthesizedAudio,
} from "./cli";
import {
  FIXED_SPEED,
  FIXED_VOICE,
  FIXED_VOICE_RELATIVE_PATH,
} from "./embedded-voices";
import { MAX_AUDIO_SAMPLES, MAX_NON_SPECIAL_TOKENS } from "./limits";
import { verifyLocalModelAssets } from "./model-assets";
import { prepareNativeRuntime } from "./native-runtime";

const MODEL_ID = "model";
const MODEL_DTYPE = "q8" as const;
const SELF_TEST_TEXT = "Native speech engine self test.";
const VOICE_PROVIDER_SYMBOL = Symbol.for("kokoro-js.voice-provider");

interface TokenIds {
  dims: readonly number[];
}

interface RawAudio {
  audio: Float32Array;
  sampling_rate: number;
  toWav(): ArrayBuffer;
}

interface KokoroModel {
  tokenizer(
    text: string,
    options: { truncation: false },
  ): { input_ids: TokenIds };
  generate_from_ids(
    inputIds: TokenIds,
    options: { voice: typeof FIXED_VOICE; speed: typeof FIXED_SPEED },
  ): Promise<RawAudio>;
}

interface SpeechLibraries {
  env: {
    allowLocalModels: boolean;
    allowRemoteModels: boolean;
    localModelPath: string;
    useBrowserCache: boolean;
    useFSCache: boolean;
  };
  fromPretrained(
    modelId: string,
    options: { device: "cpu"; dtype: typeof MODEL_DTYPE },
  ): Promise<KokoroModel>;
  phonemize(text: string, language: "a"): Promise<string>;
}

export interface NativeSpeechEngine {
  inspectText(text: string, signal: AbortSignal): Promise<SpeechAnalysis>;
  synthesize(
    analysis: SpeechAnalysis,
    signal: AbortSignal,
  ): Promise<SynthesizedAudio>;
}

export interface SpeechEngineDependencies {
  loadLibraries?: () => Promise<SpeechLibraries>;
  prepareRuntime?: (packRoot: string) => Promise<unknown>;
  readVoice?: (path: string) => Promise<ArrayBuffer>;
  verifyAssets?: (packRoot: string) => Promise<void>;
}

export async function createNativeSpeechEngine(
  packRoot = process.cwd(),
  dependencies: SpeechEngineDependencies = {},
): Promise<NativeSpeechEngine> {
  await prepareNativeSpeechPack(packRoot, dependencies);
  return loadPreparedSpeechEngine(packRoot, dependencies);
}

async function prepareNativeSpeechPack(
  packRoot: string,
  dependencies: SpeechEngineDependencies,
): Promise<void> {
  if (!isAbsolute(packRoot)) throw new Error("pack-root-not-absolute");
  await (dependencies.verifyAssets ?? verifyLocalModelAssets)(packRoot);
  await (dependencies.prepareRuntime ?? prepareNativeRuntime)(packRoot);
  installVoiceProvider(
    resolve(packRoot, FIXED_VOICE_RELATIVE_PATH),
    dependencies.readVoice ?? readVoiceFile,
  );
}

async function loadPreparedSpeechEngine(
  packRoot: string,
  dependencies: SpeechEngineDependencies,
): Promise<NativeSpeechEngine> {
  const libraries = await (dependencies.loadLibraries ?? loadSpeechLibraries)();
  libraries.env.allowLocalModels = true;
  libraries.env.allowRemoteModels = false;
  libraries.env.localModelPath = packRoot;
  libraries.env.useBrowserCache = false;
  libraries.env.useFSCache = false;

  let model: KokoroModel;
  try {
    model = await libraries.fromPretrained(MODEL_ID, {
      device: "cpu",
      dtype: MODEL_DTYPE,
    });
  } catch {
    throw new Error("native-model-load-failed");
  }

  return {
    async inspectText(text, signal) {
      throwIfAborted(signal);
      let phonemes: string;
      try {
        phonemes = await libraries.phonemize(text, "a");
      } catch {
        throw new Error("phonemization-failed");
      }
      throwIfAborted(signal);
      let inputIds: TokenIds;
      try {
        ({ input_ids: inputIds } = model.tokenizer(phonemes, {
          truncation: false,
        }));
      } catch {
        throw new Error("tokenization-failed");
      }
      const length = inputIds.dims.at(-1);
      if (!Number.isSafeInteger(length) || length! < 2) {
        throw new Error("tokenization-failed");
      }
      return {
        nonSpecialTokenCount: length! - 2,
        synthesisInput: inputIds,
      };
    },

    async synthesize(analysis, signal) {
      throwIfAborted(signal);
      if (
        analysis.nonSpecialTokenCount > MAX_NON_SPECIAL_TOKENS ||
        !isTokenIds(analysis.synthesisInput)
      ) {
        throw new Error("invalid-synthesis-input");
      }
      let audio: RawAudio;
      try {
        audio = await model.generate_from_ids(analysis.synthesisInput, {
          voice: FIXED_VOICE,
          speed: FIXED_SPEED,
        });
      } catch {
        throw new Error("native-inference-failed");
      }
      throwIfAborted(signal);
      if (
        audio.sampling_rate !== 24_000 ||
        audio.audio.length === 0 ||
        audio.audio.length > MAX_AUDIO_SAMPLES
      ) {
        throw new Error("invalid-audio-result");
      }
      return {
        bytes: new Uint8Array(audio.toWav()),
        sampleCount: audio.audio.length,
      };
    },
  };
}

export function createNativeHelperDependencies(
  packRoot = process.cwd(),
  dependencies: SpeechEngineDependencies = {},
): Pick<
  HelperDependencies,
  "inspectText" | "preflight" | "selfTest" | "synthesize"
> {
  let preflightPromise: Promise<void> | undefined;
  let enginePromise: Promise<NativeSpeechEngine> | undefined;
  const preflight = () =>
    (preflightPromise ??= prepareNativeSpeechPack(packRoot, dependencies));
  const engine = () =>
    (enginePromise ??= preflight().then(() =>
      loadPreparedSpeechEngine(packRoot, dependencies),
    ));

  return {
    preflight: async (signal) => {
      throwIfAborted(signal);
      await preflight();
      throwIfAborted(signal);
    },
    inspectText: async (text, signal) =>
      (await engine()).inspectText(text, signal),
    synthesize: async (analysis, signal) =>
      (await engine()).synthesize(analysis, signal),
    selfTest: async (signal) => {
      const ready = await engine();
      const analysis = await ready.inspectText(SELF_TEST_TEXT, signal);
      if (analysis.nonSpecialTokenCount > MAX_NON_SPECIAL_TOKENS) {
        throw new Error("self-test-input-invalid");
      }
      const audio = await ready.synthesize(analysis, signal);
      audio.bytes.fill(0);
    },
  };
}

async function loadSpeechLibraries(): Promise<SpeechLibraries> {
  const transformers = await import("@huggingface/transformers");
  const kokoro = await import("kokoro-js");
  return {
    env: transformers.env,
    fromPretrained: (modelId, options) =>
      kokoro.KokoroTTS.from_pretrained(modelId, options) as Promise<KokoroModel>,
    phonemize: kokoro.phonemize,
  };
}

function installVoiceProvider(
  path: string,
  readVoice: (path: string) => Promise<ArrayBuffer>,
): void {
  Object.defineProperty(globalThis, VOICE_PROVIDER_SYMBOL, {
    configurable: true,
    value: async (voice: string) => {
      if (voice !== FIXED_VOICE) throw new Error("unsupported-voice");
      try {
        return await readVoice(path);
      } catch {
        throw new Error("voice-asset-unavailable");
      }
    },
  });
}

async function readVoiceFile(path: string): Promise<ArrayBuffer> {
  const bytes = await readFile(path);
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

function isTokenIds(value: unknown): value is TokenIds {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as TokenIds).dims)
  );
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new Error("cancelled");
}
