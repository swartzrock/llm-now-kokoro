import { MAX_DIAGNOSTIC_BYTES } from "../src/limits";
import {
  ARCHITECTURE_HELPER_PATH,
  ARCHITECTURE_INSTALL_ROOT,
  buildArchitectureSmoke,
} from "./build-architecture-smoke";
import { runOfflineInferenceSmoke } from "./run-offline-inference-smoke";

await buildArchitectureSmoke();
await runOfflineInferenceSmoke(ARCHITECTURE_INSTALL_ROOT);

const playerMode = process.argv.includes("--play") ? "play" : "check";
const info = await invokeHelper(["info", "--protocol-major", "1"]);
const parsedInfo = JSON.parse(info.stdout) as {
  engine?: {
    inference?: string;
    model?: string;
    voice?: string;
    speed?: number;
  };
  protocolMajor?: number;
};
if (
  info.stderr !== "" ||
  parsedInfo.protocolMajor !== 1 ||
  parsedInfo.engine?.inference !== "onnxruntime-node-cpu" ||
  parsedInfo.engine.model !== "q8" ||
  parsedInfo.engine.voice !== "af_heart" ||
  parsedInfo.engine.speed !== 1
) {
  throw new Error("Architecture helper returned invalid info");
}

const operation = playerMode === "play" ? "speak" : "self-test";
const result = await invokeHelper(
  [operation, "--protocol-major", "1"],
  operation === "speak"
    ? new TextEncoder().encode(
        JSON.stringify({ text: "Native sidecar architecture check." }),
      )
    : undefined,
);
if (result.stdout !== "" || result.stderr !== "") {
  throw new Error("Architecture helper was not silent");
}
console.log(
  JSON.stringify({
    status: "ok",
    helper: "production",
    target: `${process.platform}-${process.arch}`,
    model: "q8",
    voice: "af_heart",
    playerMode,
  }),
);

async function invokeHelper(
  arguments_: string[],
  stdin?: Uint8Array,
): Promise<{ stdout: string; stderr: string }> {
  const child = Bun.spawn([ARCHITECTURE_HELPER_PATH, ...arguments_], {
    cwd: ARCHITECTURE_INSTALL_ROOT,
    env: process.platform === "linux" ? { LANG: "C.UTF-8" } : {},
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  });
  if (stdin) child.stdin.write(stdin);
  child.stdin.end();
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    readBounded(child.stdout),
    readBounded(child.stderr),
  ]);
  if (exitCode !== 0) {
    throw new Error(`Architecture helper failed with exit ${exitCode}`);
  }
  return { stdout, stderr };
}

async function readBounded(
  stream: ReadableStream<Uint8Array>,
): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      chunks.push(next.value);
      total += next.value.byteLength;
      if (total > MAX_DIAGNOSTIC_BYTES) {
        await reader.cancel().catch(() => {});
        throw new Error("Architecture helper output exceeded its protocol bound");
      }
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } finally {
    for (const chunk of chunks) chunk.fill(0);
    reader.releaseLock();
  }
}
