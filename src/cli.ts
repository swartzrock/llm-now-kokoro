import {
  INFERENCE_TIMEOUT_MS,
  MAX_AUDIO_SAMPLES,
  MAX_DIAGNOSTIC_BYTES,
  MAX_NON_SPECIAL_TOKENS,
  MAX_REQUEST_BYTES,
  OVERALL_TIMEOUT_MS,
  PHONEMIZATION_TIMEOUT_MS,
} from "./limits";
import {
  decodeSpeakRequest,
  encodeInfoResponse,
  parseHelperArguments,
} from "./protocol";
import {
  HelperFailure,
  cancellationFailure,
  normalizeFailure,
  operationFailure,
  protocolFailure,
  type HelperExitCode,
} from "./result";

export interface SpeechAnalysis {
  nonSpecialTokenCount: number;
  synthesisInput: unknown;
}

export interface SynthesizedAudio {
  bytes: Uint8Array;
  sampleCount: number;
}

export interface HelperDependencies {
  readStdin?: (
    maximumBytes: number,
    signal: AbortSignal,
  ) => Promise<Uint8Array>;
  inspectText?: (
    text: string,
    signal: AbortSignal,
  ) => Promise<SpeechAnalysis>;
  synthesize?: (
    analysis: SpeechAnalysis,
    signal: AbortSignal,
  ) => Promise<SynthesizedAudio>;
  play?: (audio: SynthesizedAudio, signal: AbortSignal) => Promise<void>;
  selfTest?: (signal: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
  writeStdout?: (value: string) => void;
  writeStderr?: (value: string) => void;
}

export async function runHelper(
  arguments_: string[],
  dependencies: HelperDependencies = {},
): Promise<void> {
  const command = parseHelperArguments(arguments_);
  const signal = dependencies.signal;
  if (signal?.aborted) {
    throw cancellationFailure();
  }

  if (command.operation === "info") {
    writeBounded(
      encodeInfoResponse(),
      dependencies.writeStdout ?? ((value) => process.stdout.write(value)),
    );
    return;
  }

  await withDeadline(
    OVERALL_TIMEOUT_MS,
    signal,
    operationFailure("overall-timeout"),
    async (overallSignal) => {
      if (command.operation === "self-test") {
        await (dependencies.selfTest ?? unavailableSelfTest)(overallSignal);
        return;
      }
      await speak(dependencies, overallSignal);
    },
  );
}

export async function runHelperMain(
  arguments_: string[],
  dependencies: HelperDependencies = {},
): Promise<HelperExitCode> {
  try {
    await runHelper(arguments_, dependencies);
    return 0;
  } catch (error) {
    const failure = normalizeFailure(error);
    const diagnostic = `llm-now-kokoro: ${failure.diagnostic}\n`;
    writeBounded(
      diagnostic,
      dependencies.writeStderr ?? ((value) => process.stderr.write(value)),
    );
    return failure.exitCode;
  }
}

// The executable entrypoint retains this source-level name while its argv
// surface is the private helper protocol above, not the prototype CLI.
export const runCliMain = runHelperMain;

async function speak(
  dependencies: HelperDependencies,
  overallSignal: AbortSignal,
): Promise<void> {
  const requestBytes = await (
    dependencies.readStdin ?? readBoundedStdin
  )(MAX_REQUEST_BYTES, overallSignal);

  try {
    throwIfAborted(overallSignal);
    const request = decodeSpeakRequest(requestBytes);
    const analysis = await withDeadline(
      PHONEMIZATION_TIMEOUT_MS,
      overallSignal,
      operationFailure("phonemization-timeout"),
      (signal) => (dependencies.inspectText ?? unavailableInspect)(request.text, signal),
    );
    validateAnalysis(analysis);

    const audio = await withDeadline(
      INFERENCE_TIMEOUT_MS,
      overallSignal,
      operationFailure("inference-timeout"),
      (signal) => (dependencies.synthesize ?? unavailableSynthesis)(analysis, signal),
    );
    try {
      validateAudio(audio);
      await (dependencies.play ?? unavailablePlayback)(audio, overallSignal);
    } finally {
      audio.bytes.fill(0);
    }
  } finally {
    requestBytes.fill(0);
  }
}

function validateAnalysis(analysis: SpeechAnalysis): void {
  if (
    !Number.isSafeInteger(analysis.nonSpecialTokenCount) ||
    analysis.nonSpecialTokenCount < 0
  ) {
    throw operationFailure("invalid-phonemizer-result");
  }
  if (analysis.nonSpecialTokenCount > MAX_NON_SPECIAL_TOKENS) {
    throw protocolFailure("phoneme-token-limit");
  }
}

function validateAudio(audio: SynthesizedAudio): void {
  if (
    !(audio.bytes instanceof Uint8Array) ||
    !Number.isSafeInteger(audio.sampleCount) ||
    audio.sampleCount < 0
  ) {
    throw operationFailure("invalid-inference-result");
  }
  if (audio.sampleCount > MAX_AUDIO_SAMPLES) {
    throw protocolFailure("audio-sample-limit");
  }
}

async function readBoundedStdin(
  maximumBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const reader = Bun.stdin.stream().getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;

  try {
    while (true) {
      throwIfAborted(signal);
      const next = await withAbort(reader.read(), signal);
      if (next.done) {
        break;
      }
      chunks.push(next.value);
      byteLength += next.value.byteLength;
      if (byteLength > maximumBytes) {
        throw protocolFailure("request-too-large");
      }
    }

    const result = new Uint8Array(byteLength);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return result;
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    for (const chunk of chunks) {
      chunk.fill(0);
    }
    reader.releaseLock();
  }
}

async function withDeadline<T>(
  milliseconds: number,
  parentSignal: AbortSignal | undefined,
  timeoutFailure: HelperFailure,
  task: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (parentSignal?.aborted) {
    throw abortReason(parentSignal);
  }

  const controller = new AbortController();
  const onParentAbort = () => controller.abort(abortReason(parentSignal!));
  parentSignal?.addEventListener("abort", onParentAbort, { once: true });
  const timeout = setTimeout(() => controller.abort(timeoutFailure), milliseconds);

  try {
    return await withAbort(task(controller.signal), controller.signal);
  } finally {
    clearTimeout(timeout);
    parentSignal?.removeEventListener("abort", onParentAbort);
  }
}

function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(abortReason(signal));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function abortReason(signal: AbortSignal): HelperFailure {
  return signal.reason instanceof HelperFailure
    ? signal.reason
    : cancellationFailure();
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw abortReason(signal);
  }
}

function writeBounded(value: string, write: (value: string) => void): void {
  if (new TextEncoder().encode(value).byteLength > MAX_DIAGNOSTIC_BYTES) {
    throw operationFailure("output-limit");
  }
  write(value);
}

async function unavailableSelfTest(): Promise<never> {
  throw operationFailure("self-test-unavailable");
}

async function unavailableInspect(): Promise<never> {
  throw operationFailure("speech-engine-unavailable");
}

async function unavailableSynthesis(): Promise<never> {
  throw operationFailure("speech-engine-unavailable");
}

async function unavailablePlayback(): Promise<never> {
  throw operationFailure("player-unavailable");
}
