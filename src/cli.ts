import {
  EMBEDDED_VOICE_MANIFEST,
  installEmbeddedVoiceProvider,
  type SupportedVoiceName,
  verifyEmbeddedVoices,
} from "./embedded-voices";
import type { InferenceBackend, PreparedRuntime } from "./backend";
import { errorMessage } from "./error-message";
import { ADDON_NAME, prepareNativeRuntime } from "./native-runtime";
import { playAudio, type SavableAudio } from "./playback";
import { prepareWasmRuntime } from "./wasm-runtime";

const VOICE_SELF_CHECK_VARIABLE = "KOKORO_STANDALONE_VOICE_SELF_CHECK";

export const DEFAULT_VOICE: SupportedVoiceName = "af_heart";
export const SUPPORTED_VOICES = Object.freeze(
  Object.keys(EMBEDDED_VOICE_MANIFEST) as SupportedVoiceName[],
);
const USAGE = 'Usage: kokoro-cli [--voice <voice>] [--wasm] "text to speak"';
export const HELP_TEXT = `${USAGE}

Speak text with the Kokoro q8 model.

Options:
  --voice <voice>  Select an embedded voice (default: ${DEFAULT_VOICE})
  --wasm           Use WebAssembly instead of the native ONNX runtime
  --help           Show this help

Voice examples: af_heart, bf_emma, ef_dora, ff_siwis, jf_alpha, zf_xiaobei
All ${SUPPORTED_VOICES.length} embedded voices use English pronunciation.`;

interface VoiceSelfCheckResult {
  status: "ok";
  voiceCount: number;
  hasAfHeart: boolean;
}

export interface CliDependencies {
  installVoiceProvider?: () => () => void;
  verifyVoices?: () => Promise<string[]>;
  prepareRuntime?: (backend: InferenceBackend) => Promise<PreparedRuntime>;
  synthesize?: (
    text: string,
    voice: SupportedVoiceName,
    backend: InferenceBackend,
  ) => Promise<SavableAudio>;
  play?: (audio: SavableAudio) => Promise<void>;
  getEnvironment?: (name: string) => string | undefined;
  writeSelfCheck?: (result: VoiceSelfCheckResult) => void;
  writeOutput?: (message: string) => void;
  reportError?: (message: string) => void;
}

export type CliCommand =
  | { kind: "help" }
  | {
      kind: "speak";
      text: string;
      voice: SupportedVoiceName;
      backend: InferenceBackend;
    };

export function parseCliArguments(arguments_: string[]): CliCommand {
  if (arguments_.length === 1 && arguments_[0] === "--help") {
    return { kind: "help" };
  }

  let text: string | undefined;
  let voice: string = DEFAULT_VOICE;
  let hasVoiceOption = false;
  let useWasm = false;

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];

    if (argument === "--voice") {
      if (hasVoiceOption) {
        throw new Error("--voice may only be specified once.");
      }

      const value = arguments_[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error("--voice requires a voice name and one text argument.");
      }

      voice = value;
      hasVoiceOption = true;
      index += 1;
      continue;
    }

    if (argument === "--wasm") {
      if (useWasm) {
        throw new Error("--wasm may only be specified once.");
      }
      useWasm = true;
      continue;
    }

    if (argument?.startsWith("--")) {
      throw new Error(`Unknown option: ${argument}`);
    }
    if (text !== undefined) {
      throw new Error(USAGE);
    }
    text = argument;
  }

  if (hasVoiceOption && text === undefined) {
    throw new Error("--voice requires a voice name and one text argument.");
  }
  if (text === undefined) {
    throw new Error(USAGE);
  }
  if (text.trim().length === 0) {
    throw new Error("Text must contain non-whitespace characters.");
  }
  if (!isSupportedVoice(voice)) {
    throw new Error(`Unknown voice: ${voice}. Run --help for usage.`);
  }

  return {
    kind: "speak",
    text,
    voice,
    backend: useWasm ? "wasm" : "native",
  };
}

function isSupportedVoice(voice: string): voice is SupportedVoiceName {
  return Object.hasOwn(EMBEDDED_VOICE_MANIFEST, voice);
}

export async function runCli(
  arguments_: string[],
  dependencies: CliDependencies = {},
): Promise<void> {
  const command = parseCliArguments(arguments_);
  if (command.kind === "help") {
    (dependencies.writeOutput ?? console.log)(HELP_TEXT);
    return;
  }

  const { text, voice, backend } = command;
  const getEnvironment =
    dependencies.getEnvironment ?? ((name: string) => process.env[name]);
  const selfCheck = getEnvironment(VOICE_SELF_CHECK_VARIABLE) === "1";
  const installVoiceProvider =
    dependencies.installVoiceProvider ?? installEmbeddedVoiceProvider;
  const restoreVoiceProvider = installVoiceProvider();

  if (selfCheck) {
    try {
      const voices = await (dependencies.verifyVoices ?? verifyEmbeddedVoices)();
      const result: VoiceSelfCheckResult = {
        status: "ok",
        voiceCount: voices.length,
        hasAfHeart: voices.includes("af_heart"),
      };
      (dependencies.writeSelfCheck ?? writeSelfCheck)(result);
    } finally {
      restoreVoiceProvider();
    }
    return;
  }

  let runtime: PreparedRuntime | undefined;
  let operationFailed = false;
  let operationError: unknown;

  try {
    runtime = await (dependencies.prepareRuntime ?? prepareInferenceRuntime)(
      backend,
    );
    const audio = await (dependencies.synthesize ?? synthesize)(
      text,
      voice,
      backend,
    );
    await (dependencies.play ?? playAudio)(audio);
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }

  const cleanupErrors: unknown[] = [];
  try {
    await runtime?.cleanup();
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    restoreVoiceProvider();
  } catch (error) {
    cleanupErrors.push(error);
  }

  if (operationFailed) {
    if (cleanupErrors.length > 0) {
      const errors = [operationError, ...cleanupErrors];
      throw new AggregateError(
        errors,
        errors.map(errorMessage).join("; "),
      );
    }
    throw operationError;
  }
  if (cleanupErrors.length === 1) {
    throw cleanupErrors[0];
  }
  if (cleanupErrors.length > 1) {
    throw new AggregateError(cleanupErrors, "Unable to clean CLI resources");
  }
}

export async function runCliMain(
  arguments_: string[],
  dependencies: CliDependencies = {},
): Promise<number> {
  try {
    await runCli(arguments_, dependencies);
    return 0;
  } catch (error) {
    const reportError = dependencies.reportError ?? console.error;
    reportError(`kokoro-cli: ${errorMessage(error)}`);
    return 1;
  }
}

async function prepareInferenceRuntime(
  backend: InferenceBackend,
): Promise<PreparedRuntime> {
  const hasEmbeddedNativeRuntime = Bun.embeddedFiles.some(
    (file) => (file as Blob & { name: string }).name === ADDON_NAME,
  );

  if (backend === "wasm") {
    return prepareWasmRuntime();
  }
  if (hasEmbeddedNativeRuntime) {
    return prepareNativeRuntime();
  }

  return {
    cleanup: async () => {},
  };
}

async function synthesize(
  text: string,
  voice: SupportedVoiceName,
  backend: InferenceBackend,
): Promise<SavableAudio> {
  if (process.env.KOKORO_OFFLINE === "1") {
    const { env } = await import("@huggingface/transformers");
    env.allowRemoteModels = false;
  }

  const { synthesizeSpeech } = await import("./tts");
  return synthesizeSpeech(text, voice, backend);
}

function writeSelfCheck(result: VoiceSelfCheckResult): void {
  console.log(JSON.stringify(result));
}
