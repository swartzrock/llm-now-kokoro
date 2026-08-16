import { chmod, mkdir } from "node:fs/promises";
import { resolve } from "node:path";

import { verifyPinnedPhonemizerBundle } from "./src/model-assets";

const REQUIRED_BUN_VERSION = "1.3.14";
const ROOT_DIRECTORY = import.meta.dir;
const BINARY_PATH = resolve(
  ROOT_DIRECTORY,
  process.platform === "win32"
    ? "dist/llm-now-kokoro.exe"
    : "dist/llm-now-kokoro",
);

export function assertBunVersion(actualVersion = Bun.version): void {
  if (actualVersion !== REQUIRED_BUN_VERSION) {
    throw new Error(
      `Bun ${REQUIRED_BUN_VERSION} is required; found ${actualVersion}. Refusing to compile.`,
    );
  }
}

export async function buildStandalone(): Promise<string> {
  assertBunVersion();
  await verifyPinnedPhonemizerBundle(ROOT_DIRECTORY);
  await mkdir(resolve(ROOT_DIRECTORY, "dist"), { recursive: true });

  const result = await Bun.build({
    entrypoints: [resolve(ROOT_DIRECTORY, "index.ts")],
    compile: {
      outfile: BINARY_PATH,
      autoloadBunfig: false,
      autoloadDotenv: false,
      autoloadPackageJson: false,
      autoloadTsconfig: false,
    },
    minify: true,
    plugins: [
      {
        name: "omit-unused-sharp",
        setup(builder) {
          builder.onResolve({ filter: /^sharp$/ }, () => ({
            path: "sharp",
            namespace: "kokoro-sharp",
          }));
          builder.onLoad(
            { filter: /.*/, namespace: "kokoro-sharp" },
            () => ({
              contents:
                'export default function sharp() { throw new Error("Sharp is unavailable in the TTS-only executable"); }',
              loader: "js",
            }),
          );
        },
      },
    ],
    target: "bun",
  });
  if (!result.success) {
    throw new AggregateError(result.logs, "Standalone compilation failed");
  }
  if (result.outputs.length !== 1) {
    throw new Error(
      `Native helper must compile to one executable; found ${result.outputs.length} outputs`,
    );
  }
  if (process.platform !== "win32") await chmod(BINARY_PATH, 0o755);
  return BINARY_PATH;
}

if (import.meta.main) await buildStandalone();
