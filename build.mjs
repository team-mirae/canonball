import { build } from "esbuild";
import fs from "node:fs";
fs.rmSync("dist", { recursive: true, force: true });
await build({
  entryPoints: ["src/server.ts"], outfile: "dist/canonball.mjs", bundle: true, platform: "node", format: "esm",
  target: "node24", sourcemap: "linked", legalComments: "none",
  // CJS deps inside an ESM bundle need require().
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});
await build({ entryPoints: ["src/client.ts"], outfile: "dist/static/app.js", bundle: true, platform: "browser", format: "iife", target: "es2022", minify: true });
console.log("built dist/");
