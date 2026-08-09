import {
  installEmbeddedVoiceProvider,
  verifyEmbeddedVoices,
} from "./embedded-voices";
import { prepareNativeRuntime } from "./native-runtime";
import { playAudio, type SavableAudio } from "./playback";

const VOICE_SELF_CHECK_VARIABLE = "KOKORO_STANDALONE_VOICE_SELF_CHECK";

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
  synthesize?: (text: string) => Promise<SavableAudio>;
  play?: (audio: SavableAudio) => Promise<void>;
  getEnvironment?: (name: string) => string | undefined;
  writeSelfCheck?: (result: VoiceSelfCheckResult) => void;
  reportError?: (message: string) => void;
}

export function parseTextArgument(arguments_: string[]): string {
  if (arguments_.length !== 1) {
    throw new Error('Usage: kokoro-cli "text to speak"');
  }

  const text = arguments_[0];
  if (text === undefined || text.trim().length === 0) {
    throw new Error("Text must contain non-whitespace characters.");
  }

  return text;
}

export async function runCli(
  arguments_: string[],
  dependencies: CliDependencies = {},
): Promise<"spoken" | "voice-self-check"> {
  const text = parseTextArgument(arguments_);
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
      return "voice-self-check";
    }

    runtime = await (dependencies.prepareRuntime ?? prepareInferenceRuntime)();
    const audio = await (dependencies.synthesize ?? synthesize)(text);
    await (dependencies.play ?? playAudio)(audio);
    return "spoken";
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
    (file) =>
      (file as Blob & { name: string }).name === "onnxruntime_binding.node",
  );

  if (!hasEmbeddedNativeRuntime) {
    return { cleanup: async () => {} };
  }

  return prepareNativeRuntime();
}

async function synthesize(text: string): Promise<SavableAudio> {
  if (process.env.KOKORO_OFFLINE === "1") {
    const { env } = await import("@huggingface/transformers");
    env.allowRemoteModels = false;
  }

  const { synthesizeSpeech } = await import("./tts");
  return synthesizeSpeech(text);
}

function writeSelfCheck(result: VoiceSelfCheckResult): void {
  console.log(JSON.stringify(result));
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split("\n", 1)[0]?.trim() || "unknown error";
}
