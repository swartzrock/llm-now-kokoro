import { describe, expect, test } from "bun:test";

import {
  DEFAULT_VOICE,
  HELP_TEXT,
  parseCliArguments,
  runCli,
  runCliMain,
  SUPPORTED_VOICES,
  type CliDependencies,
} from "./cli";

function unusedDependencies(events: string[]): CliDependencies {
  return {
    installVoiceProvider: () => {
      events.push("install-voice-provider");
      return () => events.push("restore-voice-provider");
    },
    prepareRuntime: async (backend) => {
      events.push(`prepare-runtime:${backend}`);
      return {
        cleanup: async () => {
          events.push("cleanup-runtime");
        },
      };
    },
    synthesize: async (_text, _voice, backend) => {
      events.push(`synthesize:${backend}`);
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

describe("parseCliArguments", () => {
  test("preserves one non-whitespace argument with the default voice", () => {
    expect(parseCliArguments(["  How was your day?  "])).toEqual({
      kind: "speak",
      text: "  How was your day?  ",
      voice: DEFAULT_VOICE,
      backend: "native",
    });
  });

  test("accepts an embedded voice before or after the text", () => {
    expect(parseCliArguments(["--voice", "af_bella", "Hello"])).toEqual({
      kind: "speak",
      text: "Hello",
      voice: "af_bella",
      backend: "native",
    });
    expect(parseCliArguments(["Hello", "--voice", "bf_emma"])).toEqual({
      kind: "speak",
      text: "Hello",
      voice: "bf_emma",
      backend: "native",
    });
    for (const voice of [
      "ef_dora",
      "ff_siwis",
      "jf_alpha",
      "zf_xiaobei",
    ] as const) {
      expect(parseCliArguments(["--voice", voice, "Hello"])).toEqual({
        kind: "speak",
        text: "Hello",
        voice,
        backend: "native",
      });
    }
  });

  test("accepts --wasm before or after the text", () => {
    expect(parseCliArguments(["--wasm", "Hello"])).toEqual({
      kind: "speak",
      text: "Hello",
      voice: DEFAULT_VOICE,
      backend: "wasm",
    });
    expect(parseCliArguments(["Hello", "--wasm"])).toEqual({
      kind: "speak",
      text: "Hello",
      voice: DEFAULT_VOICE,
      backend: "wasm",
    });
  });

  test("returns the help command", () => {
    expect(parseCliArguments(["--help"])).toEqual({ kind: "help" });
    expect(SUPPORTED_VOICES).toHaveLength(54);
  });

  test.each([
    [[], 'Usage: kokoro-cli [--voice <voice>] [--wasm] "text to speak"'],
    [["   \t\n"], "Text must contain non-whitespace characters."],
    [["hello", "world"], 'Usage: kokoro-cli [--voice <voice>] [--wasm] "text to speak"'],
    [["--voice", "not_a_voice", "Hello"], "Unknown voice: not_a_voice"],
    [["--voice", "Hello"], "--voice requires a voice name and one text argument."],
    [["--wasm", "--wasm", "Hello"], "--wasm may only be specified once."],
    [["--unknown", "Hello"], "Unknown option: --unknown"],
  ])("rejects invalid arguments", (arguments_, message) => {
    expect(() => parseCliArguments(arguments_)).toThrow(message);
  });
});

describe("runCli", () => {
  test.each([
    [],
    ["   \t\n"],
    ["hello", "world"],
    ["--voice", "not_a_voice", "Hello"],
  ])(
    "rejects invalid arguments before any runtime dependency",
    async (...arguments_) => {
      const events: string[] = [];

      await expect(runCli(arguments_, unusedDependencies(events))).rejects.toThrow();

      expect(events).toEqual([]);
    },
  );

  test("prints help without preparing voices, native assets, or the model", async () => {
    const events: string[] = [];
    const output: string[] = [];
    const dependencies = unusedDependencies(events);
    dependencies.writeOutput = (message) => output.push(message);

    await expect(runCli(["--help"], dependencies)).resolves.toBeUndefined();

    expect(output).toEqual([HELP_TEXT]);
    expect(events).toEqual([]);
  });

  test("passes the exact text through synthesis and cleans runtime state after playback", async () => {
    const events: string[] = [];
    const audio = { save: async () => {} };
    const dependencies = unusedDependencies(events);
    dependencies.synthesize = async (text, voice, backend) => {
      events.push(`synthesize:${backend}:${voice}:${text}`);
      return audio;
    };
    dependencies.play = async (receivedAudio) => {
      expect(receivedAudio).toBe(audio);
      events.push("play");
    };

    await expect(
      runCli(["  How was your day?  "], dependencies),
    ).resolves.toBeUndefined();

    expect(events).toEqual([
      "get-environment",
      "install-voice-provider",
      "prepare-runtime:native",
      "synthesize:native:af_heart:  How was your day?  ",
      "play",
      "cleanup-runtime",
      "restore-voice-provider",
    ]);
  });

  test("passes the selected embedded voice to synthesis", async () => {
    const events: string[] = [];
    const dependencies = unusedDependencies(events);
    dependencies.synthesize = async (text, voice, backend) => {
      events.push(`synthesize:${backend}:${voice}:${text}`);
      return { save: async () => {} };
    };

    await runCli(["--voice", "jf_alpha", "Hello"], dependencies);

    expect(events).toContain("synthesize:native:jf_alpha:Hello");
  });

  test("passes the WASM backend through runtime preparation and synthesis", async () => {
    const events: string[] = [];
    const dependencies = unusedDependencies(events);

    await runCli(["--wasm", "Hello"], dependencies);

    expect(events).toContain("prepare-runtime:wasm");
    expect(events).toContain("synthesize:wasm");
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
      "prepare-runtime:native",
      "synthesize",
      "cleanup-runtime",
      "restore-voice-provider",
    ]);
  });

  test("preserves synthesis and runtime cleanup failures", async () => {
    const events: string[] = [];
    const dependencies = unusedDependencies(events);
    dependencies.synthesize = async () => {
      throw new Error("inference failed");
    };
    dependencies.prepareRuntime = async () => ({
      cleanup: async () => {
        events.push("cleanup-runtime");
        throw new Error("runtime cleanup failed");
      },
    });

    let error: unknown;
    try {
      await runCli(["Hello"], dependencies);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([
      new Error("inference failed"),
      new Error("runtime cleanup failed"),
    ]);
    expect(events.at(-1)).toBe("restore-voice-provider");
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

    await expect(runCli(["Self check"], dependencies)).resolves.toBeUndefined();

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
