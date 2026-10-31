import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { expectedWebSkill, packageWebSkill } from "../../scripts/package-web-skill.mjs";
import { sha256 } from "../../scripts/package-plugin.mjs";
import { cleanup, makeGitRepo, makeTmpDir } from "../helpers.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
let temporary: string, source: string;
beforeAll(() => {
  temporary = makeTmpDir("Web Skill with spaces"); source = path.join(temporary, "source with spaces");
  fs.mkdirSync(source); makeGitRepo(source);
  for (const file of ["package.json", "pnpm-lock.yaml", "src/version.ts", "web-skill", "scripts", "skill"]) {
    fs.mkdirSync(path.dirname(path.join(source, file)), { recursive: true });
    fs.cpSync(path.join(root, file), path.join(source, file), { recursive: true });
  }
  for (const file of [".env", "node_modules/private.txt", "dist/runtime.json", "web-skill/unrelated.txt", ".app.json"]) {
    fs.mkdirSync(path.dirname(path.join(source, file)), { recursive: true });
    fs.writeFileSync(path.join(source, file), "EXCLUDED_FIXTURE");
  }
});
afterAll(() => cleanup(temporary));

function archiveEntries(bytes: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>(); let offset = 0;
  while (bytes.readUInt32LE(offset) === 0x04034b50) {
    expect(bytes.readUInt16LE(offset + 8)).toBe(0);
    const size = bytes.readUInt32LE(offset + 18), length = bytes.readUInt16LE(offset + 26), extra = bytes.readUInt16LE(offset + 28);
    const name = bytes.subarray(offset + 30, offset + 30 + length).toString();
    expect(entries.has(name)).toBe(false); expect(name).not.toMatch(/(^\/|\\|(?:^|\/)\.\.(?:\/|$))/);
    const start = offset + 30 + length + extra;
    entries.set(name, bytes.subarray(start, start + size)); offset = start + size;
  }
  expect(bytes.readUInt32LE(offset)).toBe(0x02014b50);
  expect(bytes.readUInt32LE(bytes.length - 22)).toBe(0x06054b50);
  expect(bytes.readUInt16LE(bytes.length - 12)).toBe(entries.size);
  return entries;
}

it("packages exactly one portable Web Skill, automatic metadata, canonical receiver and verifiable reproducible ZIP", () => {
  const options = { sourceRoot: source, output: path.join(temporary, "Web output") };
  const first = packageWebSkill(options), checked = packageWebSkill({ ...options, check: true });
  const second = packageWebSkill({ ...options, output: path.join(temporary, "reproduced output") });
  expect(path.basename(first.artifact)).toBe("skill.zip");
  expect(first.sha256).toBe(checked.sha256); expect(first.sha256).toBe(second.sha256);
  const entries = archiveEntries(fs.readFileSync(first.artifact));
  expect([...entries.keys()].sort()).toEqual(["SKILL.md", "agents/openai.yaml", "references/workflow-web.md", "references/workflow.md"]
    .map(file => `codex-with-chatgpt/${file}`).sort());
  for (const bytes of entries.values()) expect(bytes.toString()).not.toContain("EXCLUDED_FIXTURE");
  expect(entries.get("codex-with-chatgpt/SKILL.md")!.toString()).toContain("first-line [C2C Handoff]");
  expect(entries.get("codex-with-chatgpt/agents/openai.yaml")!.toString()).toContain("allow_implicit_invocation: true");
  expect(entries.get("codex-with-chatgpt/references/workflow-web.md"))
    .toEqual(fs.readFileSync(path.join(source, "skill/references/workflow-web.md")));
  const original = fs.readFileSync(path.join(source, "skill/references/workflow.md"), "utf8");
  expect(entries.get("codex-with-chatgpt/references/workflow.md")!.toString()).toBe(
    original.replace(/\[([^\]]+)\]\(workflow-async\.md(?:#[^)]*)?\)/g, "$1 (Codex Local only)"));
  expect(fs.readFileSync(path.join(source, "skill/references/workflow.md"), "utf8")).toBe(original);
  const expected = expectedWebSkill({ sourceRoot: source });
  const provenance = JSON.parse(expected.distribution.get("provenance.json")!.toString());
  expect(provenance.host).toBe("chatgpt-web-skill"); expect(provenance.version).toBe("0.4.0");
  expect(provenance.source.revision).toMatch(/^[a-f0-9]{40}$/);
  expect(provenance.archive).toEqual({ file: "skill.zip", sha256: first.sha256 });
  for (const [file, digest] of Object.entries(provenance.files)) expect(sha256(entries.get(file)!)).toBe(digest);
  for (const [file, digest] of Object.entries(provenance.source.inputs)) expect(sha256(fs.readFileSync(path.join(source, file)))).toBe(digest);
  for (const line of expected.distribution.get("SHA256SUMS")!.toString().trim().split("\n")) {
    const [digest, file] = line.split("  "); expect(sha256(expected.distribution.get(file)!)).toBe(digest);
  }
  if (process.platform === "win32") {
    const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", "Add-Type -AssemblyName System.IO.Compression.FileSystem; " +
      `$z=[IO.Compression.ZipFile]::OpenRead('${first.artifact.replace(/'/g, "''")}'); try { foreach($e in $z.Entries) { ` +
      "$s=$e.Open(); try { $h=[Security.Cryptography.SHA256]::Create(); $e.FullName+':'+[BitConverter]::ToString($h.ComputeHash($s)).Replace('-','').ToLower() } finally { $s.Dispose() } } } finally { $z.Dispose() }"],
      { encoding: "utf8", windowsHide: true });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split(/\r?\n/).sort()).toEqual([...entries].map(([file, bytes]) => `${file}:${sha256(bytes)}`).sort());
  }
});

it.each([
  ["skill/references/workflow-web.md", null],
  ["skill/references/workflow-web.md", "[broken](absent.md)\n"],
  ["skill/references/workflow-web.md", "[broken anchor](workflow.md#absent-heading)\n"],
  ["skill/references/workflow-web.md", "Checkout: C:/Users/fixture/runtime\n"],
  ["skill/references/workflow-web.md", "Connector: asdk_app_fixture\n"],
  ["web-skill/agents/openai.yaml", 'interface:\n  display_name: "codex-with-chatgpt"\npolicy:\n  allow_implicit_invocation: false\n'],
  ["src/version.ts", 'export const VERSION = "0.0.0";\n'],
] as const)("fails closed on missing/invalid Web input %s: %s", (file, replacement) => {
  const target = path.join(source, file), original = fs.readFileSync(target);
  try {
    if (replacement === null) fs.unlinkSync(target); else fs.writeFileSync(target, replacement);
    expect(() => packageWebSkill({ sourceRoot: source, output: path.join(temporary, "rejected output") })).toThrow();
    expect(fs.existsSync(path.join(temporary, "rejected output"))).toBe(false);
  } finally { fs.writeFileSync(target, original); }
});

it("rejects stale ZIP/provenance/checksums, source drift, invalid roots and output aliases", () => {
  const options = { sourceRoot: source, output: path.join(temporary, "tampered output") };
  packageWebSkill(options);
  for (const file of ["skill.zip", "provenance.json", "SHA256SUMS", "extra.txt"]) {
    const target = path.join(options.output, file), original = fs.existsSync(target) ? fs.readFileSync(target) : undefined;
    try { fs.writeFileSync(target, "tampered"); expect(() => packageWebSkill({ ...options, check: true })).toThrow(); }
    finally { if (original) fs.writeFileSync(target, original); else fs.unlinkSync(target); }
  }
  const target = path.join(source, "scripts/package-web-skill.mjs"), original = fs.readFileSync(target);
  try { fs.appendFileSync(target, "\n// changed\n"); expect(() => packageWebSkill({ ...options, check: true })).toThrow(/mismatch/); }
  finally { fs.writeFileSync(target, original); }
  const alias = path.join(temporary, "source alias"); fs.symlinkSync(source, alias, process.platform === "win32" ? "junction" : "dir");
  expect(() => expectedWebSkill({ sourceRoot: alias })).toThrow(/alias/);
  expect(() => packageWebSkill({ ...options, output: path.join(alias, "output") })).toThrow(/alias/);
  expect(() => packageWebSkill({ ...options, output: path.join(temporary, "absent output"), check: true })).toThrow(/Missing/);
});
