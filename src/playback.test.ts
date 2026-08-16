import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import { MAX_DIAGNOSTIC_BYTES } from "./limits";
import {
  type PlaybackDependencies,
  playAudio,
  validateCanonicalWav,
  verifyBundledPlayer,
} from "./playback";
import { operationFailure } from "./result";

const packRoot = resolve("/packs/with spaces/ユニコード");
const runtimeRoot = resolve(packRoot, "runtime");
const playerPath = resolve(runtimeRoot, "llm-now-kokoro-player");
const linuxRuntimeRoot = resolve("/run/user/501");
const pulseSocket = resolve(linuxRuntimeRoot, "pulse/native");
const signal = new AbortController().signal;

function canonicalWav(sampleCount = 2): {
  bytes: Uint8Array;
  sampleCount: number;
} {
  const bytes = new Uint8Array(44 + sampleCount * 4);
  const view = new DataView(bytes.buffer);
  writeAscii(bytes, 0, "RIFF");
  view.setUint32(4, bytes.length - 8, true);
  writeAscii(bytes, 8, "WAVE");
  writeAscii(bytes, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 3, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 24_000, true);
  view.setUint32(28, 96_000, true);
  view.setUint16(32, 4, true);
  view.setUint16(34, 32, true);
  writeAscii(bytes, 36, "data");
  view.setUint32(40, sampleCount * 4, true);
  return { bytes, sampleCount };
}

function writeAscii(bytes: Uint8Array, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    bytes[offset + index] = value.charCodeAt(index);
  }
}

function metadata(kind: "directory" | "file" | "socket", uid = 501) {
  return {
    mode: kind === "directory" ? 0o700 : 0o600,
    uid,
    isDirectory: () => kind === "directory",
    isFile: () => kind === "file",
    isSocket: () => kind === "socket",
    isSymbolicLink: () => false,
  };
}

function baseDependencies(
  overrides: Partial<PlaybackDependencies> = {},
): PlaybackDependencies {
  return {
    platform: "darwin",
    access: async () => {},
    canonicalize: async (path) => path,
    inspect: async (path) =>
      path === packRoot || path === runtimeRoot
        ? metadata("directory")
        : metadata("file"),
    ...overrides,
  };
}

function closedStream(bytes: Uint8Array = new Uint8Array()): ReadableStream<Uint8Array> {
  return new Blob([bytes]).stream();
}

describe("bundled playback", () => {
  test("streams canonical WAV to the absolute bundled player with no inherited environment", async () => {
    const audio = canonicalWav();
    const written: number[] = [];
    let command: string[] = [];
    let spawnOptions: unknown = {};
    let resolveExit: (code: number) => void = () => {};
    const exited = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });

    await playAudio(audio, packRoot, signal, { checkOnly: true }, baseDependencies({
      environment: {
        PATH: `/tmp/${"private-answer"}`,
        DYLD_LIBRARY_PATH: "/tmp/hostile",
      },
      spawn: (receivedCommand, receivedOptions) => {
        command = receivedCommand;
        spawnOptions = receivedOptions;
        return {
          exited,
          kill: () => resolveExit(143),
          stdin: {
            write: (bytes) => {
              written.push(...bytes);
              return bytes.byteLength;
            },
            flush: async () => {},
            end: () => resolveExit(0),
          },
          stdout: closedStream(),
          stderr: closedStream(),
        };
      },
    }));

    expect(command).toEqual([
      playerPath,
      "--check",
    ]);
    expect(spawnOptions).toEqual({
      cwd: packRoot,
      env: {},
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    });
    expect(written).toEqual(Array.from(audio.bytes));
    expect(JSON.stringify(command)).not.toContain("private-answer");
  });

  test("handles bounded partial writes and backpressure before ending stdin", async () => {
    const audio = canonicalWav(4);
    const events: string[] = [];
    let written = 0;

    await playAudio(audio, packRoot, signal, {}, baseDependencies({
      spawn: () => {
        let resolveExit: (code: number) => void = () => {};
        const exited = new Promise<number>((resolve) => {
          resolveExit = resolve;
        });
        return {
          exited,
          kill: () => resolveExit(143),
          stdin: {
            write: (bytes) => {
              const accepted = Math.min(bytes.byteLength, 7);
              written += accepted;
              events.push(`write:${accepted}`);
              return accepted;
            },
            flush: async () => events.push("flush"),
            end: () => {
              events.push("end");
              resolveExit(0);
            },
          },
          stdout: closedStream(),
          stderr: closedStream(),
        };
      },
    }));

    expect(written).toBe(audio.bytes.byteLength);
    expect(events.filter((event) => event === "flush").length).toBeGreaterThan(1);
    expect(events.at(-1)).toBe("end");
  });

  test("caps each player stdin write at 64 KiB", async () => {
    const audio = canonicalWav(20_000);
    const writes: number[] = [];

    await playAudio(audio, packRoot, signal, {}, baseDependencies({
      spawn: () => {
        let resolveExit: (code: number) => void = () => {};
        const exited = new Promise<number>((resolve) => {
          resolveExit = resolve;
        });
        return {
          exited,
          kill: () => resolveExit(143),
          stdin: {
            write: (bytes) => {
              writes.push(bytes.byteLength);
              return bytes.byteLength;
            },
            end: () => resolveExit(0),
          },
          stdout: closedStream(),
          stderr: closedStream(),
        };
      },
    }));

    expect(writes.length).toBeGreaterThan(1);
    expect(Math.max(...writes)).toBe(64 * 1024);
    expect(writes.reduce((total, length) => total + length, 0)).toBe(
      audio.bytes.byteLength,
    );
  });

  test.each([
    ["format", 20, 1],
    ["sample rate", 24, 48_000],
    ["declared data size", 40, 4],
  ])("rejects malformed canonical WAV: %s", (_label, offset, value) => {
    const audio = canonicalWav();
    const view = new DataView(audio.bytes.buffer);
    if (offset === 20) view.setUint16(offset, value, true);
    else view.setUint32(offset, value, true);
    expect(() => validateCanonicalWav(audio)).toThrow("player-wav-invalid");
  });

  test("rejects empty, inconsistent, and oversized audio before spawning", async () => {
    expect(() => validateCanonicalWav({ bytes: new Uint8Array(44), sampleCount: 0 })).toThrow(
      "player-wav-invalid",
    );
    const inconsistent = canonicalWav();
    inconsistent.sampleCount += 1;
    expect(() => validateCanonicalWav(inconsistent)).toThrow("player-wav-invalid");
    expect(() =>
      validateCanonicalWav({
        bytes: new Uint8Array(44),
        sampleCount: 1_800_001,
      }),
    ).toThrow("player-wav-invalid");
  });

  test("rejects missing, linked, or non-executable players before spawn", async () => {
    await expect(verifyBundledPlayer(packRoot, baseDependencies({
      inspect: async (path) => {
        if (path === packRoot || path === runtimeRoot) {
          return metadata("directory");
        }
        throw new Error("missing");
      },
    }))).rejects.toThrow("player-unavailable");

    await expect(verifyBundledPlayer(packRoot, baseDependencies({
      access: async () => {
        throw new Error("not executable");
      },
    }))).rejects.toThrow("player-unavailable");

    await expect(verifyBundledPlayer(packRoot, baseDependencies({
      inspect: async (path) => ({
        ...metadata(
          path === packRoot || path === runtimeRoot
            ? "directory"
            : "file",
        ),
        isSymbolicLink: () => path.endsWith("llm-now-kokoro-player"),
      }),
    }))).rejects.toThrow("player-unavailable");

    await expect(verifyBundledPlayer(packRoot, baseDependencies({
      inspect: async (path) => ({
        ...metadata(
          path === packRoot || path === runtimeRoot
            ? "directory"
            : "file",
        ),
        isSymbolicLink: () => path === runtimeRoot,
      }),
    }))).rejects.toThrow("player-unavailable");
  });

  test("reports start and device failures without exposing player output", async () => {
    await expect(playAudio(canonicalWav(), packRoot, signal, {}, baseDependencies({
      spawn: () => {
        throw new Error("private answer from spawn");
      },
    }))).rejects.toThrow("player-start-failed");

    await expect(playAudio(canonicalWav(), packRoot, signal, {}, baseDependencies({
      spawn: () => ({
        exited: Promise.resolve(7),
        kill: () => {},
        stdin: { write: (bytes) => bytes.byteLength, end: () => {} },
        stdout: closedStream(),
        stderr: closedStream(new TextEncoder().encode("private answer\n")),
      }),
    }))).rejects.toThrow("player-failed");
  });

  test.each([
    [3, "player-input-failed"],
    [4, "player-wav-invalid"],
    [5, "player-decoder-failed"],
    [6, "player-decoder-length-invalid"],
  ] as const)("maps player stage exit %i to %s", async (exitCode, diagnostic) => {
    await expect(playAudio(canonicalWav(), packRoot, signal, {}, baseDependencies({
      spawn: () => ({
        exited: Promise.resolve(exitCode),
        kill: () => {},
        stdin: { write: (bytes) => bytes.byteLength, end: () => {} },
        stdout: closedStream(),
        stderr: closedStream(new TextEncoder().encode("value-free stage\n")),
      }),
    }))).rejects.toThrow(diagnostic);
  });

  test("bounds both child output streams and rejects output on success", async () => {
    for (const bytes of [
      new Uint8Array([1]),
      new Uint8Array(MAX_DIAGNOSTIC_BYTES + 1),
    ]) {
      await expect(playAudio(canonicalWav(), packRoot, signal, {}, baseDependencies({
        delay: async () => {},
        spawn: () => ({
          exited: Promise.resolve(0),
          kill: () => {},
          stdin: { write: (input) => input.byteLength, end: () => {} },
          stdout: closedStream(bytes),
          stderr: closedStream(),
        }),
      }))).rejects.toThrow(
        bytes.byteLength > MAX_DIAGNOSTIC_BYTES
          ? "player-output-limit"
          : "player-output-not-empty",
      );
    }
  });

  test("closes stdin, terminates, and reaps on cancellation", async () => {
    const controller = new AbortController();
    const signals: number[] = [];
    const events: string[] = [];
    let resolveExit: (code: number) => void = () => {};
    const exited = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });
    const playback = playAudio(canonicalWav(), packRoot, controller.signal, {}, baseDependencies({
      spawn: () => ({
        exited,
        kill: (receivedSignal) => {
          signals.push(receivedSignal ?? 0);
          events.push("kill");
          resolveExit(143);
        },
        stdin: {
          write: (bytes) => bytes.byteLength,
          flush: () => new Promise(() => {}),
          end: () => events.push("end"),
        },
        stdout: closedStream(),
        stderr: closedStream(),
      }),
    }));
    await Bun.sleep(0);
    controller.abort(operationFailure("overall-timeout"));

    await expect(playback).rejects.toThrow("overall-timeout");
    expect(events.indexOf("end")).toBeLessThan(events.indexOf("kill"));
    expect(signals).toContain(15);
  });

  test("observes cancellation while draining inherited child output handles", async () => {
    const controller = new AbortController();
    const playback = playAudio(
      canonicalWav(),
      packRoot,
      controller.signal,
      {},
      baseDependencies({
        spawn: () => ({
          exited: Promise.resolve(0),
          kill: () => {},
          stdin: { write: (bytes) => bytes.byteLength, end: () => {} },
          stdout: new ReadableStream<Uint8Array>(),
          stderr: closedStream(),
        }),
      }),
    );
    await Bun.sleep(0);
    controller.abort(operationFailure("overall-timeout"));

    await expect(playback).rejects.toThrow("overall-timeout");
  });

  test("passes only validated local Linux audio endpoints", async () => {
    let childEnvironment: Record<string, string> | undefined;
    const environment = {
      PATH: "/hostile",
      ALSA_CONFIG_PATH: "/tmp/hostile",
      XDG_RUNTIME_DIR: linuxRuntimeRoot,
      PULSE_SERVER: `unix:${pulseSocket}`,
      PIPEWIRE_REMOTE: "pipewire-0",
    };
    await playAudio(canonicalWav(), packRoot, signal, {}, baseDependencies({
      platform: "linux",
      environment,
      getUid: () => 501,
      inspect: async (path) => {
        if (
          path === packRoot ||
          path === runtimeRoot ||
          path === environment.XDG_RUNTIME_DIR
        ) {
          return metadata("directory");
        }
        if (path.includes("llm-now-kokoro-player")) return metadata("file");
        return metadata("socket");
      },
      spawn: (_command, options) => {
        childEnvironment = options.env;
        return {
          exited: Promise.resolve(0),
          kill: () => {},
          stdin: { write: (bytes) => bytes.byteLength, end: () => {} },
          stdout: closedStream(),
          stderr: closedStream(),
        };
      },
    }));
    expect(childEnvironment).toEqual({
      LANG: "C.UTF-8",
      XDG_RUNTIME_DIR: linuxRuntimeRoot,
      PULSE_SERVER: `unix:${pulseSocket}`,
      PIPEWIRE_REMOTE: "pipewire-0",
    });
  });

  test.each([
    { XDG_RUNTIME_DIR: "relative", PULSE_SERVER: "tcp:remote:4713" },
    { XDG_RUNTIME_DIR: linuxRuntimeRoot, PULSE_SERVER: "tcp:remote:4713" },
    { XDG_RUNTIME_DIR: linuxRuntimeRoot, PIPEWIRE_REMOTE: "../remote" },
    {
      XDG_RUNTIME_DIR: linuxRuntimeRoot,
      PULSE_SERVER: `unix:${resolve("/run/user/502/pulse/native")}`,
    },
  ])("rejects non-local Linux audio envelope %#", async (environment) => {
    await expect(playAudio(canonicalWav(), packRoot, signal, {}, baseDependencies({
      platform: "linux",
      environment,
      getUid: () => 501,
      inspect: async (path) =>
        path === packRoot ||
        path === runtimeRoot ||
        path === linuxRuntimeRoot
          ? metadata("directory")
          : path.includes("llm-now-kokoro-player")
            ? metadata("file")
            : metadata("socket"),
      spawn: () => {
        throw new Error("must not spawn");
      },
    }))).rejects.toThrow("player-environment-invalid");
  });

  test("rejects Linux socket paths whose intermediate links escape the runtime directory", async () => {
    await expect(playAudio(canonicalWav(), packRoot, signal, {}, baseDependencies({
      platform: "linux",
      environment: {
        XDG_RUNTIME_DIR: linuxRuntimeRoot,
        PULSE_SERVER: `unix:${resolve(linuxRuntimeRoot, "link/native")}`,
      },
      getUid: () => 501,
      canonicalize: async (path) =>
        path === resolve(linuxRuntimeRoot, "link/native")
          ? resolve("/tmp/attacker/native")
          : path,
      inspect: async (path) =>
        path === packRoot ||
        path === runtimeRoot ||
        path === linuxRuntimeRoot
          ? metadata("directory")
          : path.includes("llm-now-kokoro-player")
            ? metadata("file")
            : metadata("socket"),
      spawn: () => {
        throw new Error("must not spawn");
      },
    }))).rejects.toThrow("player-environment-invalid");
  });

  test("rejects writable Linux runtime directories and foreign-owned sockets", async () => {
    for (const unsafePath of ["runtime", "socket"] as const) {
      await expect(playAudio(canonicalWav(), packRoot, signal, {}, baseDependencies({
        platform: "linux",
        environment: {
          XDG_RUNTIME_DIR: linuxRuntimeRoot,
          PULSE_SERVER: `unix:${pulseSocket}`,
        },
        getUid: () => 501,
        inspect: async (path) => {
          if (path === linuxRuntimeRoot) {
            return unsafePath === "runtime"
              ? { ...metadata("directory"), mode: 0o722 }
              : metadata("directory");
          }
          if (path.includes("llm-now-kokoro-player")) return metadata("file");
          if (path === packRoot || path === runtimeRoot) {
            return metadata("directory");
          }
          return metadata("socket", unsafePath === "socket" ? 502 : 501);
        },
        spawn: () => {
          throw new Error("must not spawn");
        },
      }))).rejects.toThrow("player-environment-invalid");
    }
  });
});
