import { afterEach, describe, expect, test } from "bun:test";
import { chmod, cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import { assembleReleaseSet, installReleaseSets } from "../scripts/release-sets";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

describe("standalone runtime release assembly", () => {
  test("reassembles an executable pack under a space and Unicode path", async () => {
    if (process.platform === "win32") return;
    const sourceRoot = await mkdtemp(join(import.meta.dir, ".tmp-runtime-source-"));
    const outputRoot = await mkdtemp(join(import.meta.dir, ".tmp-runtime-release-"));
    const installRoot = resolve(
      await mkdtemp(join(import.meta.dir, ".tmp-runtime-install-")),
      "pack with space ü",
    );
    temporaryDirectories.push(sourceRoot, outputRoot, resolve(installRoot, ".."));
    await mkdir(resolve(sourceRoot, "runtime/onnx"), { recursive: true });
    await Bun.write(
      resolve(sourceRoot, "llm-now-kokoro"),
      "#!/bin/sh\nprintf '{\"protocolMajor\":1}\\n'\n",
    );
    await Bun.write(resolve(sourceRoot, "runtime/player"), "#!/bin/sh\nexit 0\n");
    await Bun.write(resolve(sourceRoot, "runtime/onnx/addon.node"), "addon");
    await Bun.write(resolve(sourceRoot, "runtime/onnx/library.dylib"), "library");
    await chmod(resolve(sourceRoot, "llm-now-kokoro"), 0o755);
    await chmod(resolve(sourceRoot, "runtime/player"), 0o755);

    const runtime = await assembleReleaseSet({
      assetClass: "runtime",
      files: [
        {
          logicalDestination: "llm-now-kokoro",
          releaseFilename: "llm-now-kokoro-0.1.0-darwin-arm64-helper",
        },
        {
          logicalDestination: "runtime/llm-now-kokoro-player",
          releaseFilename: "llm-now-kokoro-0.1.0-darwin-arm64-player",
          sourcePath: "runtime/player",
        },
        {
          logicalDestination: "runtime/onnx/onnxruntime_binding.node",
          releaseFilename: "llm-now-kokoro-0.1.0-darwin-arm64-onnxruntime-binding.node",
          sourcePath: "runtime/onnx/addon.node",
        },
        {
          logicalDestination: "runtime/onnx/libonnxruntime.1.21.0.dylib",
          releaseFilename: "llm-now-kokoro-0.1.0-darwin-arm64-onnxruntime.dylib",
          sourcePath: "runtime/onnx/library.dylib",
        },
      ],
      outputRoot,
      sourceRoot,
      target: "darwin-arm64",
    });
    await installReleaseSets([runtime], installRoot);

    const child = Bun.spawn([resolve(installRoot, "llm-now-kokoro")], {
      cwd: installRoot,
      env: {
        DYLD_LIBRARY_PATH: "/hostile",
        LD_LIBRARY_PATH: "/hostile",
        PATH: "/hostile",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect({ exitCode, stdout, stderr }).toEqual({
      exitCode: 0,
      stderr: "",
      stdout: '{"protocolMajor":1}\n',
    });
    expect(await Bun.file(resolve(installRoot, "node_modules")).exists()).toBe(false);
    expect(await Bun.file(resolve(installRoot, "bun")).exists()).toBe(false);
    await cp(resolve(installRoot, "llm-now-kokoro"), resolve(installRoot, "helper-copy"));
  });
});
