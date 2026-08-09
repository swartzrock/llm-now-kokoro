import { existsSync } from "node:fs";
import { join } from "node:path";

import { env, type ProgressCallback, type ProgressInfo } from "@huggingface/transformers";
import { KokoroTTS } from "kokoro-js";

import { prepareModelCache } from "./cache";
import {
  FRENCH_VOICE_FOR_ENGLISH,
  type SupportedVoiceName,
} from "./embedded-voices";
import { errorMessage } from "./error-message";

const MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";

const MODEL_OPTIONS = {
  dtype: "q8",
  device: "cpu",
} as const;

interface GenerateOptions {
  voice: SupportedVoiceName;
  speed: number;
}

export interface GeneratedAudio {
  audio: Float32Array;
  sampling_rate: number;
  save(path: string): Promise<void>;
}

interface SpeechModel {
  generate(text: string, options: GenerateOptions): Promise<GeneratedAudio>;
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
  isModelFileCached?: (
    cachePath: string,
    modelId: string,
    file: string,
  ) => boolean;
  reportProgress?: (message: string) => void;
}

export async function synthesizeSpeech(
  text: string,
  voice: SupportedVoiceName,
  dependencies: SynthesisDependencies = {},
): Promise<GeneratedAudio> {
  const prepareCache = dependencies.prepareCache ?? prepareModelCache;
  const configureCache = dependencies.configureCache ?? configureTransformersCache;
  const createModel = dependencies.createModel ?? createKokoroModel;
  const isModelFileCached =
    dependencies.isModelFileCached ?? modelFileIsCached;
  const reportProgress = dependencies.reportProgress ?? reportToStderr;
  const cachePath = await prepareCache(dependencies.homeDirectory ?? undefined);

  configureCache(cachePath);
  reportProgress(`Loading Kokoro q8 model (cache: ${cachePath})...`);

  let model: SpeechModel;
  try {
    model = await createModel(MODEL_ID, {
      ...MODEL_OPTIONS,
      progress_callback: createProgressCallback(
        cachePath,
        isModelFileCached,
        reportProgress,
      ),
    });
  } catch (error) {
    throw new Error(
      `Unable to load Kokoro q8 model using cache ${cachePath}: ${errorMessage(error)}`,
    );
  }

  try {
    return await model.generate(text, { voice, speed: 1.0 });
  } catch (error) {
    throw new Error(`Unable to synthesize speech: ${errorMessage(error)}`);
  }
}

async function createKokoroModel(
  modelId: string,
  options: ModelOptions,
): Promise<SpeechModel> {
  const model = await KokoroTTS.from_pretrained(modelId, options);
  const validateVoice = model._validate_voice.bind(model);

  model._validate_voice = (voice: unknown) =>
    voice === FRENCH_VOICE_FOR_ENGLISH ? "a" : validateVoice(voice);

  // kokoro-js 1.2.1 ships ff_siwis.bin but omits it from its public voice type.
  return model as unknown as SpeechModel;
}

function configureTransformersCache(cachePath: string): void {
  env.cacheDir = cachePath;
}

function createProgressCallback(
  cachePath: string,
  isModelFileCached: NonNullable<SynthesisDependencies["isModelFileCached"]>,
  reportProgress: (message: string) => void,
): ProgressCallback {
  return (progress: ProgressInfo) => {
    if (
      progress.status === "download" &&
      !isModelFileCached(cachePath, progress.name, progress.file)
    ) {
      reportProgress(`Downloading ${progress.file}...`);
    } else if (progress.status === "ready") {
      reportProgress("Kokoro q8 model ready.");
    }
  };
}

function modelFileIsCached(
  cachePath: string,
  modelId: string,
  file: string,
): boolean {
  return existsSync(join(cachePath, modelId, file));
}

function reportToStderr(message: string): void {
  console.error(message);
}
