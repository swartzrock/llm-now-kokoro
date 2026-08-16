import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";

import { encodeInfoResponse } from "../src/protocol";
import { runAndValidatePublicHelper } from "./verify-public-release";

let fixtureRoot: string;
let fixturePath: string;

beforeAll(async () => {
  fixtureRoot = await mkdtemp(resolve(import.meta.dir, ".tmp-public-verifier-"));
  fixturePath = resolve(fixtureRoot, "fixture-helper.js");
  await Bun.write(fixturePath, `
const operation = process.argv[2];
const mode = process.env.FIXTURE_MODE;
if (mode === "hang") await new Promise(() => {});
if (mode === "flood") process.stdout.write("x".repeat(20_000));
if (operation === "info") process.stdout.write(process.env.FIXTURE_INFO ?? "");
if (operation === "self-test" && mode === "noisy") process.stderr.write("noise\\n");
`);
});

afterAll(async () => {
  await rm(fixtureRoot, { recursive: true, force: true });
});

function run(
  operation: "info" | "self-test",
  environment: Record<string, string>,
  timeoutMilliseconds = 2_000,
): Promise<void> {
  const bunExecutable = Bun.which("bun");
  if (!bunExecutable) throw new Error("bun-test-executable-missing");
  return runAndValidatePublicHelper(
    [bunExecutable, fixturePath, operation],
    fixtureRoot,
    environment,
    operation,
    timeoutMilliseconds,
  );
}

describe("public release helper verification", () => {
  test("accepts canonical info and a silent self-test", async () => {
    await expect(run("info", { FIXTURE_INFO: encodeInfoResponse() })).resolves.toBeUndefined();
    await expect(run("self-test", {})).resolves.toBeUndefined();
  });

  test("rejects a successful info response with a malformed schema", async () => {
    const malformed = `${JSON.stringify({ protocolMajor: 1 })}\n`;
    await expect(run("info", { FIXTURE_INFO: malformed })).rejects.toThrow(
      "public-clean-host-smoke-failed:info",
    );
  });

  test("rejects a successful but noisy self-test", async () => {
    await expect(run("self-test", { FIXTURE_MODE: "noisy" })).rejects.toThrow(
      "public-clean-host-smoke-failed:self-test",
    );
  });

  test("terminates a helper that exceeds its deadline", async () => {
    const started = performance.now();
    await expect(run("self-test", { FIXTURE_MODE: "hang" }, 50)).rejects.toThrow(
      "public-helper-timeout",
    );
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  test("rejects output beyond the protocol bound", async () => {
    await expect(run("info", { FIXTURE_MODE: "flood" })).rejects.toThrow(
      "public-helper-output-too-large",
    );
  });
});
