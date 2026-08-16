import { describe, expect, test } from "bun:test";

import {
  type HelperDependencies,
  type SpeechAnalysis,
  runHelperMain,
} from "./cli";
import {
  MAX_AUDIO_SAMPLES,
  MAX_DIAGNOSTIC_BYTES,
  MAX_NON_SPECIAL_TOKENS,
} from "./limits";

const encoder = new TextEncoder();

function request(text: string): Uint8Array {
  return encoder.encode(JSON.stringify({ text }));
}

function dependenciesFor(
  text: string,
  events: string[],
  output: { stdout: string[]; stderr: string[] },
): HelperDependencies {
  return {
    preflight: async () => {
      events.push("preflight");
    },
    readStdin: async () => request(text),
    inspectText: async (receivedText) => {
      events.push(`inspect:${receivedText}`);
      return { nonSpecialTokenCount: 3, synthesisInput: "opaque" };
    },
    synthesize: async (analysis) => {
      events.push(`synthesize:${analysis.synthesisInput as string}`);
      return { bytes: new Uint8Array([1, 2, 3]), sampleCount: 3 };
    },
    play: async (audio) => {
      events.push(`play:${audio.sampleCount}`);
    },
    selfTest: async () => {
      events.push("self-test");
    },
    writeStdout: (value) => output.stdout.push(value),
    writeStderr: (value) => output.stderr.push(value),
  };
}

const speakArguments = ["speak", "--protocol-major", "1"];

describe("internal helper operations", () => {
  test("info emits only its bounded canonical response", async () => {
    const events: string[] = [];
    const output = { stdout: [] as string[], stderr: [] as string[] };

    const exitCode = await runHelperMain(
      ["info", "--protocol-major", "1"],
      dependenciesFor("unused", events, output),
    );

    expect(exitCode).toBe(0);
    expect(output.stdout).toHaveLength(1);
    expect(output.stdout[0]).toStartWith('{"helperVersion":');
    expect(encoder.encode(output.stdout[0]!).byteLength).toBeLessThanOrEqual(
      MAX_DIAGNOSTIC_BYTES,
    );
    expect(output.stderr).toEqual([]);
    expect(events).toEqual([]);
  });

  test("self-test is silent on success", async () => {
    const events: string[] = [];
    const output = { stdout: [] as string[], stderr: [] as string[] };

    const exitCode = await runHelperMain(
      ["self-test", "--protocol-major", "1"],
      dependenciesFor("unused", events, output),
    );

    expect(exitCode).toBe(0);
    expect(output).toEqual({ stdout: [], stderr: [] });
    expect(events).toEqual(["self-test"]);
  });

  test("speak passes exact stdin text through the private seams", async () => {
    const text = '"hello"\nGrüße 😀; $(touch nope) | & < >';
    const events: string[] = [];
    const output = { stdout: [] as string[], stderr: [] as string[] };

    const exitCode = await runHelperMain(
      speakArguments,
      dependenciesFor(text, events, output),
    );

    expect(exitCode).toBe(0);
    expect(speakArguments.join(" ")).not.toContain(text);
    expect(events).toEqual([
      "preflight",
      `inspect:${text}`,
      "synthesize:opaque",
      "play:3",
    ]);
    expect(output).toEqual({ stdout: [], stderr: [] });
  });

  test("rejects an invalid fixed pack before acquiring answer text", async () => {
    const events: string[] = [];
    const output = { stdout: [] as string[], stderr: [] as string[] };
    const dependencies = dependenciesFor("must remain unread", events, output);
    dependencies.preflight = async () => {
      events.push("preflight");
      throw new Error("model-asset-invalid:q8-model");
    };
    dependencies.readStdin = async () => {
      events.push("read-stdin");
      return request("must remain unread");
    };

    const exitCode = await runHelperMain(speakArguments, dependencies);

    expect(exitCode).toBe(1);
    expect(events).toEqual(["preflight"]);
    expect(output.stderr).toEqual(["llm-now-kokoro: operation-failed\n"]);
  });

  test.each([
    [encoder.encode("{"), "malformed-request"],
    [encoder.encode('{"text":" \\n"}'), "blank-text"],
    [encoder.encode('{"text":"a\\u0000b"}'), "nul-text"],
    [request("x".repeat(501)), "text-too-long"],
  ])(
    "rejects bad stdin before phonemization, ONNX, or playback",
    async (bytes, diagnostic) => {
      const events: string[] = [];
      const output = { stdout: [] as string[], stderr: [] as string[] };
      const dependencies = dependenciesFor("unused", events, output);
      dependencies.readStdin = async () => bytes;

      const exitCode = await runHelperMain(speakArguments, dependencies);

      expect(exitCode).toBe(2);
      expect(events).toEqual(["preflight"]);
      expect(output.stdout).toEqual([]);
      expect(output.stderr.join("")).toContain(diagnostic);
    },
  );

  test("rejects expansion beyond 509 tokens before ONNX or playback", async () => {
    const events: string[] = [];
    const output = { stdout: [] as string[], stderr: [] as string[] };
    const dependencies = dependenciesFor("abbreviation-heavy", events, output);
    dependencies.inspectText = async () => {
      events.push("inspect");
      return {
        nonSpecialTokenCount: MAX_NON_SPECIAL_TOKENS + 1,
        synthesisInput: "opaque",
      };
    };

    const exitCode = await runHelperMain(speakArguments, dependencies);

    expect(exitCode).toBe(2);
    expect(events).toEqual(["preflight", "inspect"]);
    expect(output.stderr.join("")).toContain("phoneme-token-limit");
  });

  test("rejects audio over 75 seconds before playback", async () => {
    const events: string[] = [];
    const output = { stdout: [] as string[], stderr: [] as string[] };
    const dependencies = dependenciesFor("long audio", events, output);
    dependencies.synthesize = async (_analysis: SpeechAnalysis) => {
      events.push("synthesize");
      return {
        bytes: new Uint8Array(),
        sampleCount: MAX_AUDIO_SAMPLES + 1,
      };
    };

    const exitCode = await runHelperMain(speakArguments, dependencies);

    expect(exitCode).toBe(2);
    expect(events).toEqual([
      "preflight",
      "inspect:long audio",
      "synthesize",
    ]);
    expect(output.stderr.join("")).toContain("audio-sample-limit");
  });

  test("redacts answer text and raw dependency diagnostics", async () => {
    const sensitive = "private answer $(with shell syntax)";
    const events: string[] = [];
    const output = { stdout: [] as string[], stderr: [] as string[] };
    const dependencies = dependenciesFor(sensitive, events, output);
    dependencies.synthesize = async () => {
      throw new Error(`model rejected ${sensitive}${"x".repeat(40_000)}`);
    };

    const exitCode = await runHelperMain(speakArguments, dependencies);
    const diagnostic = output.stderr.join("");

    expect(exitCode).toBe(1);
    expect(diagnostic).toBe("llm-now-kokoro: operation-failed\n");
    expect(diagnostic).not.toContain(sensitive);
    expect(encoder.encode(diagnostic).byteLength).toBeLessThanOrEqual(
      MAX_DIAGNOSTIC_BYTES,
    );
    expect(events).not.toContain("play:3");
  });

  test("returns 130 for cancellation without starting work", async () => {
    const events: string[] = [];
    const output = { stdout: [] as string[], stderr: [] as string[] };
    const controller = new AbortController();
    controller.abort();
    const dependencies = dependenciesFor("not read", events, output);
    dependencies.signal = controller.signal;

    const exitCode = await runHelperMain(speakArguments, dependencies);

    expect(exitCode).toBe(130);
    expect(events).toEqual([]);
    expect(output.stdout).toEqual([]);
    expect(output.stderr).toEqual(["llm-now-kokoro: cancelled\n"]);
  });

  test.each([
    [["info", "--protocol-major", "0"], "protocol-major-mismatch"],
    [["info", "--protocol-major", "2"], "protocol-major-mismatch"],
    [
      [
        "speak",
        "--protocol-major",
        "1",
        "--require-capability",
        "future-feature",
      ],
      "unsupported-capability",
    ],
  ])("returns protocol exit 2 before reading stdin", async (arguments_, diagnostic) => {
    const events: string[] = [];
    const output = { stdout: [] as string[], stderr: [] as string[] };
    const dependencies = dependenciesFor("must remain unread", events, output);
    dependencies.readStdin = async () => {
      events.push("read-stdin");
      return request("must remain unread");
    };

    const exitCode = await runHelperMain(arguments_, dependencies);

    expect(exitCode).toBe(2);
    expect(events).toEqual([]);
    expect(output.stderr.join("")).toContain(diagnostic);
  });
});

describe("exact protocol constants", () => {
  test("uses the plan's stable limits", async () => {
    const limits = await import("./limits");

    expect(limits.MAX_TEXT_SCALARS).toBe(500);
    expect(limits.MAX_NON_SPECIAL_TOKENS).toBe(509);
    expect(limits.MAX_AUDIO_SAMPLES).toBe(1_800_000);
    expect(limits.PHONEMIZATION_TIMEOUT_MS).toBe(10_000);
    expect(limits.INFERENCE_TIMEOUT_MS).toBe(30_000);
    expect(limits.OVERALL_TIMEOUT_MS).toBe(120_000);
    expect(limits.MAX_DIAGNOSTIC_BYTES).toBe(16 * 1024);
  });
});
