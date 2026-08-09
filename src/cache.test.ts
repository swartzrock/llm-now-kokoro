import { describe, expect, test } from "bun:test";

import { getModelCachePath, prepareModelCache } from "./cache";

describe("model cache", () => {
  test("derives the absolute macOS cache path from a known home directory", () => {
    expect(getModelCachePath("/Users/alice")).toBe(
      "/Users/alice/Library/Caches/kokoro-cli/transformers",
    );
  });

  test("creates the cache directory recursively before returning it", async () => {
    const calls: Array<[string, { recursive: boolean }]> = [];

    const cachePath = await prepareModelCache("/Users/alice", async (path, options) => {
      calls.push([path, options]);
    });

    expect(cachePath).toBe("/Users/alice/Library/Caches/kokoro-cli/transformers");
    expect(calls).toEqual([
      ["/Users/alice/Library/Caches/kokoro-cli/transformers", { recursive: true }],
    ]);
  });
});
