import { MAX_NON_SPECIAL_TOKENS } from "../src/limits";
import { validateCanonicalWav } from "../src/playback";
import { createNativeSpeechEngine } from "../src/tts";

export async function runOfflineInferenceSmoke(packRoot: string): Promise<void> {
  globalThis.fetch = (() =>
    Promise.reject(new Error("network-disabled"))) as unknown as typeof fetch;

  const engine = await createNativeSpeechEngine(packRoot);
  const signal = new AbortController().signal;
  const analysis = await engine.inspectText(
    "Offline native inference smoke.",
    signal,
  );
  if (analysis.nonSpecialTokenCount > MAX_NON_SPECIAL_TOKENS) {
    throw new Error("offline-smoke-token-limit");
  }
  const audio = await engine.synthesize(analysis, signal);
  try {
    validateCanonicalWav(audio);
  } finally {
    audio.bytes.fill(0);
  }
}

if (import.meta.main) {
  const packRoot = process.argv[2];
  if (!packRoot) throw new Error("assembled-pack-root-required");
  await runOfflineInferenceSmoke(packRoot);
  console.log('{"status":"ok","network":"disabled","engine":"native-q8"}');
}
