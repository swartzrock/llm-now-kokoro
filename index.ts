import { runCliMain } from "./src/cli";
import { createNativeHelperDependencies } from "./src/tts";

if (import.meta.main) {
  process.exitCode = await runCliMain(
    process.argv.slice(2),
    createNativeHelperDependencies(process.cwd()),
  );
}
