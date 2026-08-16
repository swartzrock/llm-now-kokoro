import { describe, expect, test } from "bun:test";

import {
  type HelperDependencies,
  type SpeechAnalysis,
  readBoundedInput,
  runHelperMain,
} from "./cli";
import {
  MAX_AUDIO_SAMPLES,
  MAX_DIAGNOSTIC_BYTES,
  MAX_NON_SPECIAL_TOKENS,
  MAX_REQUEST_BYTES,
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
    writeStdout: (value) => {
      output.stdout.push(value);
    },
    writeStderr: (value) => {
      output.stderr.push(value);
    },
  };
}

const speakArguments = ["speak", "--protocol-major", "1"];

describe("internal helper operations", () => {
  test("info emits only its bounded canonical response", async () => {
    const events: string[] = [];
    const output = { stdout: [] as string[], stderr: [] as string[] };
    let finishWrite: () => void = () => {};
    const writeFinished = new Promise<void>((resolve) => {
      finishWrite = resolve;
    });
    const dependencies = dependenciesFor("unused", events, output);
    dependencies.writeStdout = async (value) => {
      await writeFinished;
      output.stdout.push(value);
    };

    const result = runHelperMain(
      ["info", "--protocol-major", "1"],
      dependencies,
    );
    let runFinished = false;
    void result.then(() => {
      runFinished = true;
    });
    await Bun.sleep(0);
    expect(runFinished).toBe(false);
    expect(output.stdout).toEqual([]);
    finishWrite();
    const exitCode = await result;

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

  test("does not report cancellation until active playback cleanup settles", async () => {
    const events: string[] = [];
    const output = { stdout: [] as string[], stderr: [] as string[] };
    const controller = new AbortController();
    let releaseCleanup: () => void = () => {};
    const cleanup = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    let signalPlaybackStarted: () => void = () => {};
    const playbackStarted = new Promise<void>((resolve) => {
      signalPlaybackStarted = resolve;
    });
    const dependencies = dependenciesFor("cancel in flight", events, output);
    dependencies.signal = controller.signal;
    dependencies.play = async (_audio, signal) => {
      events.push("play-start");
      signalPlaybackStarted();
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", async () => {
          events.push("cleanup-start");
          await cleanup;
          events.push("cleanup-finished");
          reject(signal.reason);
        }, { once: true });
      });
    };

    let settled = false;
    const result = runHelperMain(speakArguments, dependencies).finally(() => {
      settled = true;
    });
    await playbackStarted;
    controller.abort();
    await Bun.sleep(0);

    expect(settled).toBe(false);
    expect(events).toContain("cleanup-start");
    releaseCleanup();
    expect(await result).toBe(130);
    expect(events.at(-1)).toBe("cleanup-finished");
    expect(output.stderr).toEqual(["llm-now-kokoro: cancelled\n"]);
  });

  test.each([
    ["phonemization", "phonemization-timeout"],
    ["inference", "inference-timeout"],
  ] as const)("aborts active %s work at its stage deadline", async (stage, diagnostic) => {
    const events: string[] = [];
    const output = { stdout: [] as string[], stderr: [] as string[] };
    const dependencies = dependenciesFor("deadline", events, output);
    dependencies.deadlines = { [stage]: 1 };
    const waitForAbort = (signal: AbortSignal) =>
      new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          events.push(`${stage}-aborted`);
          reject(signal.reason);
        }, { once: true });
      });
    if (stage === "phonemization") {
      dependencies.inspectText = async (_text, signal) => waitForAbort(signal);
    } else {
      dependencies.synthesize = async (_analysis, signal) => waitForAbort(signal);
    }

    const exitCode = await runHelperMain(speakArguments, dependencies);

    expect(exitCode).toBe(1);
    expect(events).toContain(`${stage}-aborted`);
    expect(events.some((event) => event.startsWith("play:"))).toBe(false);
    expect(output.stderr).toEqual([`llm-now-kokoro: ${diagnostic}\n`]);
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

describe("bounded stdin transport", () => {
  test("combines bounded request chunks and clears the source buffers", async () => {
    const first = encoder.encode('{"text":"hel');
    const second = encoder.encode('lo"}');
    const expected = encoder.encode('{"text":"hello"}');
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(first);
        controller.enqueue(second);
        controller.close();
      },
    });

    const result = await readBoundedInput(
      stream,
      expected.byteLength,
      new AbortController().signal,
    );

    expect(result).toEqual(expected);
    expect(first.every((byte) => byte === 0)).toBe(true);
    expect(second.every((byte) => byte === 0)).toBe(true);
  });

  test("cancels the reader immediately after the request byte limit", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_REQUEST_BYTES + 1));
      },
      cancel() {
        cancelled = true;
      },
    });

    await expect(readBoundedInput(
      stream,
      MAX_REQUEST_BYTES,
      new AbortController().signal,
    )).rejects.toThrow("request-too-large");
    expect(cancelled).toBe(true);
  });

  test("cancels a pending reader when the helper is aborted", async () => {
    let cancelled = false;
    const controller = new AbortController();
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const pending = readBoundedInput(stream, MAX_REQUEST_BYTES, controller.signal);
    controller.abort();

    await expect(pending).rejects.toThrow("cancelled");
    expect(cancelled).toBe(true);
  });
});
