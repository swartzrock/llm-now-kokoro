import type { BunPlugin } from "bun";

export function omitUnusedSharpPlugin(
  namespace: string,
  diagnostic: string,
): BunPlugin {
  return {
    name: "omit-unused-sharp",
    setup(builder) {
      builder.onResolve({ filter: /^sharp$/ }, () => ({
        path: "sharp",
        namespace,
      }));
      builder.onLoad({ filter: /.*/, namespace }, () => ({
        contents: `export default function sharp() { throw new Error(${JSON.stringify(diagnostic)}); }`,
        loader: "js",
      }));
    },
  };
}
