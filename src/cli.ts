import {
  EMBEDDED_VOICE_MANIFEST,
  FRENCH_VOICE_FOR_ENGLISH,
  installEmbeddedVoiceProvider,
  type SupportedVoiceName,
  verifyEmbeddedVoices,
} from "./embedded-voices";
import { errorMessage } from "./error-message";
import { ADDON_NAME, prepareNativeRuntime } from "./native-runtime";
import { playAudio, type SavableAudio } from "./playback";

const VOICE_SELF_CHECK_VARIABLE = "KOKORO_STANDALONE_VOICE_SELF_CHECK";

export const DEFAULT_VOICE: SupportedVoiceName = "af_heart";
export const SUPPORTED_VOICES = Object.freeze(
  Object.keys(EMBEDDED_VOICE_MANIFEST).filter(isSupportedVoice),
);
const USAGE = 'Usage: kokoro-cli [--voice <voice>] "text to speak"';
export const HELP_TEXT = `${USAGE}

Speak text with the Kokoro q8 model.

Options:
  --voice <voice>  Select an embedded voice (default: ${DEFAULT_VOICE})
  --help           Show this help

Voice examples: af_heart, af_bella, am_adam, bf_emma, ff_siwis
${SUPPORTED_VOICES.length} voices are available. ff_siwis uses English pronunciation with French timbre.`;

interface PreparedRuntime {
  cleanup(): Promise<void>;
}

interface VoiceSelfCheckResult {
  status: "ok";
  voiceCount: number;
  hasAfHeart: boolean;
}

export interface CliDependencies {
  installVoiceProvider?: () => () => void;
  verifyVoices?: () => Promise<string[]>;
  prepareRuntime?: () => Promise<PreparedRuntime>;
  synthesize?: (
    text: string,
    voice: SupportedVoiceName,
  ) => Promise<SavableAudio>;
  play?: (audio: SavableAudio) => Promise<void>;
  getEnvironment?: (name: string) => string | undefined;
  writeSelfCheck?: (result: VoiceSelfCheckResult) => void;
  writeOutput?: (message: string) => void;
  reportError?: (message: string) => void;
}

export type CliCommand =
  | { kind: "help" }
  | { kind: "speak"; text: string; voice: SupportedVoiceName };

export function parseCliArguments(arguments_: string[]): CliCommand {
  if (arguments_.length === 1 && arguments_[0] === "--help") {
    return { kind: "help" };
  }

  let text: string | undefined;
  let voice: string = DEFAULT_VOICE;
  let hasVoiceOption = false;

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

  return { kind: "speak", text, voice };
}

function isSupportedVoice(voice: string): voice is SupportedVoiceName {
  return (
    voice === FRENCH_VOICE_FOR_ENGLISH ||
    ((voice.startsWith("a") || voice.startsWith("b")) &&
      Object.hasOwn(EMBEDDED_VOICE_MANIFEST, voice))
  );
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

  const { text, voice } = command;
  const getEnvironment =
    dependencies.getEnvironment ?? ((name: string) => process.env[name]);
  const selfCheck = getEnvironment(VOICE_SELF_CHECK_VARIABLE) === "1";
  const installVoiceProvider =
    dependencies.installVoiceProvider ?? installEmbeddedVoiceProvider;
  const restoreVoiceProvider = installVoiceProvider();
  let runtime: PreparedRuntime | undefined;

  try {
    if (selfCheck) {
      const voices = await (dependencies.verifyVoices ?? verifyEmbeddedVoices)();
      const result: VoiceSelfCheckResult = {
        status: "ok",
        voiceCount: voices.length,
        hasAfHeart: voices.includes("af_heart"),
      };
      (dependencies.writeSelfCheck ?? writeSelfCheck)(result);
      return;
    }

    runtime = await (dependencies.prepareRuntime ?? prepareInferenceRuntime)();
    const audio = await (dependencies.synthesize ?? synthesize)(text, voice);
    await (dependencies.play ?? playAudio)(audio);
  } finally {
    try {
      await runtime?.cleanup();
    } finally {
      restoreVoiceProvider();
    }
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

async function prepareInferenceRuntime(): Promise<PreparedRuntime> {
  const hasEmbeddedNativeRuntime = Bun.embeddedFiles.some(
    (file) => (file as Blob & { name: string }).name === ADDON_NAME,
  );

  if (!hasEmbeddedNativeRuntime) {
    return { cleanup: async () => {} };
  }

  return prepareNativeRuntime();
}

async function synthesize(
  text: string,
  voice: SupportedVoiceName,
): Promise<SavableAudio> {
  if (process.env.KOKORO_OFFLINE === "1") {
    const { env } = await import("@huggingface/transformers");
    env.allowRemoteModels = false;
  }

  const { synthesizeSpeech } = await import("./tts");
  return synthesizeSpeech(text, voice);
}

function writeSelfCheck(result: VoiceSelfCheckResult): void {
  console.log(JSON.stringify(result));
}
