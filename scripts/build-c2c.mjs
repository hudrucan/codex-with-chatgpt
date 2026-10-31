import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Reuse the esbuild pinned in the existing tsx toolchain; no runtime dependency.
const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve("tsx/package.json"))("esbuild");

export async function buildC2C(outdir = path.join(root, "dist", "c2c"), { write = true, sourceRoot = root } = {}) {
  const local = await build({
    absWorkingDir: sourceRoot,
    entryPoints: [path.join(sourceRoot, "src", "c2c", "local-command.ts")], outfile: path.join(outdir, "local.mjs"),
    bundle: true, platform: "node", format: "esm", target: "node20", logLevel: "silent", write,
  });
  const browser = await build({
    absWorkingDir: sourceRoot,
    entryPoints: [path.join(sourceRoot, "src", "c2c", "browser.ts")], outfile: path.join(outdir, "browser.mjs"),
    bundle: true, platform: "neutral", format: "esm", target: "es2022", logLevel: "silent", write,
  });
  return [...(local.outputFiles ?? []), ...(browser.outputFiles ?? [])];
}
