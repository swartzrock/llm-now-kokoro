import { describe, expect, test } from "bun:test";

import { playAudio } from "./playback";

function emptyStream(): ReadableStream<Uint8Array> {
  return new Blob([]).stream();
}

describe("playAudio", () => {
  test("saves a WAV, invokes absolute afplay without a shell, and waits before cleanup", async () => {
    const events: string[] = [];
    let finishPlayback: (exitCode: number) => void = () => {};
    const exited = new Promise<number>((resolve) => {
      finishPlayback = resolve;
    });
    let command: string[] | undefined;
    let spawnOptions: unknown;

    const playback = playAudio(
      {
        save: async (path) => {
          events.push(`save:${path}`);
        },
      },
      {
        makeTempDirectory: async () => "/tmp/kokoro-cli-audio-test",
        spawn: (arguments_, options) => {
          command = arguments_;
          spawnOptions = options;
          events.push("spawn");
          return { exited, stderr: emptyStream() };
        },
        removeDirectory: async (path) => {
          events.push(`remove:${path}`);
        },
      },
    );

    await Bun.sleep(0);
    expect(command).toEqual([
      "/usr/bin/afplay",
      "/tmp/kokoro-cli-audio-test/speech.wav",
    ]);
    expect(spawnOptions).toEqual({
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
    });
    expect(events).toEqual([
      "save:/tmp/kokoro-cli-audio-test/speech.wav",
      "spawn",
    ]);

    finishPlayback(0);
    await playback;
    expect(events.at(-1)).toBe("remove:/tmp/kokoro-cli-audio-test");
  });

  test("reports nonzero afplay status concisely and removes the temporary directory", async () => {
    const removed: string[] = [];

    await expect(
      playAudio(
        { save: async () => {} },
        {
          makeTempDirectory: async () => "/tmp/kokoro-cli-audio-failure",
          spawn: () => ({
            exited: Promise.resolve(7),
            stderr: new Blob(["no audio device\n    at afplay:1"]).stream(),
          }),
          removeDirectory: async (path) => {
            removed.push(path);
          },
        },
      ),
    ).rejects.toThrow("Unable to play speech: afplay exited 7: no audio device");

    expect(removed).toEqual(["/tmp/kokoro-cli-audio-failure"]);
  });

  test("reports a WAV-save failure concisely and removes the temporary directory", async () => {
    const removed: string[] = [];

    await expect(
      playAudio(
        {
          save: async () => {
            throw new Error("disk full\n    at internal-writer.ts:1");
          },
        },
        {
          makeTempDirectory: async () => "/tmp/kokoro-cli-audio-save-failure",
          spawn: () => {
            throw new Error("afplay must not start");
          },
          removeDirectory: async (path) => {
            removed.push(path);
          },
        },
      ),
    ).rejects.toThrow("Unable to write temporary WAV: disk full");

    expect(removed).toEqual(["/tmp/kokoro-cli-audio-save-failure"]);
  });

  test("preserves the playback failure when temporary cleanup also fails", async () => {
    await expect(
      playAudio(
        { save: async () => {} },
        {
          makeTempDirectory: async () => "/tmp/kokoro-cli-audio-double-failure",
          spawn: () => ({
            exited: Promise.resolve(7),
            stderr: new Blob(["no audio device"]).stream(),
          }),
          removeDirectory: async () => {
            throw new Error("permission denied\n    at cleanup.ts:1");
          },
        },
      ),
    ).rejects.toThrow(
      "Unable to play speech: afplay exited 7: no audio device; Unable to remove temporary audio: permission denied",
    );
  });
});
