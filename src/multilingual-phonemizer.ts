import ESpeakNg from "espeak-ng";

import type { VoiceLanguage } from "./voices";

// @ts-expect-error Bun embeds file-loader imports in compiled executables.
import espeakWasmPath from "../node_modules/espeak-ng/dist/espeak-ng.wasm" with { type: "file" };

let wasmBinary: Promise<Uint8Array> | undefined;

export async function phonemizeMultilingual(
  text: string,
  language: Exclude<VoiceLanguage, "en-us" | "en-gb">,
): Promise<string> {
  wasmBinary ??= Bun.file(espeakWasmPath).bytes();
  const espeak = await ESpeakNg({
    arguments: [
      "--phonout",
      "phonemes",
      '--sep=""',
      "-q",
      "-b",
      "1",
      "--ipa=3",
      "-v",
      language,
      "--",
      text,
    ],
    wasmBinary: await wasmBinary,
  });

  return espeak.FS.readFile("phonemes", { encoding: "utf8" })
    .trim()
    .replace(/\s*\n+\s*/g, ", ");
}
