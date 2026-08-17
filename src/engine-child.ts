import { readBoundedInput } from "./cli";
import {
  MAX_AUDIO_SAMPLES,
  MAX_NON_SPECIAL_TOKENS,
  MAX_REQUEST_BYTES,
} from "./limits";
import { decodeSpeakRequest } from "./protocol";
import {
  HelperFailure,
  normalizeFailure,
  operationFailure,
  protocolFailure,
  type HelperExitCode,
} from "./result";
import { createNativeSpeechEngine } from "./tts";

type ParentMessage = { type: "synthesize" };

export function createAudioMessage(
  bytes: Uint8Array,
  sampleCount: number,
): { type: "audio"; bytes: Uint8Array; sampleCount: number } {
  return {
    type: "audio",
    // Keep the IPC payload independent from the buffer cleared after send.
    bytes: bytes.slice(),
    sampleCount,
  };
}

export async function runEngineChildMain(): Promise<HelperExitCode> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("disconnect", abort);
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  let requestBytes: Uint8Array | undefined;
  let wavBytes: Uint8Array | undefined;
  try {
    const engine = await createNativeSpeechEngine(process.cwd());
    await sendToParent({ type: "ready" });
    requestBytes = await readBoundedInput(
      Bun.stdin.stream(),
      MAX_REQUEST_BYTES,
      controller.signal,
    );
    const request = decodeSpeakRequest(requestBytes);
    const analysis = await engine.inspectText(
      request.text,
      controller.signal,
      request.voice,
    );
    if (
      !Number.isSafeInteger(analysis.nonSpecialTokenCount) ||
      analysis.nonSpecialTokenCount < 0
    ) {
      throw operationFailure("invalid-phonemizer-result");
    }
    if (analysis.nonSpecialTokenCount > MAX_NON_SPECIAL_TOKENS) {
      throw protocolFailure("phoneme-token-limit");
    }
    await sendToParent({
      type: "analysis",
      nonSpecialTokenCount: analysis.nonSpecialTokenCount,
    });
    await waitForSynthesis(controller.signal);
    const audio = await engine.synthesize(analysis, controller.signal);
    wavBytes = audio.bytes;
    if (audio.sampleCount > MAX_AUDIO_SAMPLES) {
      throw protocolFailure("audio-sample-limit");
    }
    await sendToParent(createAudioMessage(wavBytes, audio.sampleCount));
    process.disconnect?.();
    return 0;
  } catch (error) {
    const failure = normalizeFailure(error);
    await sendToParent({
      type: "failure",
      exitCode: failure.exitCode,
      diagnostic: failure.diagnostic,
    }).catch(() => {});
    process.disconnect?.();
    return failure.exitCode;
  } finally {
    requestBytes?.fill(0);
    wavBytes?.fill(0);
    process.off("disconnect", abort);
    process.off("SIGINT", abort);
    process.off("SIGTERM", abort);
  }
}

async function waitForSynthesis(signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw signal.reason;
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(signal.reason);
    };
    const onMessage = (message: unknown) => {
      cleanup();
      if (isSynthesisMessage(message)) resolve();
      else reject(operationFailure("engine-child-protocol-invalid"));
    };
    const cleanup = () => {
      signal.removeEventListener("abort", onAbort);
      process.off("message", onMessage);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    process.once("message", onMessage);
  });
}

function isSynthesisMessage(value: unknown): value is ParentMessage {
  return (
    value !== null &&
    typeof value === "object" &&
    Object.keys(value).length === 1 &&
    (value as { type?: unknown }).type === "synthesize"
  );
}

async function sendToParent(message: unknown): Promise<void> {
  const send = process.send;
  if (!send) throw operationFailure("engine-child-ipc-unavailable");
  await new Promise<void>((resolve, reject) => {
    send.call(process, message, (error) => {
      if (error) reject(new HelperFailure(1, "engine-child-ipc-failed"));
      else resolve();
    });
  });
}
