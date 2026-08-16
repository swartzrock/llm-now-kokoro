import { runHelperMain } from "./src/cli";
import { runEngineChildMain } from "./src/engine-child";
import { ENGINE_CHILD_ENVIRONMENT_KEY } from "./src/engine-process";
import { createNativeHelperDependencies } from "./src/tts";

if (
  process.env[ENGINE_CHILD_ENVIRONMENT_KEY] === "1" &&
  typeof process.send === "function"
) {
  process.exitCode = await runEngineChildMain();
} else {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    process.exitCode = await runHelperMain(
      process.argv.slice(2),
      {
        ...createNativeHelperDependencies(process.cwd()),
        signal: controller.signal,
      },
    );
  } finally {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
  }
}
