import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import {
  MAX_REQUEST_BYTES,
  MAX_TEXT_SCALARS,
  PROTOCOL_CAPABILITIES,
  PROTOCOL_MAJOR,
  decodeSpeakRequest,
  encodeInfoResponse,
  parseHelperArguments,
} from "./protocol";
import { HelperFailure } from "./result";
import { SUPPORTED_VOICES } from "./voices";

const encoder = new TextEncoder();

function expectProtocolFailure(run: () => unknown, diagnostic: string): void {
  try {
    run();
    throw new Error("Expected protocol failure");
  } catch (error) {
    expect(error).toBeInstanceOf(HelperFailure);
    expect((error as HelperFailure).exitCode).toBe(2);
    expect((error as HelperFailure).diagnostic).toBe(diagnostic);
  }
}

describe("helper operation protocol", () => {
  test.each(["info", "self-test", "speak"] as const)(
    "accepts the exact protocol major for %s",
    (operation) => {
      expect(
        parseHelperArguments([
          operation,
          "--protocol-major",
          String(PROTOCOL_MAJOR),
        ]),
      ).toEqual({ operation });
    },
  );

  test("accepts known required capabilities", () => {
    expect(
      parseHelperArguments([
        "info",
        "--protocol-major",
        "1",
        "--require-capability",
        PROTOCOL_CAPABILITIES[0],
      ]),
    ).toEqual({ operation: "info" });
  });

  test.each([
    [["info"], "protocol-usage"],
    [["info", "--protocol-major", "0"], "protocol-major-mismatch"],
    [["info", "--protocol-major", "2"], "protocol-major-mismatch"],
    [["info", "--protocol-major", "1", "answer text"], "protocol-usage"],
    [["help", "--protocol-major", "1"], "protocol-usage"],
    [
      [
        "info",
        "--protocol-major",
        "1",
        "--require-capability",
        "unknown-capability",
      ],
      "unsupported-capability",
    ],
  ])("rejects invalid or incompatible argv", (arguments_, diagnostic) => {
    expectProtocolFailure(
      () => parseHelperArguments(arguments_ as string[]),
      diagnostic as string,
    );
  });
});

describe("speak request protocol", () => {
  test("preserves quotes, newlines, Unicode, and shell metacharacters", () => {
    const text = '"hello"\nGrüße 😀; $(touch nope) | & < >';
    expect(decodeSpeakRequest(encoder.encode(JSON.stringify({ text })))).toEqual({
      text,
      voice: "af_heart",
    });
  });

  test("accepts an allowlisted voice and rejects unknown or path-like voices", () => {
    expect(
      decodeSpeakRequest(
        encoder.encode(JSON.stringify({ text: "Bonjour", voice: "ff_siwis" })),
      ),
    ).toEqual({ text: "Bonjour", voice: "ff_siwis" });

    for (const voice of ["unknown", "../ff_siwis", "ff_siwis.bin"]) {
      expectProtocolFailure(
        () =>
          decodeSpeakRequest(
            encoder.encode(JSON.stringify({ text: "Bonjour", voice })),
          ),
        "unsupported-voice",
      );
    }
  });

  test("counts Unicode scalar values instead of UTF-16 code units", () => {
    const text = "😀".repeat(MAX_TEXT_SCALARS);
    expect(decodeSpeakRequest(encoder.encode(JSON.stringify({ text }))).text).toBe(
      text,
    );
  });

  test.each([
    [encoder.encode("{"), "malformed-request"],
    [new Uint8Array([0xc3, 0x28]), "invalid-utf8"],
    [encoder.encode('{"text":"a\\u0000b"}'), "nul-text"],
    [encoder.encode('{"text":" \\t\\n"}'), "blank-text"],
    [encoder.encode('{"text":"\\ud800"}'), "invalid-unicode-scalar"],
    [encoder.encode('{"text":"hello","language":"fr"}'), "invalid-request"],
    [encoder.encode('{"text":42}'), "invalid-request"],
    [encoder.encode("[]"), "invalid-request"],
    [new Uint8Array(MAX_REQUEST_BYTES + 1), "request-too-large"],
  ])("rejects invalid request bytes", (bytes, diagnostic) => {
    expectProtocolFailure(
      () => decodeSpeakRequest(bytes as Uint8Array),
      diagnostic as string,
    );
  });

  test("rejects more than 500 Unicode scalar values without truncation", () => {
    const text = "😀".repeat(MAX_TEXT_SCALARS + 1);
    expectProtocolFailure(
      () => decodeSpeakRequest(encoder.encode(JSON.stringify({ text }))),
      "text-too-long",
    );
  });
});

describe("canonical protocol fixtures", () => {
  test("the speak fixture decodes to the exact canonical text", async () => {
    const fixture = new Uint8Array(await Bun.file(
      resolve(import.meta.dir, "../protocol/v1/fixtures/speak-valid.stdin.json"),
    ).arrayBuffer());

    expect(new TextDecoder().decode(fixture)).toBe(
      '{"text":"\\"Hello\\"\\nGrüße 😀; $(echo no) | & < >"}\n',
    );
    expect(decodeSpeakRequest(fixture)).toEqual({
      text: '"Hello"\nGrüße 😀; $(echo no) | & < >',
      voice: "af_heart",
    });
  });

  test("the generated info response equals the golden fixture byte-for-byte", async () => {
    const fixture = await Bun.file(
      resolve(import.meta.dir, "../protocol/v1/fixtures/info-success.stdout.json"),
    ).text();

    expect(encodeInfoResponse()).toBe(fixture);
  });

  test("the checked-in contract carries the implementation limits", async () => {
    const contract = await Bun.file(
      resolve(import.meta.dir, "../protocol/v1/contract.json"),
    ).json();

    expect(contract.protocolMajor).toBe(PROTOCOL_MAJOR);
    expect(contract.capabilities).toEqual(Array.from(PROTOCOL_CAPABILITIES));
    expect(Object.keys(contract.capabilityDefinitions)).toEqual(
      Array.from(PROTOCOL_CAPABILITIES),
    );
    expect(contract.infoResponse.schema.required).toEqual([
      "helperVersion",
      "protocolMajor",
      "capabilities",
      "engine",
    ]);
    expect(
      contract.infoResponse.schema.properties.capabilities.prefixItems.map(
        (item: { const: string }) => item.const,
      ),
    ).toEqual(Array.from(PROTOCOL_CAPABILITIES));
    expect(contract.infoResponse.schema.properties.engine.properties).toEqual({
      inference: { const: "onnxruntime-node-cpu" },
      model: { const: "q8" },
      voice: { const: "af_heart" },
      voices: {
        type: "array",
        items: { $ref: "#/$defs/voice" },
        minItems: 55,
        maxItems: 55,
        uniqueItems: true,
      },
      speed: { const: 1 },
    });
    expect(contract.$defs.voice.enum).toEqual(Array.from(SUPPORTED_VOICES));
    expect(contract.limits.requestBytes).toBe(MAX_REQUEST_BYTES);
    expect(contract.limits.textUnicodeScalars).toBe(MAX_TEXT_SCALARS);
  });
});
