import { cpus, release as osRelease, type as osType } from "node:os";
import { basename, posix, resolve } from "node:path";

import type { SupportedRuntimeTarget } from "../src/backend";
import type { ReleaseManifest } from "./release-manifest";
import type { TargetCompatibilityEvidence } from "./release-validation";

export interface NativeInspectionReport extends TargetCompatibilityEvidence {
  floorDetails: string[];
  inspectedCommands: string[][];
}

interface CommandResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}

export async function inspectNativeRelease(
  installRoot: string,
  manifest: ReleaseManifest,
  blockedNetworkingVerified: boolean,
): Promise<NativeInspectionReport> {
  if (!manifest.target) throw new Error("runtime-manifest-required");
  const commands: string[][] = [];
  const run = async (command: string[]): Promise<CommandResult> => {
    commands.push(command);
    try {
      const child = Bun.spawn(command, { stderr: "pipe", stdout: "pipe" });
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      return { exitCode, stderr, stdout };
    } catch (error) {
      return {
        exitCode: 127,
        stderr: error instanceof Error ? error.message : "tool-unavailable",
        stdout: "",
      };
    }
  };
  const binaryPaths = manifest.files
    .filter(
      (file) =>
        file.mode === "0755" ||
        file.logicalDestination.endsWith(".node") ||
        /\.(?:dylib|so\.1|dll)$/.test(file.logicalDestination),
    )
    .map((file) => resolve(installRoot, file.logicalDestination));
  const declaredNames = new Set(
    manifest.files
      .filter((file) => file.logicalDestination.startsWith("runtime/onnx/"))
      .map((file) => basename(file.logicalDestination).toLowerCase()),
  );
  const declaredLinuxPaths = new Map(
    manifest.files
      .filter((file) => file.logicalDestination.startsWith("runtime/onnx/"))
      .map((file) => [
        basename(file.logicalDestination).toLowerCase(),
        resolve(installRoot, file.logicalDestination),
      ]),
  );

  let inspection: Pick<
    NativeInspectionReport,
    | "baselineCpuVerified"
    | "floorDetails"
    | "floorVerified"
    | "nativeDependencies"
    | "ordinaryLoaderPathVerified"
    | "windowsAppLocalRuntimeApproved"
  >;
  if (manifest.target.startsWith("darwin-")) {
    inspection = await inspectDarwin(
      binaryPaths,
      declaredNames,
      manifest.target,
      run,
    );
  } else if (manifest.target.startsWith("linux-")) {
    inspection = await inspectLinux(
      binaryPaths,
      declaredNames,
      declaredLinuxPaths,
      manifest.target,
      run,
    );
  } else {
    inspection = await inspectWindows(binaryPaths, declaredNames, run);
  }

  let promptFailureVerified = true;
  if (manifest.target.startsWith("linux-")) {
    const test = await run([process.execPath, "test", "src/playback.test.ts"]);
    promptFailureVerified = test.exitCode === 0;
    inspection.floorDetails.push(
      `linux-audio-policy-test:${test.exitCode === 0 ? "passed" : "failed"}`,
      "linux-audio-backends=unverified-on-real-device",
    );
  }
  inspection.floorDetails.push("real-device-playback=unverified");
  return {
    // Policy tests prove that only the declared local envelope is accepted;
    // they do not prove that real ALSA, PulseAudio, or PipeWire devices work.
    audioBackends: [],
    blockedNetworkingVerified,
    bunVersion: Bun.version,
    inspectedCommands: commands,
    promptFailureVerified,
    realDevicePlaybackVerified: false,
    reproducibilityVerified: false,
    runnerCpu: cpus()[0]?.model ?? "",
    runnerOs: `${osType()} ${osRelease()}`,
    target: manifest.target,
    ...inspection,
  };
}

export function assertNativeInspectionReceipt(
  report: NativeInspectionReport,
  manifest: ReleaseManifest,
): void {
  if (!manifest.target || report.target !== manifest.target) {
    throw new Error("native-inspection-target-mismatch");
  }
  const expectedDeclared = manifest.files
    .filter((file) => file.logicalDestination.startsWith("runtime/onnx/"))
    .map((file) => basename(file.logicalDestination).toLowerCase())
    .sort();
  if (
    JSON.stringify(report.nativeDependencies.declared) !==
    JSON.stringify(expectedDeclared)
  ) {
    throw new Error("native-inspection-declarations-mismatch");
  }
  const commandNames = report.inspectedCommands.map((command) =>
    basename(command[0] ?? "").toLowerCase(),
  );
  const required = manifest.target.startsWith("darwin-")
    ? ["otool"]
    : manifest.target.startsWith("linux-")
      ? ["ldd", "objdump", basename(process.execPath).toLowerCase()]
      : ["dumpbin"];
  if (required.some((command) => !commandNames.includes(command))) {
    throw new Error("native-inspection-command-missing");
  }
  if (!report.floorDetails.length || !report.runnerCpu || !report.runnerOs) {
    throw new Error("native-inspection-platform-evidence-missing");
  }
}

async function inspectDarwin(
  binaryPaths: string[],
  declaredNames: Set<string>,
  target: SupportedRuntimeTarget,
  run: (command: string[]) => Promise<CommandResult>,
): Promise<Pick<
  NativeInspectionReport,
  | "baselineCpuVerified"
  | "floorDetails"
  | "floorVerified"
  | "nativeDependencies"
  | "ordinaryLoaderPathVerified"
  | "windowsAppLocalRuntimeApproved"
>> {
  const unresolved: string[] = [];
  const undeclared: string[] = [];
  const floorDetails: string[] = [];
  let loaderRelative = true;
  let floorVerified = true;
  for (const path of binaryPaths) {
    const linked = await run(["otool", "-L", path]);
    if (linked.exitCode !== 0) {
      unresolved.push(basename(path));
      continue;
    }
    for (const dependency of parseOtoolDependencies(linked.stdout)) {
      const name = basename(dependency).toLowerCase();
      if (dependency.startsWith("/System/Library/") || dependency.startsWith("/usr/lib/")) {
        continue;
      }
      if (
        (dependency.startsWith("@rpath/") ||
          dependency.startsWith("@loader_path/")) &&
        declaredNames.has(name)
      ) {
        continue;
      }
      undeclared.push(dependency);
    }
    const loadCommands = await run(["otool", "-l", path]);
    if (loadCommands.exitCode !== 0) {
      unresolved.push(`${basename(path)}:load-commands`);
      continue;
    }
    if (path.endsWith(".node") && !/path @loader_path(?:\s|$)/.test(loadCommands.stdout)) {
      loaderRelative = false;
    }
    const minimums = [...loadCommands.stdout.matchAll(/\bminos\s+(\d+(?:\.\d+)?)/g)].map(
      (match) => match[1]!,
    );
    if (minimums.length === 0 || minimums.some((version) => compareVersions(version, "13") > 0)) {
      floorVerified = false;
    }
    floorDetails.push(`${basename(path)}:minos=${minimums.join(",") || "missing"}`);
  }
  return {
    baselineCpuVerified: target === "darwin-arm64",
    floorDetails,
    floorVerified,
    nativeDependencies: {
      declared: [...declaredNames].sort(),
      undeclared: [...new Set(undeclared)].sort(),
      unresolved: [...new Set(unresolved)].sort(),
    },
    ordinaryLoaderPathVerified: loaderRelative,
    windowsAppLocalRuntimeApproved: false,
  };
}

async function inspectLinux(
  binaryPaths: string[],
  declaredNames: Set<string>,
  declaredPaths: ReadonlyMap<string, string>,
  target: SupportedRuntimeTarget,
  run: (command: string[]) => Promise<CommandResult>,
): Promise<Pick<
  NativeInspectionReport,
  | "baselineCpuVerified"
  | "floorDetails"
  | "floorVerified"
  | "nativeDependencies"
  | "ordinaryLoaderPathVerified"
  | "windowsAppLocalRuntimeApproved"
>> {
  const unresolved: string[] = [];
  const undeclared: string[] = [];
  const versions: string[] = [];
  let loaderRelative = true;
  for (const path of binaryPaths) {
    const linked = await run(["ldd", path]);
    const lddText = `${linked.stdout}\n${linked.stderr}`;
    if (
      linked.exitCode !== 0 &&
      !/(?:statically linked|not a dynamic executable)/i.test(lddText)
    ) {
      unresolved.push(`${basename(path)}:dependency-inspection`);
    }
    unresolved.push(...parseLddMissing(lddText));
    undeclared.push(
      ...classifyUndeclaredLinuxDependencies(
        parseLddResolved(lddText),
        declaredPaths,
      ),
    );
    const symbols = await run(["objdump", "-T", path]);
    if (symbols.exitCode !== 0) {
      unresolved.push(`${basename(path)}:symbol-inspection`);
    } else {
      versions.push(...[...symbols.stdout.matchAll(/GLIBC_(\d+\.\d+)/g)].map((match) => match[1]!));
    }
    if (path.endsWith(".node")) {
      const headers = await run(["objdump", "-p", path]);
      if (headers.exitCode !== 0 || !/\$ORIGIN/.test(headers.stdout)) {
        loaderRelative = false;
      }
    }
  }
  const maximum = versions.sort(compareVersions).at(-1);
  const kernel = /^\d+(?:\.\d+)?/.exec(osRelease())?.[0];
  const floor = assessLinuxFloor(target, maximum, kernel, false);
  return {
    baselineCpuVerified: target === "linux-arm64",
    floorDetails: floor.details,
    floorVerified: floor.verified,
    nativeDependencies: {
      declared: [...declaredNames].sort(),
      undeclared: [...new Set(undeclared)].sort(),
      unresolved: [...new Set(unresolved)].sort(),
    },
    ordinaryLoaderPathVerified: loaderRelative,
    windowsAppLocalRuntimeApproved: false,
  };
}

async function inspectWindows(
  binaryPaths: string[],
  declaredNames: Set<string>,
  run: (command: string[]) => Promise<CommandResult>,
): Promise<Pick<
  NativeInspectionReport,
  | "baselineCpuVerified"
  | "floorDetails"
  | "floorVerified"
  | "nativeDependencies"
  | "ordinaryLoaderPathVerified"
  | "windowsAppLocalRuntimeApproved"
>> {
  const unresolved: string[] = [];
  const undeclared: string[] = [];
  const system = /^(?:api-ms-win-.*|advapi32|bcrypt|combase|crypt32|dbghelp|gdi32|imm32|iphlpapi|kernel32|ncrypt|normaliz|ntdll|ole32|oleaut32|rpcrt4|secur32|shell32|shlwapi|ucrtbase|user32|version|winmm|ws2_32)\.dll$/i;
  const floorDetails: string[] = [];
  const subsystemVersions: string[] = [];
  let headersComplete = true;
  for (const path of binaryPaths) {
    const dependencies = await run(["dumpbin", "/dependents", path]);
    if (dependencies.exitCode !== 0) {
      unresolved.push(`${basename(path)}:dependency-inspection`);
      continue;
    }
    for (const name of parseDumpbinDependencies(dependencies.stdout)) {
      const lower = name.toLowerCase();
      if (system.test(name) || declaredNames.has(lower)) continue;
      if (/^(?:vcruntime|msvcp|concrt)\d.*\.dll$/i.test(name)) {
        unresolved.push(name);
      } else {
        undeclared.push(name);
      }
    }
    const headers = await run(["dumpbin", "/headers", path]);
    const versions = [...headers.stdout.matchAll(/(\d+\.\d+) subsystem version/gi)].map(
      (match) => match[1]!,
    );
    subsystemVersions.push(...versions);
    if (headers.exitCode !== 0 || versions.length === 0) headersComplete = false;
    floorDetails.push(
      `${basename(path)}:pe-subsystem-version=${versions.join(",") || "missing"}`,
    );
  }
  const floor = assessWindowsFloor(subsystemVersions, headersComplete, false);
  floorDetails.push(...floor.details);
  return {
    baselineCpuVerified: false,
    floorDetails,
    floorVerified: floor.verified,
    nativeDependencies: {
      declared: [...declaredNames].sort(),
      undeclared: [...new Set(undeclared)].sort(),
      unresolved: [...new Set(unresolved)].sort(),
    },
    ordinaryLoaderPathVerified: true,
    windowsAppLocalRuntimeApproved: false,
  };
}

export function parseOtoolDependencies(output: string): string[] {
  return output
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim().split(/\s+\(/)[0] ?? "")
    .filter(Boolean);
}

export function parseLddMissing(output: string): string[] {
  return output
    .split(/\r?\n/)
    .filter((line) => line.includes("=> not found"))
    .map((line) => line.trim().split(/\s+/)[0]!)
    .filter(Boolean);
}

export function parseLddResolved(output: string): Array<{ name: string; path: string }> {
  const dependencies: Array<{ name: string; path: string }> = [];
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*(\S+)\s+=>\s+(\/\S+)/.exec(line);
    if (match) {
      dependencies.push({ name: match[1]!, path: match[2]! });
      continue;
    }
    const direct = /^\s*(\/\S+)\s+\(/.exec(line);
    if (direct) {
      dependencies.push({ name: basename(direct[1]!), path: direct[1]! });
    }
  }
  return dependencies;
}

const REVIEWED_LINUX_SYSTEM_LIBRARIES = new Set([
  "ld-linux-aarch64.so.1",
  "ld-linux-x86-64.so.2",
  "libatomic.so.1",
  "libc.so.6",
  "libdl.so.2",
  "libgcc_s.so.1",
  "libm.so.6",
  "libpthread.so.0",
  "libresolv.so.2",
  "librt.so.1",
  "libstdc++.so.6",
  "libutil.so.1",
]);

export function classifyUndeclaredLinuxDependencies(
  dependencies: readonly { name: string; path: string }[],
  declaredPaths: ReadonlyMap<string, string>,
): string[] {
  const undeclared: string[] = [];
  for (const dependency of dependencies) {
    const name = dependency.name.toLowerCase();
    const path = posix.normalize(dependency.path);
    const declaredPath = declaredPaths.get(name);
    if (declaredPath !== undefined && path === posix.normalize(declaredPath)) continue;
    if (
      REVIEWED_LINUX_SYSTEM_LIBRARIES.has(name) &&
      /^\/(?:lib|lib64|usr\/lib)(?:\/|$)/.test(path)
    ) {
      continue;
    }
    undeclared.push(`${dependency.name} => ${dependency.path}`);
  }
  return undeclared;
}

export function assessLinuxFloor(
  target: SupportedRuntimeTarget,
  maximumGlibcVersion: string | undefined,
  runnerKernel: string | undefined,
  minimumHostExecutionVerified: boolean,
): { details: string[]; verified: boolean } {
  if (target !== "linux-arm64" && target !== "linux-x64") {
    throw new Error("linux-target-required");
  }
  const requiredGlibc = target === "linux-x64" ? "2.27" : "2.17";
  const glibcCompatible =
    maximumGlibcVersion !== undefined &&
    compareVersions(maximumGlibcVersion, requiredGlibc) <= 0;
  return {
    details: [
      `maximum-glibc=${maximumGlibcVersion ?? "missing"}`,
      `glibc-floor=${requiredGlibc};symbol-compatible=${glibcCompatible}`,
      `runner-kernel=${runnerKernel ?? "missing"};minimum-host-kernel=5.1;minimum-host-execution=${minimumHostExecutionVerified ? "verified" : "unverified"}`,
    ],
    // A newer runner kernel cannot prove that the binary executes on 5.1.
    verified: glibcCompatible && minimumHostExecutionVerified,
  };
}

export function assessWindowsFloor(
  subsystemVersions: readonly string[],
  headersComplete: boolean,
  minimumHostExecutionVerified: boolean,
): { details: string[]; verified: boolean } {
  const headersCompatible =
    headersComplete &&
    subsystemVersions.length > 0 &&
    subsystemVersions.every((version) => compareVersions(version, "10.0") <= 0);
  return {
    details: [
      `pe-subsystem-compatible=${headersCompatible}`,
      `minimum-windows-build=10.0.17763;minimum-host-execution=${minimumHostExecutionVerified ? "verified" : "unverified"}`,
    ],
    // PE subsystem 10.0 does not identify or prove Windows build 17763.
    verified: headersCompatible && minimumHostExecutionVerified,
  };
}

export function parseDumpbinDependencies(output: string): string[] {
  return [...output.matchAll(/^\s+([A-Za-z0-9._-]+\.dll)\s*$/gim)].map(
    (match) => match[1]!,
  );
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const comparison = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (comparison !== 0) return comparison;
  }
  return 0;
}
