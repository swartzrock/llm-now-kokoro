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
      ).toEqual({ operation, requiredCapabilities: [] });
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
    ).toEqual({
      operation: "info",
      requiredCapabilities: [PROTOCOL_CAPABILITIES[0]],
    });
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
    });
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
    [encoder.encode('{"text":"hello","voice":"af_bella"}'), "invalid-request"],
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
    expect(contract.capabilities).toEqual(PROTOCOL_CAPABILITIES);
    expect(contract.limits.requestBytes).toBe(MAX_REQUEST_BYTES);
    expect(contract.limits.textUnicodeScalars).toBe(MAX_TEXT_SCALARS);
  });
});
