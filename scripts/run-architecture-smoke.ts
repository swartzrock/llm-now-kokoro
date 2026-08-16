import { resolve } from "node:path";
import { mkdir } from "node:fs/promises";

import { ARCHITECTURE_ASSET_ROOT } from "./architecture-assets";
import {
  ARCHITECTURE_HELPER_PATH,
  ARCHITECTURE_PLAYER_PATH,
  ARCHITECTURE_RUNTIME_ROOT,
  buildArchitectureSmoke,
} from "./build-architecture-smoke";

await buildArchitectureSmoke();

const playerMode = process.argv.includes("--play") ? "play" : "check";
const temporaryDirectory = resolve(
  import.meta.dir,
  "../.tmp-architecture-smoke/runtime-tmp",
);
await mkdir(temporaryDirectory, { recursive: true });
const child = Bun.spawn(
  [
    ARCHITECTURE_HELPER_PATH,
    "--runtime-root",
    ARCHITECTURE_RUNTIME_ROOT,
    "--asset-root",
    ARCHITECTURE_ASSET_ROOT,
    "--player",
    ARCHITECTURE_PLAYER_PATH,
    "--player-mode",
    playerMode,
  ],
  {
    cwd: ARCHITECTURE_RUNTIME_ROOT,
    env: {
      ...process.env,
      TMPDIR: temporaryDirectory,
      TEMP: temporaryDirectory,
      TMP: temporaryDirectory,
      LANG: "C.UTF-8",
      HTTP_PROXY: "http://127.0.0.1:9",
      HTTPS_PROXY: "http://127.0.0.1:9",
      NO_PROXY: "",
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  },
);
const [exitCode, stdout, stderr] = await Promise.all([
  child.exited,
  new Response(child.stdout).text(),
  new Response(child.stderr).text(),
]);
if (exitCode !== 0) {
  throw new Error(`Architecture helper failed (${exitCode}): ${stderr.slice(0, 2_000)}`);
}
const result = JSON.parse(stdout) as { status?: string };
if (result.status !== "ok") throw new Error("Architecture helper returned invalid output");
console.log(stdout.trim());
