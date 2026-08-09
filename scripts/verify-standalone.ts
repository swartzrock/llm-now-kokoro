import { cp, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

import { assertBunVersion } from "../build";
import { EXPECTED_VOICE_COUNT } from "../src/embedded-voices";
import { ADDON_NAME, DYLIB_NAME } from "../src/native-runtime";

interface CommandResult {
  stdout: string;
  stderr: string;
  elapsedMs: number;
}

export interface StandaloneVerificationResult {
  binaryBytes: number;
  cold: CommandResult;
  warm: CommandResult;
  sidecars: string[];
  pathAudit: "verified" | "unavailable";
}

export interface StandaloneVerificationOptions {
  binaryPath?: string;
}

export async function verifyStandalone(
  options: StandaloneVerificationOptions = {},
): Promise<StandaloneVerificationResult> {
  assertBunVersion();
  const sourceBinary = resolve(
    options.binaryPath ?? resolve(import.meta.dir, "../dist/kokoro-cli"),
  );
  const binaryFile = Bun.file(sourceBinary);
  if (!(await binaryFile.exists())) {
    throw new Error(`Standalone binary not found: ${sourceBinary}`);
  }

  const root = await mkdtemp(join(tmpdir(), "kokoro-standalone-"));
  const room = join(root, "room");
  const home = join(root, "home");
  const runtimeTemp = join(root, "runtime-tmp");
  const copiedBinary = join(room, basename(sourceBinary));

  try {
    await mkdir(room);
    await mkdir(home);
    await mkdir(runtimeTemp);
    await cp(sourceBinary, copiedBinary);

    const baseEnvironment: Record<string, string> = {
      HOME: home,
      TMPDIR: runtimeTemp,
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      LANG: process.env.LANG ?? "en_US.UTF-8",
      NO_COLOR: "1",
    };
    const multilingualVoiceArguments = ["--voice", "jf_alpha"];

    const selfCheck = await run(copiedBinary, ["Embedded voice self-check."], room, {
      ...baseEnvironment,
      KOKORO_STANDALONE_VOICE_SELF_CHECK: "1",
    });
    const selfCheckResult = parseLastJsonLine(selfCheck.stdout);
    if (
      selfCheckResult.voiceCount !== EXPECTED_VOICE_COUNT ||
      selfCheckResult.hasAfHeart !== true ||
      selfCheckResult.status !== "ok"
    ) {
      throw new Error(`Standalone embedded-voice self-check failed: ${selfCheck.stdout}`);
    }

    const cold = await run(
      copiedBinary,
      [...multilingualVoiceArguments, "Standalone cold-cache playback check."],
      room,
      { ...baseEnvironment, DYLD_PRINT_LIBRARIES: "1" },
    );
    assertCompletedSpeech("cold", cold);
    const pathAudit = auditLoadedPaths(
      cold.stderr,
      resolve(import.meta.dir, ".."),
      runtimeTemp,
    );

    const warm = await run(
      copiedBinary,
      [...multilingualVoiceArguments, "Standalone warm offline playback check."],
      room,
      { ...baseEnvironment, KOKORO_OFFLINE: "1" },
    );
    assertCompletedSpeech("warm offline", warm);

    const sidecars = [
      ...(await findSidecars(room)),
      ...(await findSidecars(runtimeTemp)),
    ];
    if (sidecars.length > 0) {
      throw new Error(
        `Standalone left persistent native or voice sidecars: ${sidecars.join(", ")}`,
      );
    }

    return {
      binaryBytes: binaryFile.size,
      cold,
      warm,
      sidecars,
      pathAudit,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function run(
  executable: string,
  arguments_: string[],
  cwd: string,
  env: Record<string, string>,
): Promise<CommandResult> {
  const startedAt = performance.now();
  const child = Bun.spawn([executable, ...arguments_], {
    cwd,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  const result = {
    stdout,
    stderr,
    elapsedMs: Math.round(performance.now() - startedAt),
  };

  if (exitCode !== 0) {
    throw new Error(
      `Standalone exited ${exitCode}: ${stderr.trim() || stdout.trim()}`,
    );
  }

  return result;
}

function assertCompletedSpeech(label: string, result: CommandResult): void {
  if (result.stdout !== "") {
    throw new Error(`${label} standalone CLI unexpectedly wrote to stdout`);
  }
  if (!result.stderr.includes("Loading Kokoro q8 model")) {
    throw new Error(`${label} standalone CLI did not report model loading`);
  }
}

function parseLastJsonLine(output: string): Record<string, unknown> {
  const line = output.trim().split("\n").at(-1);
  if (!line) {
    throw new Error("Standalone produced no JSON result");
  }

  return JSON.parse(line) as Record<string, unknown>;
}

function auditLoadedPaths(
  stderr: string,
  projectRoot: string,
  runtimeTemp: string,
): "verified" | "unavailable" {
  const cleanRoot = resolve(runtimeTemp, "..");
  const loadedPaths = stderr
    .split("\n")
    .filter((line) => line.startsWith("dyld[") && line.includes("/"));
  if (loadedPaths.length === 0) return "unavailable";

  const forbidden = loadedPaths.filter(
    (line) =>
      line.includes("/node_modules/") ||
      (line.includes(projectRoot) && !line.includes(cleanRoot)),
  );
  if (forbidden.length > 0) {
    throw new Error(`Standalone loaded project dependency paths: ${forbidden.join(", ")}`);
  }

  for (const name of [ADDON_NAME, DYLIB_NAME]) {
    const line = loadedPaths.find((candidate) => candidate.includes(name));
    if (!line || !line.includes(runtimeTemp)) {
      throw new Error(`Standalone native path audit did not find ephemeral ${name}`);
    }
  }

  return "verified";
}

async function findSidecars(directory: string): Promise<string[]> {
  const sidecars: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      sidecars.push(...(await findSidecars(path)));
    } else if (/\.(?:bin|dylib|node|wav)$/.test(entry.name)) {
      sidecars.push(path);
    }
  }
  return sidecars;
}

if (import.meta.main) {
  const result = await verifyStandalone();
  console.log(
    JSON.stringify(
      {
        status: "ok",
        binaryBytes: result.binaryBytes,
        coldMs: result.cold.elapsedMs,
        warmMs: result.warm.elapsedMs,
        sidecars: result.sidecars,
        pathAudit: result.pathAudit,
      },
      null,
      2,
    ),
  );
}
