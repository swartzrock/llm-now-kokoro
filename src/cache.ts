import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

import { errorMessage } from "./error-message";

type MakeDirectory = (
  path: string,
  options: { recursive: true },
) => Promise<unknown>;

export function getModelCachePath(homeDirectory = homedir()): string {
  if (!isAbsolute(homeDirectory)) {
    throw new Error("Home directory must be an absolute path.");
  }

  return join(
    homeDirectory,
    "Library",
    "Caches",
    "kokoro-cli",
    "transformers",
  );
}

export async function prepareModelCache(
  homeDirectory = homedir(),
  makeDirectory: MakeDirectory = mkdir,
): Promise<string> {
  const cachePath = getModelCachePath(homeDirectory);

  try {
    await makeDirectory(cachePath, { recursive: true });
  } catch (error) {
    throw new Error(
      `Unable to prepare Kokoro model cache at ${cachePath}: ${errorMessage(error)}`,
    );
  }

  return cachePath;
}
