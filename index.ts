import { runCliMain } from "./src/cli";

export async function main(arguments_ = process.argv.slice(2)): Promise<number> {
  return runCliMain(arguments_);
}

if (import.meta.main) {
  process.exitCode = await main();
}
