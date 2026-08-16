import { constants } from "node:fs";
import { access, lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import type { SynthesizedAudio } from "./cli";
import {
  AUDIO_SAMPLE_RATE_HZ,
  MAX_AUDIO_SAMPLES,
  MAX_DIAGNOSTIC_BYTES,
} from "./limits";
import {
  HelperFailure,
  cancellationFailure,
  operationFailure,
} from "./result";

const WAV_HEADER_BYTES = 44;
export const MAX_WAV_BYTES = WAV_HEADER_BYTES + MAX_AUDIO_SAMPLES * 4;
const PLAYER_WRITE_CHUNK_BYTES = 64 * 1024;
const TERMINATION_GRACE_MS = 250;
const HARD_TERMINATION_GRACE_MS = 1_000;

interface PlaybackInput {
  write(bytes: Uint8Array): number | void | Promise<number | void>;
  flush?(): number | void | Promise<number | void>;
  end?(): number | void | Promise<number | void>;
}

interface PlaybackProcess {
  exited: Promise<number>;
  kill(signal?: number): void;
  stderr: ReadableStream<Uint8Array>;
  stdin: PlaybackInput;
  stdout: ReadableStream<Uint8Array>;
  unref?(): void;
}

interface PlaybackSpawnOptions {
  cwd: string;
  env: Record<string, string>;
  stderr: "pipe";
  stdin: "pipe";
  stdout: "pipe";
  windowsHide: true;
}

interface FileMetadata {
  gid?: number;
  isDirectory(): boolean;
  isFile(): boolean;
  isSocket(): boolean;
  isSymbolicLink(): boolean;
  mode?: number;
  uid?: number;
}

export interface PlaybackDependencies {
  access?: (path: string, mode: number) => Promise<void>;
  canonicalize?: (path: string) => Promise<string>;
  delay?: (milliseconds: number) => Promise<void>;
  environment?: NodeJS.ProcessEnv;
  getUid?: () => number;
  inspect?: (path: string) => Promise<FileMetadata>;
  platform?: NodeJS.Platform;
  spawn?: (
    command: string[],
    options: PlaybackSpawnOptions,
  ) => PlaybackProcess;
}

export interface PlaybackOptions {
  checkOnly?: boolean;
  verifiedPlayerPath?: string;
}

export async function verifyBundledPlayer(
  packRoot: string,
  dependencies: PlaybackDependencies = {},
): Promise<string> {
  if (!isAbsolute(packRoot)) throw operationFailure("pack-root-invalid");
  const inspect = dependencies.inspect ?? lstat;
  const platform = dependencies.platform ?? process.platform;
  const playerPath = resolve(
    packRoot,
    "runtime",
    platform === "win32"
      ? "llm-now-kokoro-player.exe"
      : "llm-now-kokoro-player",
  );
  const runtimePath = resolve(packRoot, "runtime");

  try {
    const [rootMetadata, runtimeMetadata, playerMetadata] = await Promise.all([
      inspect(packRoot),
      inspect(runtimePath),
      inspect(playerPath),
    ]);
    if (
      !rootMetadata.isDirectory() ||
      rootMetadata.isSymbolicLink() ||
      !runtimeMetadata.isDirectory() ||
      runtimeMetadata.isSymbolicLink() ||
      !playerMetadata.isFile() ||
      playerMetadata.isSymbolicLink()
    ) {
      throw new Error("invalid");
    }
    if (platform !== "win32") {
      await (dependencies.access ?? access)(playerPath, constants.X_OK);
    }
  } catch {
    throw operationFailure("player-unavailable");
  }
  return playerPath;
}

export async function playAudio(
  audio: SynthesizedAudio,
  packRoot: string,
  signal: AbortSignal,
  options: PlaybackOptions = {},
  dependencies: PlaybackDependencies = {},
): Promise<void> {
  validateCanonicalWav(audio);
  throwIfAborted(signal);

  const expectedPlayerPath = resolve(
    packRoot,
    "runtime",
    (dependencies.platform ?? process.platform) === "win32"
      ? "llm-now-kokoro-player.exe"
      : "llm-now-kokoro-player",
  );
  if (
    options.verifiedPlayerPath !== undefined &&
    options.verifiedPlayerPath !== expectedPlayerPath
  ) {
    throw operationFailure("player-unavailable");
  }
  const playerPath =
    options.verifiedPlayerPath ??
    await verifyBundledPlayer(packRoot, dependencies);
  const environment = await buildPlayerEnvironment(dependencies);
  throwIfAborted(signal);

  let child: PlaybackProcess;
  try {
    child = (dependencies.spawn ?? spawnPlayer)(
      options.checkOnly ? [playerPath, "--check"] : [playerPath],
      {
        cwd: packRoot,
        env: environment,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        windowsHide: true,
      },
    );
  } catch {
    throw operationFailure("player-start-failed");
  }

  const exited = child.exited;
  const stdout = readBoundedOutput(child.stdout);
  const stderr = readBoundedOutput(child.stderr);
  const writer = writeAudio(child.stdin, audio.bytes);
  // Every branch observes these promises, including early child exit.
  void writer.catch(() => {});
  void stdout.catch(() => {});
  void stderr.catch(() => {});

  let abortListener: (() => void) | undefined;
  const abort = new Promise<never>((_, reject) => {
    abortListener = () => reject(abortReason(signal));
    signal.addEventListener("abort", abortListener, { once: true });
  });

  try {
    const exitCode = await Promise.race([
      exited,
      writer.then(() => exited),
      stdout.then(() => exited),
      stderr.then(() => exited),
      abort,
    ]);
    await Promise.race([closeInput(child.stdin), abort]);
    const [writerResult, stdoutBytes, stderrBytes] = await Promise.race([
      Promise.all([
        settleAfterExit(writer, dependencies.delay),
        stdout,
        stderr,
      ]),
      abort,
    ]);
    if (writerResult !== "settled" && exitCode === 0) {
      throw operationFailure("player-input-failed");
    }
    if (exitCode !== 0) throw operationFailure(playerFailure(exitCode));
    if (stdoutBytes !== 0 || stderrBytes !== 0) {
      throw operationFailure("player-output-not-empty");
    }
  } catch (error) {
    await terminateAndReap(child, exited, dependencies.delay).catch(() => {});
    throw error;
  } finally {
    if (abortListener) signal.removeEventListener("abort", abortListener);
  }
}

function playerFailure(exitCode: number): string {
  switch (exitCode) {
    case 3:
      return "player-input-failed";
    case 4:
      return "player-wav-invalid";
    case 5:
      return "player-decoder-failed";
    case 6:
      return "player-decoder-length-invalid";
    default:
      return "player-failed";
  }
}

export function validateCanonicalWav(audio: SynthesizedAudio): void {
  if (
    !(audio.bytes instanceof Uint8Array) ||
    !Number.isSafeInteger(audio.sampleCount) ||
    audio.sampleCount <= 0 ||
    audio.sampleCount > MAX_AUDIO_SAMPLES ||
    audio.bytes.byteLength !== WAV_HEADER_BYTES + audio.sampleCount * 4 ||
    audio.bytes.byteLength > MAX_WAV_BYTES
  ) {
    throw operationFailure("player-wav-invalid");
  }

  const bytes = audio.bytes;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const dataBytes = audio.sampleCount * 4;
  if (
    !asciiEquals(bytes, 0, "RIFF") ||
    view.getUint32(4, true) !== bytes.byteLength - 8 ||
    !asciiEquals(bytes, 8, "WAVE") ||
    !asciiEquals(bytes, 12, "fmt ") ||
    view.getUint32(16, true) !== 16 ||
    view.getUint16(20, true) !== 3 ||
    view.getUint16(22, true) !== 1 ||
    view.getUint32(24, true) !== AUDIO_SAMPLE_RATE_HZ ||
    view.getUint32(28, true) !== AUDIO_SAMPLE_RATE_HZ * 4 ||
    view.getUint16(32, true) !== 4 ||
    view.getUint16(34, true) !== 32 ||
    !asciiEquals(bytes, 36, "data") ||
    view.getUint32(40, true) !== dataBytes
  ) {
    throw operationFailure("player-wav-invalid");
  }
}

async function buildPlayerEnvironment(
  dependencies: PlaybackDependencies,
): Promise<Record<string, string>> {
  const platform = dependencies.platform ?? process.platform;
  if (platform !== "linux") return {};

  const source = dependencies.environment ?? process.env;
  const output: Record<string, string> = { LANG: "C.UTF-8" };
  const xdgRuntimeDirectory = source.XDG_RUNTIME_DIR;
  const pulseServer = source.PULSE_SERVER;
  const pipewireRemote = source.PIPEWIRE_REMOTE;
  if (!xdgRuntimeDirectory && !pulseServer && !pipewireRemote) return output;
  if (!xdgRuntimeDirectory || !isAbsolute(xdgRuntimeDirectory)) {
    throw operationFailure("player-environment-invalid");
  }

  const inspect = dependencies.inspect ?? lstat;
  const canonicalize = dependencies.canonicalize ?? realpath;
  const getUid = dependencies.getUid ?? process.getuid;
  if (!getUid) throw operationFailure("player-environment-invalid");
  try {
    const metadata = await inspect(xdgRuntimeDirectory);
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      metadata.uid !== getUid() ||
      metadata.mode === undefined ||
      (metadata.mode & 0o022) !== 0
    ) {
      throw new Error("invalid");
    }
    output.XDG_RUNTIME_DIR = xdgRuntimeDirectory;

    if (pulseServer) {
      if (!pulseServer.startsWith("unix:")) throw new Error("invalid");
      const socketPath = pulseServer.slice("unix:".length);
      await verifyLocalSocket(
        socketPath,
        xdgRuntimeDirectory,
        inspect,
        canonicalize,
        getUid(),
      );
      output.PULSE_SERVER = pulseServer;
    }
    if (pipewireRemote) {
      if (
        !/^[A-Za-z0-9_.-]+$/.test(pipewireRemote) ||
        pipewireRemote === "." ||
        pipewireRemote === ".."
      ) {
        throw new Error("invalid");
      }
      await verifyLocalSocket(
        resolve(xdgRuntimeDirectory, pipewireRemote),
        xdgRuntimeDirectory,
        inspect,
        canonicalize,
        getUid(),
      );
      output.PIPEWIRE_REMOTE = pipewireRemote;
    }
  } catch (error) {
    if (error instanceof Error && error.message === "player-environment-invalid") {
      throw error;
    }
    throw operationFailure("player-environment-invalid");
  }
  return output;
}

async function verifyLocalSocket(
  socketPath: string,
  root: string,
  inspect: (path: string) => Promise<FileMetadata>,
  canonicalize: (path: string) => Promise<string>,
  uid: number,
): Promise<void> {
  if (!isAbsolute(socketPath)) throw new Error("invalid");
  const [canonicalRoot, canonicalSocket] = await Promise.all([
    canonicalize(root),
    canonicalize(socketPath),
  ]);
  const childPath = relative(canonicalRoot, canonicalSocket);
  if (!childPath || childPath.startsWith("..") || isAbsolute(childPath)) {
    throw new Error("invalid");
  }
  const metadata = await inspect(socketPath);
  if (
    !metadata.isSocket() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== uid
  ) {
    throw new Error("invalid");
  }
}

async function writeAudio(input: PlaybackInput, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  try {
    while (offset < bytes.byteLength) {
      const remaining = bytes.subarray(
        offset,
        Math.min(offset + PLAYER_WRITE_CHUNK_BYTES, bytes.byteLength),
      );
      const accepted = await input.write(remaining);
      const count = accepted === undefined ? remaining.byteLength : accepted;
      if (!Number.isSafeInteger(count) || count <= 0 || count > remaining.byteLength) {
        throw new Error("invalid-write-count");
      }
      offset += count;
      await input.flush?.();
    }
    await input.end?.();
  } catch {
    throw operationFailure("player-input-failed");
  }
}

async function readBoundedOutput(
  stream: ReadableStream<Uint8Array>,
): Promise<number> {
  const reader = stream.getReader();
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) return total;
      total += next.value.byteLength;
      next.value.fill(0);
      if (total > MAX_DIAGNOSTIC_BYTES) {
        await reader.cancel().catch(() => {});
        throw operationFailure("player-output-limit");
      }
    }
  } finally {
    reader.releaseLock();
  }
}

async function terminateAndReap(
  child: PlaybackProcess,
  exited: Promise<number>,
  delay: ((milliseconds: number) => Promise<void>) | undefined,
): Promise<void> {
  const inputClosed = closeInput(child.stdin);
  try {
    child.kill(15);
  } catch {}
  let didExit = await settlesWithin(
    exited,
    TERMINATION_GRACE_MS,
    delay,
  );
  if (!didExit) {
    try {
      child.kill(9);
    } catch {}
    didExit = await settlesWithin(exited, HARD_TERMINATION_GRACE_MS, delay);
  }
  if (!didExit) {
    try {
      child.unref?.();
    } catch {}
    throw operationFailure("player-cleanup-failed");
  }
  if (!(await settlesWithin(inputClosed, HARD_TERMINATION_GRACE_MS, delay))) {
    throw operationFailure("player-cleanup-failed");
  }
}

async function closeInput(input: PlaybackInput): Promise<void> {
  try {
    await input.end?.();
  } catch {}
}

async function settleAfterExit(
  promise: Promise<void>,
  delay: ((milliseconds: number) => Promise<void>) | undefined,
): Promise<"settled" | "timed-out"> {
  return Promise.race([
    promise.then(() => "settled" as const),
    (delay ?? defaultDelay)(TERMINATION_GRACE_MS).then(
      () => "timed-out" as const,
    ),
  ]);
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

function asciiEquals(bytes: Uint8Array, offset: number, expected: string): boolean {
  for (let index = 0; index < expected.length; index += 1) {
    if (bytes[offset + index] !== expected.charCodeAt(index)) return false;
  }
  return true;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason instanceof HelperFailure
    ? signal.reason
    : cancellationFailure();
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal);
}

function spawnPlayer(
  command: string[],
  options: PlaybackSpawnOptions,
): PlaybackProcess {
  return Bun.spawn(command, options) as unknown as PlaybackProcess;
}
