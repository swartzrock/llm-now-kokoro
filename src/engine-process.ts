import { basename, isAbsolute } from "node:path";

import type { SpeechAnalysis, SynthesizedAudio } from "./cli";
import {
  MAX_AUDIO_SAMPLES,
  MAX_DIAGNOSTIC_BYTES,
  MAX_NON_SPECIAL_TOKENS,
} from "./limits";
import {
  HelperFailure,
  cancellationFailure,
  operationFailure,
} from "./result";
import type { NativeSpeechEngine } from "./tts";

export const ENGINE_CHILD_ENVIRONMENT_KEY =
  "LLM_NOW_KOKORO_INTERNAL_ENGINE_CHILD";

const TERMINATION_GRACE_MS = 250;
const HARD_TERMINATION_GRACE_MS = 1_000;

interface EngineInput {
  write(bytes: Uint8Array): number | void | Promise<number | void>;
  end?(): number | void | Promise<number | void>;
}

interface EngineProcess {
  disconnect?(): void;
  exited: Promise<number>;
  kill(signal?: number): void;
  send(message: unknown): void;
  stderr: ReadableStream<Uint8Array>;
  stdin: EngineInput;
  stdout: ReadableStream<Uint8Array>;
  unref?(): void;
}

interface SpawnOptions {
  cwd: string;
  env: Record<string, string>;
  ipc(message: unknown): void;
  onDisconnect(): void;
  stderr: "pipe";
  stdin: "pipe";
  stdout: "pipe";
  windowsHide: true;
}

export interface EngineProcessDependencies {
  command?: () => Promise<string[]>;
  delay?: (milliseconds: number) => Promise<void>;
  spawn?: (command: string[], options: SpawnOptions) => EngineProcess;
}

type EngineMessage =
  | { type: "ready" }
  | { type: "analysis"; nonSpecialTokenCount: number }
  | { type: "audio"; bytes: Uint8Array; sampleCount: number }
  | { type: "failure"; diagnostic: string; exitCode: 1 | 2 | 130 };

export function createSupervisedSpeechEngine(
  packRoot: string,
  dependencies: EngineProcessDependencies = {},
): NativeSpeechEngine {
  let activeSession: EngineSession | undefined;

  return {
    async dispose() {
      const session = activeSession;
      activeSession = undefined;
      await session?.terminate();
    },

    async inspectText(text, signal) {
      if (activeSession) throw operationFailure("engine-session-active");
      const session = await EngineSession.start(
        text,
        packRoot,
        signal,
        dependencies,
      );
      activeSession = session;
      try {
        const analysis = await session.inspect(signal);
        if (
          !Number.isSafeInteger(analysis.nonSpecialTokenCount) ||
          analysis.nonSpecialTokenCount < 0 ||
          analysis.nonSpecialTokenCount > MAX_NON_SPECIAL_TOKENS
        ) {
          await session.terminate();
          activeSession = undefined;
        }
        return analysis;
      } catch (error) {
        activeSession = undefined;
        await session.terminate().catch(() => {});
        throw error;
      }
    },

    async synthesize(analysis, signal) {
      const session = analysis.synthesisInput;
      if (!(session instanceof EngineSession) || session !== activeSession) {
        throw operationFailure("invalid-engine-session");
      }
      activeSession = undefined;
      let didFail = false;
      try {
        return await session.synthesize(signal);
      } catch (error) {
        didFail = true;
        throw error;
      } finally {
        try {
          await session.terminate();
        } catch (cleanupError) {
          if (!didFail) throw cleanupError;
        }
      }
    },
  };
}

class EngineSession {
  readonly #child: EngineProcess;
  readonly #delay: ((milliseconds: number) => Promise<void>) | undefined;
  readonly #messages = new MessageQueue();
  readonly #stderr: OutputDrain;
  readonly #stdout: OutputDrain;
  #disconnected = false;
  #exitCode: number | undefined;
  #termination: Promise<void> | undefined;

  private constructor(
    child: EngineProcess,
    delay: ((milliseconds: number) => Promise<void>) | undefined,
  ) {
    this.#child = child;
    this.#delay = delay;
    this.#stderr = startSilentOutput(child.stderr);
    this.#stdout = startSilentOutput(child.stdout);
    void this.#stderr.promise.catch(() => {});
    void this.#stdout.promise.catch(() => {});
    void child.exited.then(
      (exitCode) => this.#markExited(exitCode),
      () => this.#markExited(1),
    );
  }

  static async start(
    text: string,
    packRoot: string,
    signal: AbortSignal,
    dependencies: EngineProcessDependencies,
  ): Promise<EngineSession> {
    throwIfAborted(signal);
    const command = await (dependencies.command ?? resolveEngineCommand)();
    if (command.length === 0 || !isAbsolute(command[0]!)) {
      throw operationFailure("engine-child-unavailable");
    }

    let session: EngineSession | undefined;
    const queuedMessages: unknown[] = [];
    let disconnected = false;
    let child: EngineProcess;
    try {
      child = (dependencies.spawn ?? spawnEngineProcess)(command, {
        cwd: packRoot,
        env: { [ENGINE_CHILD_ENVIRONMENT_KEY]: "1" },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        windowsHide: true,
        ipc: (message) => {
          if (session) session.#messages.push(message);
          else queuedMessages.push(message);
        },
        onDisconnect: () => {
          if (session) session.#markDisconnected();
          else disconnected = true;
        },
      });
      session = new EngineSession(child, dependencies.delay);
      for (const message of queuedMessages) session.#messages.push(message);
      if (disconnected) session.#markDisconnected();
      const ready = await session.#nextMessage(signal);
      if (ready.type !== "ready") {
        throw operationFailure("engine-child-protocol-invalid");
      }
      await withAbort(writeRequest(child.stdin, text, signal), signal);
      throwIfAborted(signal);
      return session;
    } catch (error) {
      if (session) await session.terminate().catch(() => {});
      if (error instanceof HelperFailure) throw error;
      throw operationFailure("engine-child-start-failed");
    }
  }

  async inspect(signal: AbortSignal): Promise<SpeechAnalysis> {
    const message = await this.#nextMessage(signal);
    if (message.type !== "analysis") {
      throw operationFailure("engine-child-protocol-invalid");
    }
    return {
      nonSpecialTokenCount: message.nonSpecialTokenCount,
      synthesisInput: this,
    };
  }

  async synthesize(signal: AbortSignal): Promise<SynthesizedAudio> {
    throwIfAborted(signal);
    try {
      this.#child.send({ type: "synthesize" });
    } catch {
      throw operationFailure("engine-child-protocol-invalid");
    }
    const message = await this.#nextMessage(signal);
    if (
      message.type !== "audio" ||
      !(message.bytes instanceof Uint8Array) ||
      !Number.isSafeInteger(message.sampleCount) ||
      message.sampleCount <= 0 ||
      message.sampleCount > MAX_AUDIO_SAMPLES ||
      message.bytes.byteLength !== 44 + message.sampleCount * 4
    ) {
      throw operationFailure("engine-child-protocol-invalid");
    }
    await this.#assertCleanExit(signal);
    return { bytes: message.bytes, sampleCount: message.sampleCount };
  }

  async terminate(): Promise<void> {
    return (this.#termination ??= this.#terminate());
  }

  async #terminate(): Promise<void> {
    const closeInput = Promise.resolve()
      .then(() => this.#child.stdin.end?.())
      .then(() => undefined, () => undefined);
    try {
      this.#child.disconnect?.();
    } catch {}
    try {
      this.#child.kill(15);
    } catch {}
    let didExit = await settlesWithin(
      this.#child.exited,
      TERMINATION_GRACE_MS,
      this.#delay,
    );
    if (!didExit) {
      try {
        this.#child.kill(9);
      } catch {}
      didExit = await settlesWithin(
        this.#child.exited,
        HARD_TERMINATION_GRACE_MS,
        this.#delay,
      );
    }
    if (!didExit) {
      try {
        this.#child.unref?.();
      } catch {}
      await settlesWithin(
        Promise.all([this.#stdout.cancel(), this.#stderr.cancel()]),
        HARD_TERMINATION_GRACE_MS,
        this.#delay,
      );
      throw operationFailure("engine-child-cleanup-failed");
    }

    const drained = await settlesWithin(
      Promise.allSettled([
        closeInput,
        this.#stdout.promise,
        this.#stderr.promise,
      ]),
      HARD_TERMINATION_GRACE_MS,
      this.#delay,
    );
    if (!drained) {
      const cancelled = await settlesWithin(
        Promise.all([this.#stdout.cancel(), this.#stderr.cancel()]),
        HARD_TERMINATION_GRACE_MS,
        this.#delay,
      );
      if (!cancelled) {
        try {
          this.#child.unref?.();
        } catch {}
        throw operationFailure("engine-child-cleanup-failed");
      }
    }
  }

  async #nextMessage(signal: AbortSignal): Promise<EngineMessage> {
    try {
      const value = await this.#messages.next(signal);
      if (!isEngineMessage(value)) {
        throw operationFailure("engine-child-protocol-invalid");
      }
      if (value.type === "failure") {
        throw new HelperFailure(value.exitCode, value.diagnostic);
      }
      return value;
    } catch (error) {
      await this.terminate().catch(() => {});
      throw error;
    }
  }

  async #assertCleanExit(signal: AbortSignal): Promise<void> {
    let result: [number, number, number];
    try {
      result = await withAbort(
        Promise.all([
          this.#child.exited,
          this.#stdout.promise,
          this.#stderr.promise,
        ]),
        signal,
      );
    } catch (error) {
      await this.terminate().catch(() => {});
      throw error;
    }
    const [exitCode, stdoutBytes, stderrBytes] = result;
    this.#termination = Promise.resolve();
    if (exitCode !== 0 || stdoutBytes !== 0 || stderrBytes !== 0) {
      throw operationFailure("engine-child-failed");
    }
  }

  #markDisconnected(): void {
    this.#disconnected = true;
    this.#closeMessageQueueIfFinished();
  }

  #markExited(exitCode: number): void {
    this.#exitCode = exitCode;
    this.#closeMessageQueueIfFinished();
  }

  #closeMessageQueueIfFinished(): void {
    if (this.#disconnected && this.#exitCode !== undefined) {
      this.#messages.close(this.#exitCode);
    }
  }
}

class MessageQueue {
  readonly #messages: unknown[] = [];
  readonly #waiters: Array<{
    reject(error: unknown): void;
    resolve(value: unknown): void;
  }> = [];
  #closedExitCode: number | undefined;

  push(message: unknown): void {
    const waiter = this.#waiters.shift();
    if (waiter) waiter.resolve(message);
    else this.#messages.push(message);
  }

  close(exitCode: number): void {
    this.#closedExitCode = exitCode;
    for (const waiter of this.#waiters.splice(0)) {
      waiter.reject(operationFailure("engine-child-failed"));
    }
  }

  async next(signal: AbortSignal): Promise<unknown> {
    throwIfAborted(signal);
    const message = this.#messages.shift();
    if (message !== undefined) return message;
    if (this.#closedExitCode !== undefined) {
      throw operationFailure("engine-child-failed");
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve: (value: unknown) => {
          signal.removeEventListener("abort", onAbort);
          resolve(value);
        },
        reject: (error: unknown) => {
          signal.removeEventListener("abort", onAbort);
          reject(error);
        },
      };
      const onAbort = () => {
        const index = this.#waiters.indexOf(waiter);
        if (index >= 0) this.#waiters.splice(index, 1);
        reject(abortReason(signal));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.#waiters.push(waiter);
    });
  }
}

async function resolveEngineCommand(): Promise<string[]> {
  const executableName = basename(process.execPath).toLowerCase();
  if (executableName !== "bun" && executableName !== "bun.exe") {
    if (!isAbsolute(process.execPath)) {
      throw operationFailure("engine-child-unavailable");
    }
    return [process.execPath];
  }
  const bunPath = isAbsolute(process.execPath)
    ? process.execPath
    : Bun.which("bun");
  if (!bunPath || !isAbsolute(bunPath) || !isAbsolute(Bun.main)) {
    throw operationFailure("engine-child-unavailable");
  }
  return [bunPath, Bun.main];
}

async function writeRequest(
  input: EngineInput,
  text: string,
  signal: AbortSignal,
): Promise<void> {
  const bytes = new TextEncoder().encode(JSON.stringify({ text }));
  const clear = () => bytes.fill(0);
  signal.addEventListener("abort", clear, { once: true });
  try {
    let offset = 0;
    while (offset < bytes.byteLength) {
      const remaining = bytes.subarray(offset);
      const accepted = await input.write(remaining);
      const count = accepted === undefined ? remaining.byteLength : accepted;
      if (
        !Number.isSafeInteger(count) ||
        count <= 0 ||
        count > remaining.byteLength
      ) {
        throw new Error("short-write");
      }
      offset += count;
    }
  } finally {
    signal.removeEventListener("abort", clear);
    clear();
  }
  await input.end?.();
}

interface OutputDrain {
  cancel(): Promise<void>;
  promise: Promise<number>;
}

function startSilentOutput(
  stream: ReadableStream<Uint8Array>,
): OutputDrain {
  const reader = stream.getReader();
  const promise = (async () => {
    let total = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) return total;
        total += next.value.byteLength;
        next.value.fill(0);
        if (total > MAX_DIAGNOSTIC_BYTES) {
          await reader.cancel().catch(() => {});
          throw operationFailure("engine-child-output-limit");
        }
      }
    } finally {
      reader.releaseLock();
    }
  })();
  return {
    cancel: async () => {
      await reader.cancel().catch(() => {});
    },
    promise,
  };
}

function isEngineMessage(value: unknown): value is EngineMessage {
  if (value === null || typeof value !== "object") return false;
  const message = value as Partial<EngineMessage>;
  if (message.type === "ready") {
    return Object.keys(value).length === 1;
  }
  if (message.type === "analysis") {
    return typeof message.nonSpecialTokenCount === "number";
  }
  if (message.type === "audio") {
    return message.bytes instanceof Uint8Array && typeof message.sampleCount === "number";
  }
  return (
    message.type === "failure" &&
    (message.exitCode === 1 || message.exitCode === 2 || message.exitCode === 130) &&
    typeof message.diagnostic === "string" &&
    /^[a-z0-9-]+$/.test(message.diagnostic)
  );
}

function spawnEngineProcess(
  command: string[],
  options: SpawnOptions,
): EngineProcess {
  return Bun.spawn(command, options) as unknown as EngineProcess;
}

function defaultDelay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function settlesWithin(
  promise: Promise<unknown>,
  milliseconds: number,
  delay: ((milliseconds: number) => Promise<void>) | undefined,
): Promise<boolean> {
  return Promise.race([
    promise.then(() => true, () => true),
    (delay ?? defaultDelay)(milliseconds).then(() => false),
  ]);
}

async function withAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  throwIfAborted(signal);
  return new Promise<T>((resolvePromise, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolvePromise(value);
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
  if (signal.aborted) throw abortReason(signal);
}
