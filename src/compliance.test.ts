import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");

describe("release-oriented repository posture", () => {
  test("uses a private package with exact dependency versions", async () => {
    const packageJson = await Bun.file(resolve(root, "package.json")).json();

    expect(packageJson.name).toBe("llm-now-kokoro");
    expect(packageJson.private).toBe(true);
    for (const version of Object.values({
      ...packageJson.dependencies,
      ...packageJson.devDependencies,
    })) {
      expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });

  test("records GPL posture without claiming release clearance", async () => {
    const [license, notices, releasing] = await Promise.all([
      Bun.file(resolve(root, "LICENSE")).text(),
      Bun.file(resolve(root, "THIRD_PARTY_NOTICES.md")).text(),
      Bun.file(resolve(root, "docs/RELEASING.md")).text(),
    ]);

    expect(license).toContain("GNU GENERAL PUBLIC LICENSE");
    expect(license).toContain("Version 3");
    expect(notices).toContain(
      "193481f474f7c1ea81df3195d18b45df8ef7254dbdccb3f193d60215c4897bec",
    );
    expect(notices).toContain(
      "4b4454422468c6195d70a3f50eaed157293d6a7af3e509a0612c2abcdb7defa5",
    );
    expect(notices).toContain("No raw WebAssembly module was identified");
    expect(releasing).toContain("**BLOCKED.**");
    expect(releasing).not.toContain("UNBLOCKED");
    expect(releasing).toContain("source/relink");
  });
});
