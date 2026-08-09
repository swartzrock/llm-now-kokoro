import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface SavableAudio {
  save(path: string): Promise<void>;
}

interface PlaybackProcess {
  exited: Promise<number>;
  stderr: ReadableStream<Uint8Array>;
}

interface PlaybackSpawnOptions {
  stdin: "ignore";
  stdout: "ignore";
  stderr: "pipe";
}

export interface PlaybackDependencies {
  makeTempDirectory?: () => Promise<string>;
  spawn?: (
    command: string[],
    options: PlaybackSpawnOptions,
  ) => PlaybackProcess;
  removeDirectory?: (directory: string) => Promise<void>;
}

export async function playAudio(
  audio: SavableAudio,
  dependencies: PlaybackDependencies = {},
): Promise<void> {
  const makeTempDirectory =
    dependencies.makeTempDirectory ??
    (() => mkdtemp(join(tmpdir(), "kokoro-cli-audio-")));
  const spawn = dependencies.spawn ?? spawnAfplay;
  const removeDirectory =
    dependencies.removeDirectory ??
    ((directory: string) => rm(directory, { recursive: true, force: true }));
  const directory = await makeTempDirectory();
  const wavPath = join(directory, "speech.wav");

  try {
    try {
      await audio.save(wavPath);
    } catch (error) {
      throw new Error(`Unable to write temporary WAV: ${errorMessage(error)}`);
    }

    let child: PlaybackProcess;
    try {
      child = spawn(["/usr/bin/afplay", wavPath], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "pipe",
      });
    } catch (error) {
      throw new Error(`Unable to start afplay: ${errorMessage(error)}`);
    }

    const [exitCode, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ]);
    if (exitCode !== 0) {
      const detail = firstLine(stderr);
      throw new Error(
        `Unable to play speech: afplay exited ${exitCode}${detail ? `: ${detail}` : ""}`,
      );
    }
  } finally {
    await removeDirectory(directory);
  }
}

function spawnAfplay(
  command: string[],
  options: PlaybackSpawnOptions,
): PlaybackProcess {
  const child = Bun.spawn(command, options);
  return {
    exited: child.exited,
    stderr: child.stderr,
  };
}

function errorMessage(error: unknown): string {
  return firstLine(error instanceof Error ? error.message : String(error)) || "unknown error";
}

function firstLine(message: string): string {
  return message.split("\n", 1)[0]?.trim() ?? "";
}
