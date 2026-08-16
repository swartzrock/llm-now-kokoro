import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

const entryPoint = resolve(import.meta.dir, "../index.ts");

async function runSource(arguments_: string[], home: string, stdin = "") {
  const child = Bun.spawn([process.execPath, entryPoint, ...arguments_], {
    env: { ...process.env, HOME: home },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  child.stdin.write(stdin);
  child.stdin.end();
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

describe("source helper protocol", () => {
  test("emits the canonical info response", async () => {
    const home = await mkdtemp(join(import.meta.dir, ".tmp-helper-home-"));

    try {
      const [result, fixture] = await Promise.all([
        runSource(["info", "--protocol-major", "1"], home),
        Bun.file(
          resolve(
            import.meta.dir,
            "../protocol/v1/fixtures/info-success.stdout.json",
          ),
        ).text(),
      ]);

      expect(result).toEqual({ exitCode: 0, stdout: fixture, stderr: "" });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test.each([
    [["speak", "--protocol-major", "1"], '{"text":" \\n"}', 1],
    [["speak", "--protocol-major", "0"], '{"text":"unread"}', 2],
    [["--help"], "", 2],
  ])(
    "rejects an invalid pack or protocol before creating legacy cache state",
    async (arguments_, stdin, expectedExitCode) => {
      const home = await mkdtemp(join(import.meta.dir, ".tmp-helper-home-"));

      try {
        const result = await runSource(arguments_, home, stdin);

        expect(result.exitCode).toBe(expectedExitCode);
        expect(result.stdout).toBe("");
        expect(result.stderr).toStartWith("llm-now-kokoro: ");
        expect(result.stderr).not.toContain("unread");
        expect(
          await Bun.file(
            join(home, "Library/Caches/kokoro-cli/transformers"),
          ).exists(),
        ).toBe(false);
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    },
  );
});
