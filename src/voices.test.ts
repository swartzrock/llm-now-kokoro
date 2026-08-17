import { describe, expect, test } from "bun:test";

import {
  DEFAULT_VOICE,
  SUPPORTED_VOICES,
  languageForVoice,
} from "./voices";
import { phonemizeMultilingual } from "./multilingual-phonemizer";

describe("supported Kokoro voices", () => {
  test("pins every upstream voice and preserves af_heart as the default", () => {
    expect(DEFAULT_VOICE).toBe("af_heart");
    expect(SUPPORTED_VOICES).toHaveLength(55);
    expect(SUPPORTED_VOICES).toContain("af");
    expect(SUPPORTED_VOICES).toContain("ff_siwis");
    expect(SUPPORTED_VOICES).toContain("zm_yunyang");
  });

  test.each([
    ["af_heart", "en-us"],
    ["bf_emma", "en-gb"],
    ["ef_dora", "es"],
    ["ff_siwis", "fr-fr"],
    ["hf_alpha", "hi"],
    ["if_sara", "it"],
    ["jf_alpha", "ja"],
    ["pf_dora", "pt"],
    ["zf_xiaobei", "cmn"],
  ] as const)("maps %s to the %s phonemizer", (voice, language) => {
    expect(languageForVoice(voice)).toBe(language);
  });

  test("phonemizes French text with French eSpeak data", async () => {
    expect(
      await phonemizeMultilingual("Bonjour, comment allez-vous ?", "fr-fr"),
    ).toBe("bɔ̃ʒˈuʁ, kɔmˌɑ̃ alˈevˈu");
  });

  test.each([
    ["Hola, mundo.", "es"],
    ["Bonjour, le monde.", "fr-fr"],
    ["नमस्ते दुनिया", "hi"],
    ["Buongiorno, mondo.", "it"],
    ["こんにちは世界", "ja"],
    ["Olá, mundo.", "pt"],
    ["你好，世界", "cmn"],
  ] as const)("loads the real %s language data", async (text, language) => {
    expect(await phonemizeMultilingual(text, language)).not.toBe("");
  });
});
