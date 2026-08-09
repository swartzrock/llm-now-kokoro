import { mkdir, readdir } from "node:fs/promises";
import { resolve } from "node:path";

import {
  EMBEDDED_VOICE_MANIFEST,
  EXPECTED_VOICE_COUNT,
  type EmbeddedVoiceName,
} from "./src/embedded-voices";
import { ADDON_NAME, DYLIB_NAME } from "./src/native-runtime";

const REQUIRED_BUN_VERSION = "1.3.14";

const ROOT_DIRECTORY = import.meta.dir;
const VOICE_DIRECTORY = resolve(ROOT_DIRECTORY, "node_modules/kokoro-js/voices");
const DIST_DIRECTORY = resolve(ROOT_DIRECTORY, "dist");
const BINARY_PATH = resolve(DIST_DIRECTORY, "kokoro-cli");
const MANIFEST_PATH = resolve(DIST_DIRECTORY, "embedded-voices.manifest.json");
const NATIVE_DIRECTORY = resolve(
  ROOT_DIRECTORY,
  "node_modules/onnxruntime-node/bin/napi-v3",
  process.platform,
  process.arch,
);
const NATIVE_ASSETS = [ADDON_NAME, DYLIB_NAME].map((name) =>
  resolve(NATIVE_DIRECTORY, name),
);

export function assertBunVersion(actualVersion = Bun.version): void {
  if (actualVersion !== REQUIRED_BUN_VERSION) {
    throw new Error(
      `Bun ${REQUIRED_BUN_VERSION} is required; found ${actualVersion}. Refusing to compile.`,
    );
  }
}

async function verifyPinnedVoicePackage(): Promise<void> {
  const packageVoices = (await readdir(VOICE_DIRECTORY))
    .filter((name) => name.endsWith(".bin"))
    .sort();
  const manifestVoices = Object.values(EMBEDDED_VOICE_MANIFEST)
    .map((entry) => entry.file)
    .sort();

  if (
    packageVoices.length !== EXPECTED_VOICE_COUNT ||
    !packageVoices.includes(EMBEDDED_VOICE_MANIFEST.af_heart.file) ||
    packageVoices.join("\n") !== manifestVoices.join("\n")
  ) {
    throw new Error(
      `kokoro-js 1.2.1 must ship exactly ${EXPECTED_VOICE_COUNT} manifest-matched voices including af_heart.bin`,
    );
  }

  for (const name of Object.keys(EMBEDDED_VOICE_MANIFEST) as EmbeddedVoiceName[]) {
    const entry = EMBEDDED_VOICE_MANIFEST[name];
    const bytes = await Bun.file(resolve(VOICE_DIRECTORY, entry.file)).arrayBuffer();
    const actual = Bun.CryptoHasher.hash("sha256", bytes, "hex");
    if (actual !== entry.sha256) {
      throw new Error(`kokoro-js voice hash mismatch for ${entry.file}`);
    }
  }
}

export async function buildStandalone(): Promise<void> {
  assertBunVersion();
  if (process.platform !== "darwin") {
    throw new Error(`Standalone builds are supported only on the current macOS host`);
  }
  await verifyPinnedVoicePackage();
  for (const asset of NATIVE_ASSETS) {
    if (!(await Bun.file(asset).exists())) {
      throw new Error(`Pinned host native runtime asset not found: ${asset}`);
    }
  }
  await mkdir(DIST_DIRECTORY, { recursive: true });

  const result = await Bun.build({
    entrypoints: [
      resolve(ROOT_DIRECTORY, "index.ts"),
      ...NATIVE_ASSETS,
    ],
    compile: { outfile: BINARY_PATH },
    loader: { ".node": "file", ".dylib": "file" },
    minify: true,
    naming: { asset: "[name].[ext]" },
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

  const manifest = Object.fromEntries(
    Object.entries(EMBEDDED_VOICE_MANIFEST).map(([name, entry]) => [
      name,
      { file: entry.file, sha256: entry.sha256 },
    ]),
  );
  await Bun.write(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
}

if (import.meta.main) {
  await buildStandalone();
}
