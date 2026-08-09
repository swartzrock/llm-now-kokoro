import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";

import { Tensor } from "@huggingface/transformers";
import { KokoroTTS } from "kokoro-js";

import { assertBunVersion } from "../build";
import {
  EMBEDDED_VOICE_MANIFEST,
  EXPECTED_VOICE_COUNT,
  loadEmbeddedVoice,
  verifyEmbeddedVoices,
} from "./embedded-voices";

const VOICE_PROVIDER = Symbol.for("kokoro-js.voice-provider");
const PACKAGE_VOICE_DIRECTORY = resolve(
  import.meta.dir,
  "../node_modules/kokoro-js/voices",
);

describe("embedded voices", () => {
  test("matches all 54 pinned package voices and includes af_heart", async () => {
    const packageVoices = (await readdir(PACKAGE_VOICE_DIRECTORY))
      .filter((name) => name.endsWith(".bin"))
      .sort();
    const embeddedVoices = Object.keys(EMBEDDED_VOICE_MANIFEST)
      .map((name) => `${name}.bin`)
      .sort();

    expect(EXPECTED_VOICE_COUNT).toBe(54);
    expect(embeddedVoices).toEqual(packageVoices);
    expect(EMBEDDED_VOICE_MANIFEST.af_heart).toBeDefined();
  });

  test("records and verifies the SHA-256 of every embedded voice", async () => {
    const verified = await verifyEmbeddedVoices();

    expect(verified).toHaveLength(EXPECTED_VOICE_COUNT);
    expect(verified).toContain("af_heart");

    for (const [name, voice] of Object.entries(EMBEDDED_VOICE_MANIFEST)) {
      const bytes = await loadEmbeddedVoice(name);
      expect(Bun.CryptoHasher.hash("sha256", bytes, "hex")).toBe(voice.sha256);
    }
  });

  test("lets a standalone provider supply voice bytes", async () => {
    const globals = globalThis as typeof globalThis & Record<symbol, unknown>;
    const voice = new Float32Array(512);
    voice[256] = 42;
    globals[VOICE_PROVIDER] = async () => voice.buffer;
    let receivedStyle: Tensor | undefined;
    const tts = new KokoroTTS(
      (async ({ style }: { style: Tensor }) => {
        receivedStyle = style;
        return {
          waveform: new Tensor("float32", new Float32Array([0]), [1]),
        };
      }) as never,
      null as never,
    );

    try {
      await tts.generate_from_ids({ dims: [1, 3] } as Tensor, {
        voice: "af_alloy",
      });
      expect(receivedStyle?.data[0]).toBe(42);
    } finally {
      delete globals[VOICE_PROVIDER];
    }
  });

  test("keeps Kokoro's package-relative source voice loading as the fallback", async () => {
    delete (globalThis as Record<symbol, unknown>)[VOICE_PROVIDER];
    let receivedStyle: Tensor | undefined;
    const tts = new KokoroTTS(
      (async ({ style }: { style: Tensor }) => {
        receivedStyle = style;
        return {
          waveform: new Tensor("float32", new Float32Array([0]), [1]),
        };
      }) as never,
      null as never,
    );

    await tts.generate_from_ids({ dims: [1, 3] } as Tensor, {
      voice: "af_heart",
    });

    const packageBytes = await Bun.file(
      resolve(PACKAGE_VOICE_DIRECTORY, "af_heart.bin"),
    ).arrayBuffer();
    expect(receivedStyle?.data[0]).toBe(new Float32Array(packageBytes)[256]);
  });
});

describe("standalone build preflight", () => {
  test("rejects an unqualified Bun version before compilation", () => {
    expect(() => assertBunVersion("1.3.13")).toThrow(
      "Bun 1.3.14 is required",
    );
    expect(() => assertBunVersion("1.3.14")).not.toThrow();
  });
});
