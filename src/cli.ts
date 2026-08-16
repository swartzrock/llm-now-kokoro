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

// Exceeds the supervised engine's worst-case graceful kill, hard kill,
// output-drain, and reader-cancellation sequence while remaining bounded.
const CANCELLATION_SETTLE_GRACE_MS = 5_000;

export interface HelperDependencies {
  cleanup?: () => Promise<void>;
  deadlines?: {
    inference?: number;
    overall?: number;
    phonemization?: number;
  };
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
  preflight?: (signal: AbortSignal) => Promise<void>;
  selfTest?: (signal: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
  writeStdout?: (value: string) => void | Promise<void>;
  writeStderr?: (value: string) => void | Promise<void>;
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
    await writeBounded(
      encodeInfoResponse(),
      dependencies.writeStdout ?? (async (value) => {
        await Bun.stdout.write(value);
      }),
    );
    return;
  }

  await withDeadline(
    dependencies.deadlines?.overall ?? OVERALL_TIMEOUT_MS,
    signal,
    operationFailure("overall-timeout"),
    async (overallSignal) => {
      let didFail = false;
      try {
        if (command.operation === "self-test") {
          await (dependencies.selfTest ?? unavailableSelfTest)(overallSignal);
          return;
        }
        await speak(dependencies, overallSignal);
      } catch (error) {
        didFail = true;
        throw error;
      } finally {
        try {
          await dependencies.cleanup?.();
        } catch (cleanupError) {
          if (!didFail) throw cleanupError;
        }
      }
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
    await writeBounded(
      diagnostic,
      dependencies.writeStderr ?? (async (value) => {
        await Bun.stderr.write(value);
      }),
    );
    return failure.exitCode;
  }
}

async function speak(
  dependencies: HelperDependencies,
  overallSignal: AbortSignal,
): Promise<void> {
  await (dependencies.preflight ?? unavailablePreflight)(overallSignal);
  const requestBytes = await (
    dependencies.readStdin ?? readBoundedStdin
  )(MAX_REQUEST_BYTES, overallSignal);

  try {
    throwIfAborted(overallSignal);
    const request = decodeSpeakRequest(requestBytes);
    const analysis = await withDeadline(
      dependencies.deadlines?.phonemization ?? PHONEMIZATION_TIMEOUT_MS,
      overallSignal,
      operationFailure("phonemization-timeout"),
      (signal) => (dependencies.inspectText ?? unavailableInspect)(request.text, signal),
    );
    validateAnalysis(analysis);

    const audio = await withDeadline(
      dependencies.deadlines?.inference ?? INFERENCE_TIMEOUT_MS,
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
  return readBoundedInput(Bun.stdin.stream(), maximumBytes, signal);
}

export async function readBoundedInput(
  stream: ReadableStream<Uint8Array>,
  maximumBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const reader = stream.getReader();
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

export async function withDeadline<T>(
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
  const taskPromise = Promise.resolve().then(() => task(controller.signal));

  try {
    return await withAbort(taskPromise, controller.signal);
  } catch (error) {
    if (controller.signal.aborted) {
      await settleWithin(taskPromise, CANCELLATION_SETTLE_GRACE_MS);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    parentSignal?.removeEventListener("abort", onParentAbort);
  }
}

async function settleWithin(
  promise: Promise<unknown>,
  milliseconds: number,
): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise.then(() => undefined, () => undefined),
      new Promise<void>((resolvePromise) => {
        timeout = setTimeout(resolvePromise, milliseconds);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
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

async function writeBounded(
  value: string,
  write: (value: string) => void | Promise<void>,
): Promise<void> {
  if (new TextEncoder().encode(value).byteLength > MAX_DIAGNOSTIC_BYTES) {
    throw operationFailure("output-limit");
  }
  await write(value);
}

async function unavailableSelfTest(): Promise<never> {
  throw operationFailure("self-test-unavailable");
}

async function unavailablePreflight(): Promise<never> {
  throw operationFailure("speech-engine-unavailable");
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
