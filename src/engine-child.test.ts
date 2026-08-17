import { describe, expect, test } from "bun:test";

import { createAudioMessage } from "./engine-child";

describe("engine child IPC", () => {
  test("keeps the queued audio payload independent from cleanup", () => {
    const source = new Uint8Array([1, 2, 3, 4]);

    const message = createAudioMessage(source, 1);
    source.fill(0);

    expect(message.bytes).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(message.bytes).not.toBe(source);
  });
});
