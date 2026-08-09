import { describe, expect, test } from "bun:test";

import {
  parseTextArgument,
  runCli,
  runCliMain,
  type CliDependencies,
} from "./cli";

function unusedDependencies(events: string[]): CliDependencies {
  return {
    installVoiceProvider: () => {
      events.push("install-voice-provider");
      return () => events.push("restore-voice-provider");
    },
    prepareRuntime: async () => {
      events.push("prepare-runtime");
      return {
        cleanup: async () => {
          events.push("cleanup-runtime");
        },
      };
    },
    synthesize: async () => {
      events.push("synthesize");
      return { save: async () => {} };
    },
    play: async () => {
      events.push("play");
    },
    getEnvironment: () => {
      events.push("get-environment");
      return undefined;
    },
  };
}

describe("parseTextArgument", () => {
  test("preserves one non-whitespace argument exactly", () => {
    expect(parseTextArgument(["  How was your day?  "])).toBe(
      "  How was your day?  ",
    );
  });

  test.each([
    [[], 'Usage: kokoro-cli "text to speak"'],
    [["   \t\n"], "Text must contain non-whitespace characters."],
    [["hello", "world"], 'Usage: kokoro-cli "text to speak"'],
  ])("rejects invalid arguments", (arguments_, message) => {
    expect(() => parseTextArgument(arguments_)).toThrow(message);
  });
});

describe("runCli", () => {
  test.each([[], ["   \t\n"], ["hello", "world"]])(
    "rejects invalid arguments before any runtime dependency",
    async (...arguments_) => {
      const events: string[] = [];

      await expect(runCli(arguments_, unusedDependencies(events))).rejects.toThrow();

      expect(events).toEqual([]);
    },
  );

  test("passes the exact text through synthesis and cleans runtime state after playback", async () => {
    const events: string[] = [];
    const audio = { save: async () => {} };
    const dependencies = unusedDependencies(events);
    dependencies.synthesize = async (text) => {
      events.push(`synthesize:${text}`);
      return audio;
    };
    dependencies.play = async (receivedAudio) => {
      expect(receivedAudio).toBe(audio);
      events.push("play");
    };

    await expect(runCli(["  How was your day?  "], dependencies)).resolves.toBe(
      "spoken",
    );

    expect(events).toEqual([
      "get-environment",
      "install-voice-provider",
      "prepare-runtime",
      "synthesize:  How was your day?  ",
      "play",
      "cleanup-runtime",
      "restore-voice-provider",
    ]);
  });

  test("cleans native and voice state after synthesis fails", async () => {
    const events: string[] = [];
    const dependencies = unusedDependencies(events);
    dependencies.synthesize = async () => {
      events.push("synthesize");
      throw new Error("Unable to synthesize speech: inference failed");
    };

    await expect(runCli(["Hello"], dependencies)).rejects.toThrow(
      "Unable to synthesize speech: inference failed",
    );

    expect(events).toEqual([
      "get-environment",
      "install-voice-provider",
      "prepare-runtime",
      "synthesize",
      "cleanup-runtime",
      "restore-voice-provider",
    ]);
  });

  test("uses an environment-only embedded voice self-check without loading the model", async () => {
    const events: string[] = [];
    let selfCheck: unknown;
    const dependencies = unusedDependencies(events);
    dependencies.getEnvironment = (name) => {
      events.push(`get-environment:${name}`);
      return "1";
    };
    dependencies.verifyVoices = async () => {
      events.push("verify-voices");
      return Array.from({ length: 54 }, (_, index) =>
        index === 0 ? "af_heart" : `voice_${index}`,
      );
    };
    dependencies.writeSelfCheck = (result) => {
      selfCheck = result;
    };

    await expect(runCli(["Self check"], dependencies)).resolves.toBe(
      "voice-self-check",
    );

    expect(selfCheck).toEqual({ status: "ok", voiceCount: 54, hasAfHeart: true });
    expect(events).toEqual([
      "get-environment:KOKORO_STANDALONE_VOICE_SELF_CHECK",
      "install-voice-provider",
      "verify-voices",
      "restore-voice-provider",
    ]);
  });
});

describe("runCliMain", () => {
  test.each([
    "Unable to prepare Kokoro model cache: permission denied",
    "Unable to load Kokoro q8 model: download failed",
    "Unable to synthesize speech: inference failed",
    "Unable to play speech: afplay exited 1",
  ])("prints a concise diagnostic without a normal stack trace", async (message) => {
    const diagnostics: string[] = [];
    const dependencies = unusedDependencies([]);
    dependencies.synthesize = async () => {
      throw new Error(`${message}\n    at internal.ts:42:1`);
    };
    dependencies.reportError = (diagnostic) => diagnostics.push(diagnostic);

    await expect(runCliMain(["Hello"], dependencies)).resolves.toBe(1);
    expect(diagnostics).toEqual([`kokoro-cli: ${message}`]);
  });
});
