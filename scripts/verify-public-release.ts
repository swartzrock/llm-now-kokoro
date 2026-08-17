import { chmod, copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type { SupportedRuntimeTarget } from "../src/backend";
import { SUPPORTED_RUNTIME_TARGETS } from "../src/backend";
import { MAX_DIAGNOSTIC_BYTES } from "../src/limits";
import {
  encodeInfoResponse,
  HELPER_VERSION,
  PROTOCOL_MAJOR,
} from "../src/protocol";
import { inspectRegularFile } from "./release-manifest";
import type { RootReleaseManifest } from "./secure-release";

const PUBLIC_HELPER_TIMEOUT_MS = 130_000;

interface PublicHelperResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}

export async function verifyPublicRelease(
  downloadRoot: string,
  target: SupportedRuntimeTarget,
): Promise<void> {
  if (!SUPPORTED_RUNTIME_TARGETS.includes(target)) throw new Error("unsupported-runtime-target");
  const manifestPath = resolve(
    downloadRoot,
    `llm-now-kokoro-${HELPER_VERSION}-root-manifest.json`,
  );
  const manifest = await Bun.file(manifestPath).json() as RootReleaseManifest;
  const selected = manifest.files.filter(
    (file) => file.assetClass === "shared" || file.target === target,
  );
  if (!selected.some((file) => file.target === target) ||
      !selected.some((file) => file.assetClass === "shared")) {
    throw new Error("public-release-target-incomplete");
  }
  const installRoot = await mkdtemp(resolve(downloadRoot, ".clean install ü-"));
  try {
    for (const file of selected) {
      const source = resolve(downloadRoot, file.releaseFilename);
      const inspected = await inspectRegularFile(source);
      if (inspected.bytes !== file.bytes || inspected.sha256 !== file.sha256) {
        throw new Error(`public-release-digest-mismatch:${file.releaseFilename}`);
      }
      const destination = resolve(installRoot, file.logicalDestination);
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(source, destination);
      await chmod(destination, file.mode === "0755" ? 0o755 : 0o644);
    }
    const helper = resolve(
      installRoot,
      target === "win32-x64" ? "llm-now-kokoro.exe" : "llm-now-kokoro",
    );
    const environment: Record<string, string> = {
      HOME: resolve(installRoot, "no-home"),
      HTTPS_PROXY: "http://127.0.0.1:9",
      HTTP_PROXY: "http://127.0.0.1:9",
      NO_PROXY: "",
      PATH: resolve(installRoot, "no-system-tools"),
    };
    if (process.platform === "win32") {
      for (const name of ["SYSTEMROOT", "WINDIR", "TEMP", "TMP"]) {
        if (process.env[name]) environment[name] = process.env[name]!;
      }
    }
    await runAndValidatePublicHelper(
      [helper, "info", "--protocol-major", String(PROTOCOL_MAJOR)],
      installRoot,
      environment,
      "info",
    );
    await runAndValidatePublicHelper(
      [helper, "self-test", "--protocol-major", String(PROTOCOL_MAJOR)],
      installRoot,
      environment,
      "self-test",
    );
  } finally {
    await rm(installRoot, { recursive: true, force: true });
  }
}

export async function runAndValidatePublicHelper(
  command: string[],
  cwd: string,
  env: Record<string, string>,
  operation: "info" | "self-test",
  timeoutMilliseconds = PUBLIC_HELPER_TIMEOUT_MS,
): Promise<void> {
  const result = await runPublicHelper(command, cwd, env, timeoutMilliseconds);
  const valid = operation === "info"
    ? result.exitCode === 0 &&
      result.stderr === "" &&
      result.stdout === encodeInfoResponse()
    : result.exitCode === 0 && result.stdout === "" && result.stderr === "";
  if (!valid) throw new Error(`public-clean-host-smoke-failed:${operation}`);
}

async function runPublicHelper(
  command: string[],
  cwd: string,
  env: Record<string, string>,
  timeoutMilliseconds: number,
): Promise<PublicHelperResult> {
  const child = Bun.spawn(command, {
    cwd,
    env,
    stdin: "ignore",
    stderr: "pipe",
    stdout: "pipe",
    windowsHide: true,
  });
  const outputController = new AbortController();
  const stdout = readBounded(child.stdout, outputController.signal);
  const stderr = readBounded(child.stderr, outputController.signal);
  const completion = Promise.all([child.exited, stdout, stderr]);
  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    const [exitCode, stdoutText, stderrText] = await Promise.race([
      completion,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("public-helper-timeout")),
          timeoutMilliseconds,
        );
      }),
    ]);
    return { exitCode, stderr: stderrText, stdout: stdoutText };
  } catch (error) {
    outputController.abort();
    try {
      if (process.platform === "win32") child.kill();
      else child.kill("SIGKILL");
    } catch {
      // The process may have exited between the failed read and termination.
    }
    await Promise.allSettled([child.exited, stdout, stderr]);
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function readBounded(
  stream: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      if (signal.aborted) throw new Error("public-helper-output-cancelled");
      const next = await reader.read();
      if (next.done) break;
      chunks.push(next.value);
      total += next.value.byteLength;
      if (total > MAX_DIAGNOSTIC_BYTES) {
        await reader.cancel().catch(() => {});
        throw new Error("public-helper-output-too-large");
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
    signal.removeEventListener("abort", cancel);
    for (const chunk of chunks) chunk.fill(0);
    reader.releaseLock();
  }
}

if (import.meta.main) {
  const [downloadRoot, target] = process.argv.slice(2);
  if (!downloadRoot || !target) throw new Error("usage: verify-public-release <download-root> <target>");
  await verifyPublicRelease(downloadRoot, target as SupportedRuntimeTarget);
}
