import { cp, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

import type { SupportedRuntimeTarget } from "../src/backend";
import { resolveRuntimeTarget } from "../src/backend";
import { verifyLocalModelAssets } from "../src/model-assets";
import { PROTOCOL_MAJOR } from "../src/protocol";
import {
  ARCHITECTURE_INSTALL_ROOT,
  buildArchitectureSmoke,
} from "./build-architecture-smoke";
import {
  SHARED_RELEASE_FILES,
  TARGET_COMPATIBILITY,
  runtimeReleaseFiles,
} from "./release-inventory";
import {
  assertFirstTargetSizeBudget,
  manifestBytes,
} from "./release-manifest";
import { assembleReleaseSet } from "./release-sets";
import {
  assertPinnedSharedManifest,
  assertReleaseInventory,
  compatibilityBlockers,
  inspectOnnxModel,
} from "./release-validation";
import { inspectNativeRelease } from "./native-inspection";

export const RELEASE_ROOT = resolve(import.meta.dir, "../dist/release");
const RELEASE_SOURCE_ROOT = resolve(import.meta.dir, "../dist/release-source");

export async function buildReleaseSets(): Promise<{
  downloadBytes: number;
  runtimeFiles: number;
  sharedFiles: number;
  target: SupportedRuntimeTarget;
}> {
  await buildArchitectureSmoke();
  const target = `${process.platform}-${process.arch}` as SupportedRuntimeTarget;
  const resolvedTarget = resolveRuntimeTarget();
  if (resolvedTarget.id !== target) throw new Error("release-runner-target-mismatch");

  await rm(RELEASE_SOURCE_ROOT, { recursive: true, force: true });
  await mkdir(RELEASE_SOURCE_ROOT, { recursive: true });
  await Promise.all([
    cp(
      resolve(ARCHITECTURE_INSTALL_ROOT, "model"),
      resolve(RELEASE_SOURCE_ROOT, "model"),
      { recursive: true },
    ),
    cp(
      resolve(import.meta.dir, "../protocol"),
      resolve(RELEASE_SOURCE_ROOT, "protocol"),
      { recursive: true },
    ),
    cp(
      resolve(import.meta.dir, "../LICENSE"),
      resolve(RELEASE_SOURCE_ROOT, "LICENSE"),
    ),
    cp(
      resolve(import.meta.dir, "../THIRD_PARTY_NOTICES.md"),
      resolve(RELEASE_SOURCE_ROOT, "THIRD_PARTY_NOTICES.md"),
    ),
  ]);
  await verifyLocalModelAssets(RELEASE_SOURCE_ROOT);
  const blockedNetworkingVerified = await verifyUnsignedInstalledHelper();

  const [runtime, shared] = await Promise.all([
    assembleReleaseSet({
      assetClass: "runtime",
      files: runtimeReleaseFiles(target),
      outputRoot: RELEASE_ROOT,
      sourceRoot: ARCHITECTURE_INSTALL_ROOT,
      target,
    }),
    assembleReleaseSet({
      assetClass: "shared",
      files: SHARED_RELEASE_FILES,
      outputRoot: RELEASE_ROOT,
      sourceRoot: RELEASE_SOURCE_ROOT,
      target: null,
    }),
  ]);
  assertReleaseInventory(runtime.manifest);
  assertReleaseInventory(shared.manifest);
  assertPinnedSharedManifest(shared.manifest);
  const model = await Bun.file(
    resolve(RELEASE_SOURCE_ROOT, "model/onnx/model_quantized.onnx"),
  ).bytes();
  const onnxInspection = inspectOnnxModel(model, []);
  if (onnxInspection.externalData.length > 0 || onnxInspection.opsets.length === 0) {
    throw new Error("onnx-structure-audit-failed");
  }

  const runtimeBytes = manifestBytes(runtime.manifest);
  const sharedBytes = manifestBytes(shared.manifest);
  assertFirstTargetSizeBudget({ runtimeBytes, sharedBytes });
  const compatibilityEvidence = await inspectNativeRelease(
    ARCHITECTURE_INSTALL_ROOT,
    runtime.manifest,
    blockedNetworkingVerified,
  );
  const blockers = compatibilityBlockers(compatibilityEvidence);
  const report = {
    compatibilityEvidence,
    compatibilityPolicy: TARGET_COMPATIBILITY[target],
    downloadBytes: runtimeBytes + sharedBytes,
    onnx: onnxInspection,
    releaseBlockers: blockers,
    releaseEligible: blockers.length === 0,
    runtimeBytes,
    runtimeFiles: runtime.manifest.files.length,
    sharedBytes,
    sharedFiles: shared.manifest.files.length,
    target,
  };
  await Bun.write(
    resolve(RELEASE_ROOT, target, "unsigned-build-report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  return {
    downloadBytes: report.downloadBytes,
    runtimeFiles: report.runtimeFiles,
    sharedFiles: report.sharedFiles,
    target,
  };
}

async function verifyUnsignedInstalledHelper(): Promise<boolean> {
  const helper = resolve(
    ARCHITECTURE_INSTALL_ROOT,
    process.platform === "win32" ? "llm-now-kokoro.exe" : "llm-now-kokoro",
  );
  const hostileEnvironment: Record<string, string> = {
    HOME: resolve(ARCHITECTURE_INSTALL_ROOT, "no-home"),
    HTTPS_PROXY: "http://127.0.0.1:9",
    HTTP_PROXY: "http://127.0.0.1:9",
    NO_PROXY: "",
    PATH: resolve(ARCHITECTURE_INSTALL_ROOT, "no-path"),
  };
  if (process.platform === "linux") {
    hostileEnvironment.LD_LIBRARY_PATH = resolve(
      ARCHITECTURE_INSTALL_ROOT,
      "hostile-loader",
    );
    hostileEnvironment.LANG = "C.UTF-8";
  } else if (process.platform === "darwin") {
    hostileEnvironment.DYLD_LIBRARY_PATH = resolve(
      ARCHITECTURE_INSTALL_ROOT,
      "hostile-loader",
    );
  } else if (process.platform === "win32") {
    for (const name of ["SYSTEMROOT", "WINDIR", "TEMP", "TMP"]) {
      const value = process.env[name];
      if (value) hostileEnvironment[name] = value;
    }
  }
  const info = await invokeHelper(
    helper,
    ["info", "--protocol-major", String(PROTOCOL_MAJOR)],
    hostileEnvironment,
  );
  if (info.exitCode !== 0 || info.stderr || !info.stdout.endsWith("\n")) {
    throw new Error("unsigned-helper-info-failed");
  }
  const selfTest = await invokeHelper(
    helper,
    ["self-test", "--protocol-major", String(PROTOCOL_MAJOR)],
    hostileEnvironment,
  );
  if (selfTest.exitCode !== 0 || selfTest.stdout || selfTest.stderr) {
    throw new Error("unsigned-helper-self-test-failed");
  }
  const blockedCommand =
    process.platform === "darwin"
      ? [
          "sandbox-exec",
          "-p",
          "(version 1)(allow default)(deny network*)",
          helper,
          "self-test",
          "--protocol-major",
          "1",
        ]
      : process.platform === "linux"
        ? [
            "unshare",
            "--net",
            "--",
            helper,
            "self-test",
            "--protocol-major",
            "1",
          ]
        : null;
  if (!blockedCommand) return false;
  try {
    const blocked = await invokeCommand(blockedCommand, hostileEnvironment);
    return blocked.exitCode === 0 && blocked.stdout === "" && blocked.stderr === "";
  } catch {
    return false;
  }
}

async function invokeHelper(
  helper: string,
  arguments_: string[],
  env: Record<string, string>,
): Promise<{ exitCode: number; stderr: string; stdout: string }> {
  return invokeCommand([helper, ...arguments_], env);
}

async function invokeCommand(
  command: string[],
  env: Record<string, string>,
): Promise<{ exitCode: number; stderr: string; stdout: string }> {
  const child = Bun.spawn(command, {
    cwd: ARCHITECTURE_INSTALL_ROOT,
    env,
    stdin: "ignore",
    stderr: "pipe",
    stdout: "pipe",
    windowsHide: true,
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stderr, stdout };
}

if (import.meta.main) {
  console.log(JSON.stringify(await buildReleaseSets()));
}
