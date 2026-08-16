import { describe, expect, test } from "bun:test";

import { resolveBunCompileTarget } from "./backend";

describe("Bun helper compile target", () => {
  test.each([
    ["darwin", "x64", "bun-darwin-x64-baseline"],
    ["darwin", "arm64", "bun-darwin-arm64"],
    ["linux", "x64", "bun-linux-x64-baseline"],
    ["linux", "arm64", "bun-linux-arm64"],
    ["win32", "x64", "bun-windows-x64-baseline"],
  ] as const)("selects %s-%s", (platform, architecture, expected) => {
    expect(resolveBunCompileTarget(platform, architecture)).toBe(expected);
  });

  test("rejects unsupported targets", () => {
    expect(() => resolveBunCompileTarget("win32", "arm64")).toThrow(
      "unsupported-runtime-target",
    );
  });
});
