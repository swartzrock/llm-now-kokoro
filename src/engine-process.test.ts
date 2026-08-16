import { describe, expect, test } from "bun:test";

import {
  ENGINE_CHILD_ENVIRONMENT_KEY,
  createSupervisedSpeechEngine,
  type EngineProcessDependencies,
} from "./engine-process";
import { MAX_NON_SPECIAL_TOKENS } from "./limits";

function closedStream(): ReadableStream<Uint8Array> {
  return new Blob().stream();
}

function fakeProcess(options: {
  disconnectOnExit?: boolean;
  endInput?(): number | void | Promise<number | void>;
  exitOnKill?: boolean;
  exitOnSignal?: number;
  onBeforeReady?(): void;
  onSpawn?(ipc: (message: unknown) => void): void;
  onSynthesize?(
    ipc: (message: unknown) => void,
    resolveExit: (code: number) => void,
    disconnect: () => void,
  ): void;
  written: number[];
  kills: number[];
  unrefs?: number[];
  stdout?: ReadableStream<Uint8Array>;
}): EngineProcessDependencies {
  return {
    command: async () => ["/verified/llm-now-kokoro"],
    delay: async () => {
      await Bun.sleep(0);
    },
    spawn: (_command, spawnOptions) => {
      let resolveExit: (code: number) => void = () => {};
      const exited = new Promise<number>((resolve) => {
        resolveExit = resolve;
      });
      const finishExit = (code: number) => {
        resolveExit(code);
        if (options.disconnectOnExit !== false) {
          queueMicrotask(() => spawnOptions.onDisconnect());
        }
      };
      queueMicrotask(() => {
        options.onBeforeReady?.();
        spawnOptions.ipc({ type: "ready" });
        options.onSpawn?.(spawnOptions.ipc);
      });
      return {
        exited,
        kill: (signal) => {
          options.kills.push(signal ?? 0);
          if (
            options.exitOnKill !== false &&
            (options.exitOnSignal === undefined || options.exitOnSignal === signal)
          ) {
            finishExit(143);
          }
        },
        send: () => options.onSynthesize?.(
          spawnOptions.ipc,
          finishExit,
          spawnOptions.onDisconnect,
        ),
        stdin: {
          write: (bytes) => {
            const count = Math.min(bytes.byteLength, 5);
            options.written.push(...bytes.subarray(0, count));
            return count;
          },
          end: options.endInput ?? (() => {}),
        },
        stdout: options.stdout ?? closedStream(),
        stderr: closedStream(),
        disconnect: () => {},
        unref: () => options.unrefs?.push(1),
      };
    },
  };
}

describe("supervised native engine process", () => {
  test("keeps answer text on bounded stdin and returns bounded audio over IPC", async () => {
    const written: number[] = [];
    const kills: number[] = [];
    let capturedCommand: string[] = [];
    let capturedEnvironment: Record<string, string> = {};
    const dependencies = fakeProcess({
      written,
      kills,
      onBeforeReady: () => expect(written).toEqual([]),
      onSpawn: (ipc) => ipc({
        type: "analysis",
        nonSpecialTokenCount: 4,
      }),
      onSynthesize: (ipc, resolveExit) => {
        const bytes = new Uint8Array(48);
        ipc({
          type: "audio",
          bytes,
          sampleCount: 1,
        });
        resolveExit(0);
      },
    });
    const spawn = dependencies.spawn!;
    dependencies.spawn = (command, options) => {
      capturedCommand = command;
      capturedEnvironment = options.env;
      return spawn(command, options);
    };
    const engine = createSupervisedSpeechEngine("/pack", dependencies);
    const signal = new AbortController().signal;

    const analysis = await engine.inspectText("private answer", signal);
    const audio = await engine.synthesize(analysis, signal);

    expect(new TextDecoder().decode(new Uint8Array(written))).toBe(
      '{"text":"private answer"}',
    );
    expect(capturedCommand).toEqual(["/verified/llm-now-kokoro"]);
    expect(capturedEnvironment).toEqual({
      [ENGINE_CHILD_ENVIRONMENT_KEY]: "1",
    });
    expect(JSON.stringify(capturedCommand)).not.toContain("private answer");
    expect(JSON.stringify(capturedEnvironment)).not.toContain("private answer");
    expect(audio).toEqual({
      bytes: new Uint8Array(48),
      sampleCount: 1,
    });
    expect(kills).toEqual([]);
  });

  test("terminates and reaps the native process when inspection is cancelled", async () => {
    const controller = new AbortController();
    const kills: number[] = [];
    const engine = createSupervisedSpeechEngine("/pack", fakeProcess({
      written: [],
      kills,
      endInput: () => new Promise(() => {}),
    }));
    const inspection = engine.inspectText("cancel me", controller.signal);
    await Bun.sleep(0);
    controller.abort();

    await expect(inspection).rejects.toThrow("cancelled");
    expect(kills).toContain(15);
  });

  test("reaps an expansion-heavy request before synthesis starts", async () => {
    const kills: number[] = [];
    let synthesisMessages = 0;
    const engine = createSupervisedSpeechEngine("/pack", fakeProcess({
      written: [],
      kills,
      onSpawn: (ipc) => ipc({
        type: "analysis",
        nonSpecialTokenCount: MAX_NON_SPECIAL_TOKENS + 1,
      }),
      onSynthesize: () => {
        synthesisMessages += 1;
      },
    }));

    const analysis = await engine.inspectText(
      "expansion heavy",
      new AbortController().signal,
    );

    expect(analysis.nonSpecialTokenCount).toBe(MAX_NON_SPECIAL_TOKENS + 1);
    expect(kills).toContain(15);
    expect(synthesisMessages).toBe(0);
  });

  test("cancels an audio child that hangs during clean exit", async () => {
    const controller = new AbortController();
    const kills: number[] = [];
    const engine = createSupervisedSpeechEngine("/pack", fakeProcess({
      written: [],
      kills,
      onSpawn: (ipc) => ipc({
        type: "analysis",
        nonSpecialTokenCount: 1,
      }),
      onSynthesize: (ipc) => ipc({
        type: "audio",
        bytes: new Uint8Array(48),
        sampleCount: 1,
      }),
    }));
    const analysis = await engine.inspectText("cancel me", controller.signal);
    const synthesis = engine.synthesize(analysis, controller.signal);
    await Bun.sleep(0);
    controller.abort();

    await expect(synthesis).rejects.toThrow("cancelled");
    expect(kills).toContain(15);
  });

  test("accepts final IPC after process exit but before disconnect", async () => {
    const engine = createSupervisedSpeechEngine("/pack", fakeProcess({
      written: [],
      kills: [],
      disconnectOnExit: false,
      onSpawn: (ipc) => ipc({
        type: "analysis",
        nonSpecialTokenCount: 1,
      }),
      onSynthesize: (ipc, resolveExit, disconnect) => {
        resolveExit(0);
        queueMicrotask(() => {
          ipc({
            type: "audio",
            bytes: new Uint8Array(48),
            sampleCount: 1,
          });
          disconnect();
        });
      },
    }));
    const signal = new AbortController().signal;
    const analysis = await engine.inspectText("ordered", signal);

    const audio = await engine.synthesize(analysis, signal);

    expect(audio.sampleCount).toBe(1);
  });

  test("disposes a child waiting between inspection and synthesis", async () => {
    const kills: number[] = [];
    const engine = createSupervisedSpeechEngine("/pack", fakeProcess({
      written: [],
      kills,
      onSpawn: (ipc) => ipc({
        type: "analysis",
        nonSpecialTokenCount: 1,
      }),
    }));
    await engine.inspectText("cancel me", new AbortController().signal);

    await engine.dispose?.();

    expect(kills).toContain(15);
  });

  test("bounds failed hard-kill cleanup and unreferences the child", async () => {
    const kills: number[] = [];
    const unrefs: number[] = [];
    const engine = createSupervisedSpeechEngine("/pack", fakeProcess({
      written: [],
      kills,
      unrefs,
      exitOnKill: false,
      onSpawn: (ipc) => ipc({
        type: "analysis",
        nonSpecialTokenCount: 1,
      }),
    }));
    await engine.inspectText("cancel me", new AbortController().signal);

    await expect(engine.dispose?.()).rejects.toThrow(
      "engine-child-cleanup-failed",
    );
    expect(kills).toEqual([15, 9]);
    expect(unrefs).toEqual([1]);
  });

  test("bounds the complete hard-kill, drain, and reader-cancel sequence", async () => {
    const kills: number[] = [];
    const engine = createSupervisedSpeechEngine("/pack", fakeProcess({
      written: [],
      kills,
      exitOnSignal: 9,
      stdout: new ReadableStream<Uint8Array>(),
      onSpawn: (ipc) => ipc({
        type: "analysis",
        nonSpecialTokenCount: 1,
      }),
    }));
    await engine.inspectText("cancel me", new AbortController().signal);

    await engine.dispose?.();

    expect(kills).toEqual([15, 9]);
  });
});
