import { env, type ProgressCallback, type ProgressInfo } from "@huggingface/transformers";
import { KokoroTTS } from "kokoro-js";

import { prepareModelCache } from "./cache";

export const MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";

const MODEL_OPTIONS = {
  dtype: "q8",
  device: "cpu",
} as const;

const GENERATE_OPTIONS = {
  voice: "af_heart",
  speed: 1.0,
} as const;

export interface GeneratedAudio {
  audio: Float32Array;
  sampling_rate: number;
  save(path: string): Promise<void>;
}

interface SpeechModel {
  generate(
    text: string,
    options: typeof GENERATE_OPTIONS,
  ): Promise<GeneratedAudio>;
}

interface ModelOptions {
  dtype: typeof MODEL_OPTIONS.dtype;
  device: typeof MODEL_OPTIONS.device;
  progress_callback: ProgressCallback;
}

export interface SynthesisDependencies {
  homeDirectory?: string;
  prepareCache?: (homeDirectory?: string) => Promise<string>;
  configureCache?: (cachePath: string) => void;
  createModel?: (modelId: string, options: ModelOptions) => Promise<SpeechModel>;
  reportProgress?: (message: string) => void;
}

export async function synthesizeSpeech(
  text: string,
  dependencies: SynthesisDependencies = {},
): Promise<GeneratedAudio> {
  const prepareCache = dependencies.prepareCache ?? prepareModelCache;
  const configureCache = dependencies.configureCache ?? configureTransformersCache;
  const createModel = dependencies.createModel ?? KokoroTTS.from_pretrained;
  const reportProgress = dependencies.reportProgress ?? reportToStderr;
  const cachePath = await prepareCache(dependencies.homeDirectory ?? undefined);

  configureCache(cachePath);
  reportProgress(`Loading Kokoro q8 model (cache: ${cachePath})...`);

  let model: SpeechModel;
  try {
    model = await createModel(MODEL_ID, {
      ...MODEL_OPTIONS,
      progress_callback: createProgressCallback(reportProgress),
    });
  } catch (error) {
    throw new Error(
      `Unable to load Kokoro q8 model using cache ${cachePath}: ${errorMessage(error)}`,
    );
  }

  try {
    return await model.generate(text, GENERATE_OPTIONS);
  } catch (error) {
    throw new Error(`Unable to synthesize speech: ${errorMessage(error)}`);
  }
}

function configureTransformersCache(cachePath: string): void {
  env.cacheDir = cachePath;
}

function createProgressCallback(
  reportProgress: (message: string) => void,
): ProgressCallback {
  return (progress: ProgressInfo) => {
    if (progress.status === "download") {
      reportProgress(`Downloading ${progress.file}...`);
    } else if (progress.status === "ready") {
      reportProgress("Kokoro q8 model ready.");
    }
  };
}

function reportToStderr(message: string): void {
  console.error(message);
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split("\n", 1)[0]?.trim() || "unknown error";
}
