import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { beforeAll, afterAll, expect, it } from "vitest";
import { buildC2C } from "../../scripts/build-c2c.mjs";
import { expectedDistribution, packagePlugin } from "../../scripts/package-plugin.mjs";
import { cleanup, makeGitRepo, makeTmpDir } from "../helpers.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
let temporary: string, source: string, runtime: string;
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

beforeAll(async () => {
  temporary = makeTmpDir("plugin with spaces");
  source = path.join(temporary, "source checkout");
  runtime = path.join(temporary, "bound runtime");
  for (const directory of [source, runtime]) {
    fs.mkdirSync(directory); makeGitRepo(directory);
    fs.rmSync(path.join(directory, "src"), { recursive: true });
    for (const name of ["src", "skill", "bin", "scripts", "package.json", "pnpm-lock.yaml", "tsconfig.json", "LICENSE"])
      fs.cpSync(path.join(root, name), path.join(directory, name), { recursive: true });
  }
  const compile = spawnSync(process.execPath, [path.join(root, "node_modules/typescript/bin/tsc"), "-p", path.join(runtime, "tsconfig.json")], {
    encoding: "utf8", windowsHide: true,
  });
  expect(compile.status, compile.stdout + compile.stderr).toBe(0);
  await buildC2C(path.join(runtime, "dist/c2c"), { sourceRoot: runtime });
}, 60_000);
afterAll(() => cleanup(temporary));

it("packages one canonical bound Skill, a local marketplace and verifiable reproducible ZIP", async () => {
  const options = { sourceRoot: source, runtimeCheckout: runtime };
  const output = path.join(temporary, "offline marketplace");
  const first = await packagePlugin({ ...options, output });
  const second = await packagePlugin({ ...options, output, check: true });
  const rebuilt = await packagePlugin({ ...options, output: path.join(temporary, "reproduced marketplace") });
  expect(first.sha256).toBe(second.sha256);
  expect(first.sha256).toBe(rebuilt.sha256);
  expect(digest(fs.readFileSync(first.artifact))).toBe(first.sha256);
  const { distribution } = await expectedDistribution(options);
  const marketplace = JSON.parse(distribution.get(".agents/plugins/marketplace.json").toString("utf8"));
  expect(marketplace.name).toBe("hudrucan");
  expect(marketplace.plugins.map((plugin: { name: string }) => `${plugin.name}@${marketplace.name}`))
    .toEqual(["codex-with-chatgpt@hudrucan"]);
  expect([...distribution.keys()].filter(name => name.endsWith("SKILL.md")))
    .toEqual(["codex-with-chatgpt/skills/codex-with-chatgpt/SKILL.md"]);
  expect([...distribution.keys()].some(name => /(?:^|\/)(?:node_modules|\.git|\.mcp.json|hooks|auth|runtime)(?:\/|$)/.test(name))).toBe(false);
  const plugin = path.join(output, "codex-with-chatgpt");
  const manifest = JSON.parse(fs.readFileSync(path.join(plugin, ".codex-plugin/plugin.json"), "utf8"));
  expect(manifest).toEqual({ name: "codex-with-chatgpt", version: "0.5.0",
    description: JSON.parse(fs.readFileSync(path.join(source, "package.json"), "utf8")).description,
    skills: "./skills/", interface: { displayName: "codex-with-chatgpt" } });
  const entry = fs.readFileSync(path.join(plugin, "skills/codex-with-chatgpt/SKILL.md"), "utf8");
  expect(entry).toContain(`Checkout: \`${runtime.split(path.sep).join("/")}\``);
  expect(entry).not.toContain("<ACTUAL_CHECKOUT_PATH>");
  expect(fs.readFileSync(path.join(source, "skill/SKILL.md"), "utf8")).toContain("<ACTUAL_CHECKOUT_PATH>");
  const provenance = JSON.parse(fs.readFileSync(path.join(plugin, "provenance.json"), "utf8"));
  expect(provenance.source.revision).toMatch(/^[a-f0-9]{40}$/);
  expect(provenance.runtime.artifacts["dist/c2c/local.mjs"]).toBe(digest(fs.readFileSync(path.join(runtime, "dist/c2c/local.mjs"))));
  for (const [name, hash] of Object.entries(provenance.files)) expect(digest(fs.readFileSync(path.join(plugin, name)))).toBe(hash);
  for (const [name, hash] of Object.entries(provenance.source.inputs)) expect(digest(fs.readFileSync(path.join(source, name)))).toBe(hash);
  // Use the host ZIP reader on Windows to check names and extracted payloads.
  if (process.platform !== "win32") return;
  const archiveCheck = spawnSync("powershell.exe", ["-NoProfile", "-Command",
    `Add-Type -AssemblyName System.IO.Compression.FileSystem; $zip = [IO.Compression.ZipFile]::OpenRead('${first.artifact.replace(/'/g, "''")}'); ` +
    "try { foreach ($entry in $zip.Entries) { $stream = $entry.Open(); try { $memory = New-Object IO.MemoryStream; " +
    "$stream.CopyTo($memory); [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($entry.FullName)) + ':' + " +
    "[Convert]::ToBase64String($memory.ToArray()) } finally { $stream.Dispose() } } } finally { $zip.Dispose() }",
    ], { encoding: "utf8", windowsHide: true });
  expect(archiveCheck.status, archiveCheck.stderr).toBe(0);
  const extracted = new Map(archiveCheck.stdout.trim().split(/\r?\n/).map(line => {
    const [name, payload] = line.split(":"); return [Buffer.from(name, "base64").toString("utf8"), Buffer.from(payload, "base64")];
  }));
  const expectedEntries = [...distribution].filter(([name]) => !name.endsWith(".zip") && name !== "SHA256SUMS");
  expect([...extracted.keys()].sort()).toEqual(expectedEntries.map(([name]) => name).sort());
  for (const [name, bytes] of expectedEntries) expect(extracted.get(name)).toEqual(bytes);
}, 60_000);

it.each([
  ["stale helper", "runtime", "dist/c2c/local.mjs", "// stale\n"],
  ["stale CLI", "runtime", "dist/cli/index.js", "// stale\n"],
  ["runtime source mismatch", "runtime", "src/version.ts", 'export const VERSION = "0.0.0";\n'],
  ["version mismatch", "source", "src/version.ts", 'export const VERSION = "0.0.0";\n'],
  ["missing reference", "source", "skill/references/setup.md", null],
  ["broken link", "source", "skill/references/workflow.md", "[broken](missing.md)\n"],
  ["unbound entrypoint", "source", "skill/SKILL.md", "---\nname: codex-with-chatgpt\n---\n"],
  ["unexpected credential file", "source", "skill/.env", "EXCLUDED_FIXTURE=1\n"],
] as const)("rejects %s without writing a distribution", async (_name, location, file, replacement) => {
  const target = path.join(location === "runtime" ? runtime : source, file);
  const original = fs.existsSync(target) ? fs.readFileSync(target) : undefined;
  const output = path.join(temporary, "rejected marketplace");
  try {
    if (replacement === null) fs.unlinkSync(target); else fs.writeFileSync(target, replacement);
    await expect(packagePlugin({ sourceRoot: source, runtimeCheckout: runtime, output })).rejects.toThrow();
    expect(fs.existsSync(output)).toBe(false);
  } finally {
    if (original) fs.writeFileSync(target, original); else fs.rmSync(target, { force: true });
  }
});

it("fails closed on altered archives, provenance, extra files and changed packaging source", async () => {
  const options = { sourceRoot: source, runtimeCheckout: runtime, output: path.join(temporary, "tampered marketplace") };
  const built = await packagePlugin(options);
  for (const name of [path.basename(built.artifact), "codex-with-chatgpt/provenance.json", "SHA256SUMS", "unexpected.txt"]) {
    const target = path.join(options.output, name), original = fs.existsSync(target) ? fs.readFileSync(target) : undefined;
    try {
      fs.writeFileSync(target, "tampered");
      await expect(packagePlugin({ ...options, check: true })).rejects.toThrow(/PLUGIN_PACKAGE_INVALID/);
      expect(fs.readFileSync(target, "utf8")).toBe("tampered");
    } finally { if (original) fs.writeFileSync(target, original); else fs.unlinkSync(target); }
  }
  const script = path.join(source, "scripts/package-plugin.mjs"), original = fs.readFileSync(script);
  try {
    fs.appendFileSync(script, "\n// changed source\n");
    await expect(packagePlugin({ ...options, check: true })).rejects.toThrow(/Distribution\/source mismatch/);
  } finally { fs.writeFileSync(script, original); }
}, 60_000);

it.each(["relative checkout", "C:/invalid/../checkout", "C:/invalid/<checkout>"])("rejects invalid binding %s", async runtimeCheckout => {
  await expect(expectedDistribution({ sourceRoot: source, runtimeCheckout })).rejects.toThrow(/PLUGIN_PACKAGE_INVALID/);
});

it("rejects a junction binding and a missing distribution in check mode", async () => {
  const alias = path.join(temporary, "runtime alias");
  fs.symlinkSync(runtime, alias, process.platform === "win32" ? "junction" : "dir");
  await expect(expectedDistribution({ sourceRoot: source, runtimeCheckout: alias })).rejects.toThrow(/Directory alias/);
  await expect(packagePlugin({ sourceRoot: source, runtimeCheckout: runtime,
    output: path.join(temporary, "absent marketplace"), check: true })).rejects.toThrow(/Missing distribution/);
});
