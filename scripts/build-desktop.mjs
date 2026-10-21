import { build } from "esbuild";

await build({
  entryPoints: ["desktop/main.ts"],
  outfile: "dist/main.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  external: ["electron"],
  sourcemap: true,
  logLevel: "info",
});
