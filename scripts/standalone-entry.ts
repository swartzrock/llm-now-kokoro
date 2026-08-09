import {
  installEmbeddedVoiceProvider,
  verifyEmbeddedVoices,
} from "../src/embedded-voices";
import { prepareNativeRuntime } from "../src/native-runtime";

async function main(): Promise<void> {
  installEmbeddedVoiceProvider();
  const voices = await verifyEmbeddedVoices();

  if (process.argv.includes("--self-check")) {
    console.log(
      JSON.stringify({
        status: "ok",
        voiceCount: voices.length,
        hasAfHeart: voices.includes("af_heart"),
      }),
    );
    return;
  }

  const nativeRuntime = await prepareNativeRuntime();
  try {
    if (process.env.KOKORO_OFFLINE === "1") {
      const { env } = await import("@huggingface/transformers");
      env.allowRemoteModels = false;
    }

    const { synthesizeSpeech } = await import("../src/tts");
    const audio = await synthesizeSpeech("Hello from Kokoro.");
    if (audio.audio.byteLength === 0) {
      throw new Error("Standalone synthesis returned empty audio");
    }

    console.log(
      JSON.stringify({
        status: "ok",
        samples: audio.audio.length,
        sampleRate: audio.sampling_rate,
      }),
    );
  } finally {
    await nativeRuntime.cleanup();
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
