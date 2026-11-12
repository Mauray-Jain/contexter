// Bundle the CLI into one file so hooks start fast and need no TypeScript tooling.
import { build } from "esbuild";

await build({
  entryPoints: ["packages/cli/src/index.ts"],
  outfile: "packages/cli/dist/contexter.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: "warning",
});
console.log("built packages/cli/dist/contexter.mjs");
