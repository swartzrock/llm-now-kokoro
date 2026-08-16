import { isAbsolute, resolve } from "node:path";

const FIXED_TEXT = "Native sidecar architecture check.";
const MAX_AUDIO_SAMPLES = 1_800_000;

interface SmokeOptions {
  assetRoot: string;
  playerPath: string;
  playerMode: "check" | "play";
  runtimeRoot: string;
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const bindingPath = resolve(
    options.runtimeRoot,
    "onnxruntime_binding.node",
  );
  Object.defineProperty(
    globalThis,
    Symbol.for("llm-now-kokoro.onnx-binding-path"),
    { configurable: true, value: bindingPath },
  );

  const voicePath = resolve(
    options.assetRoot,
    "model/voices/af_heart.bin",
  );
  const voiceProviderSymbol = Symbol.for("kokoro-js.voice-provider");
  Object.defineProperty(globalThis, voiceProviderSymbol, {
    configurable: true,
    value: async (voice: string) => {
      if (voice !== "af_heart") throw new Error("Unexpected voice request");
      return Bun.file(voicePath).arrayBuffer();
    },
  });

  const { env } = await import("@huggingface/transformers");
  env.allowLocalModels = true;
  env.allowRemoteModels = false;
  env.localModelPath = options.assetRoot;
  env.useBrowserCache = false;
  env.useFSCache = false;

  const { KokoroTTS } = await import("kokoro-js");
  const model = await KokoroTTS.from_pretrained("model", {
    device: "cpu",
    dtype: "q8",
  });
  const audio = await model.generate(FIXED_TEXT, {
    voice: "af_heart",
    speed: 1.0,
  });
  if (
    audio.sampling_rate !== 24_000 ||
    audio.audio.length === 0 ||
    audio.audio.length > MAX_AUDIO_SAMPLES
  ) {
    throw new Error("Unexpected architecture-smoke audio result");
  }

  await invokePlayer(
    options.playerPath,
    options.playerMode,
    encodeFloat32Wav(audio.audio, audio.sampling_rate),
  );
  console.log(
    JSON.stringify({
      status: "ok",
      backend: "native-cpu",
      model: "q8",
      voice: "af_heart",
      sampleRate: audio.sampling_rate,
      samples: audio.audio.length,
      playerMode: options.playerMode,
    }),
  );
}

function parseOptions(arguments_: string[]): SmokeOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < arguments_.length; index += 2) {
    const key = arguments_[index];
    const value = arguments_[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error("Invalid architecture-smoke arguments");
    }
    values.set(key, value);
  }

  const runtimeRoot = values.get("--runtime-root");
  const assetRoot = values.get("--asset-root");
  const playerPath = values.get("--player");
  const playerMode = values.get("--player-mode") ?? "check";
  if (
    !runtimeRoot ||
    !assetRoot ||
    !playerPath ||
    !isAbsolute(runtimeRoot) ||
    !isAbsolute(assetRoot) ||
    !isAbsolute(playerPath) ||
    (playerMode !== "check" && playerMode !== "play")
  ) {
    throw new Error("Architecture-smoke paths must be absolute");
  }

  return {
    runtimeRoot,
    assetRoot,
    playerPath,
    playerMode,
  };
}

async function invokePlayer(
  playerPath: string,
  mode: "check" | "play",
  wav: Uint8Array,
): Promise<void> {
  const child = Bun.spawn(
    mode === "check" ? [playerPath, "--check"] : [playerPath],
    {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  child.stdin.write(wav);
  child.stdin.end();

  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0 || stdout.length > 0) {
    throw new Error(
      `Bundled player failed (${exitCode}): ${stderr.trim().slice(0, 160)}`,
    );
  }
}

function encodeFloat32Wav(
  samples: Float32Array,
  sampleRate: number,
): Uint8Array {
  const dataBytes = samples.length * Float32Array.BYTES_PER_ELEMENT;
  const output = new Uint8Array(44 + dataBytes);
  const view = new DataView(output.buffer);
  writeAscii(output, 0, "RIFF");
  view.setUint32(4, output.length - 8, true);
  writeAscii(output, 8, "WAVE");
  writeAscii(output, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 3, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 4, true);
  view.setUint16(32, 4, true);
  view.setUint16(34, 32, true);
  writeAscii(output, 36, "data");
  view.setUint32(40, dataBytes, true);
  for (let index = 0; index < samples.length; index += 1) {
    view.setFloat32(44 + index * 4, samples[index] ?? 0, true);
  }
  return output;
}

function writeAscii(output: Uint8Array, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    output[offset + index] = value.charCodeAt(index);
  }
}

await main();
