import { runCliMain } from "./src/cli";

if (import.meta.main) {
  process.exitCode = await runCliMain(process.argv.slice(2));
}
