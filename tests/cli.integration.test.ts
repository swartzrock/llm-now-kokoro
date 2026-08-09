import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

const entryPoint = resolve(import.meta.dir, "../index.ts");

async function runSource(arguments_: string[], home: string) {
  const child = Bun.spawn([process.execPath, entryPoint, ...arguments_], {
    env: { ...process.env, HOME: home },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

describe("source CLI argument validation", () => {
  test.each([
    [[], 'Usage: kokoro-cli "text to speak"'],
    [["   "], "Text must contain non-whitespace characters."],
    [["hello", "world"], 'Usage: kokoro-cli "text to speak"'],
  ])("fails before creating the model cache", async (arguments_, expected) => {
    const home = await mkdtemp(join(import.meta.dir, ".tmp-kokoro-cli-home-"));

    try {
      const result = await runSource(arguments_, home);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(expected);
      expect(result.stderr).not.toContain("    at ");
      expect(
        await Bun.file(
          join(home, "Library/Caches/kokoro-cli/transformers"),
        ).exists(),
      ).toBe(false);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
