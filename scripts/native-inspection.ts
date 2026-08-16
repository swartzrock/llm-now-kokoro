import { cpus, release as osRelease, type as osType } from "node:os";
import { basename, resolve } from "node:path";

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
  return {
    // Policy tests prove that only the declared local envelope is accepted;
    // they do not prove that real ALSA, PulseAudio, or PipeWire devices work.
    audioBackends: [],
    blockedNetworkingVerified,
    bunVersion: Bun.version,
    inspectedCommands: commands,
    promptFailureVerified,
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
    for (const dependency of parseLddResolved(lddText)) {
      const name = dependency.name.toLowerCase();
      if (name.startsWith("libonnxruntime") && !declaredNames.has(name)) {
        undeclared.push(dependency.name);
      }
    }
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
  const required = target === "linux-x64" ? "2.27" : "2.17";
  const maximum = versions.sort(compareVersions).at(-1);
  const kernel = /^\d+(?:\.\d+)?/.exec(osRelease())?.[0];
  const kernelVerified = kernel !== undefined && compareVersions(kernel, "5.1") >= 0;
  return {
    baselineCpuVerified: target === "linux-arm64",
    floorDetails: [
      `maximum-glibc=${maximum ?? "missing"}`,
      `runner-kernel=${kernel ?? "missing"};minimum=5.1`,
    ],
    floorVerified:
      maximum !== undefined &&
      compareVersions(maximum, required) <= 0 &&
      kernelVerified,
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
  let floorVerified = true;
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
    if (headers.exitCode !== 0 || versions.length === 0 || versions.some((version) => compareVersions(version, "10.0") > 0)) {
      floorVerified = false;
    }
  }
  return {
    baselineCpuVerified: false,
    floorDetails: ["minimum-windows-build=10.0.17763"],
    floorVerified,
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
    if (match) dependencies.push({ name: match[1]!, path: match[2]! });
  }
  return dependencies;
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
