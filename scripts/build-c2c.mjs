import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Reuse the esbuild pinned in the existing tsx toolchain; no runtime dependency.
const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve("tsx/package.json"))("esbuild");

export async function buildC2C(outdir = path.join(root, "dist", "c2c")) {
  for (const [entry, output] of [["repl.ts", "repl.mjs"], ["local-command.ts", "local.mjs"]]) {
    await build({
      entryPoints: [path.join(root, "src", "c2c", entry)], outfile: path.join(outdir, output),
      bundle: true, platform: "node", format: "esm", target: "node20", logLevel: "silent",
      ...(entry === "repl.ts" ? { inject: [path.join(root, "scripts", "repl-globals.mjs")] } : {}),
    });
  }
}
