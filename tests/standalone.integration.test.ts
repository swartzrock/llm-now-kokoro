import { expect, test } from "bun:test";

import { buildStandalone } from "../build";
import { verifyStandalone } from "../scripts/verify-standalone";

const integrationEnabled = process.env.KOKORO_STANDALONE_TEST === "1";

test.skipIf(!integrationEnabled)(
  "compiled executable synthesizes cold and warm-offline from a clean room",
  async () => {
    await buildStandalone();
    const result = await verifyStandalone();

    expect(result.binaryBytes).toBeGreaterThan(0);
    expect(JSON.parse(result.cold.stdout).samples).toBeGreaterThan(0);
    expect(JSON.parse(result.warm.stdout).samples).toBeGreaterThan(0);
    expect(result.sidecars).toEqual([]);
    expect(result.pathAudit).toBe("verified");
  },
  600_000,
);
