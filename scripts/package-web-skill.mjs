import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalDirectory, read, git, json, sha256, zip, validateLinks, writeDistribution } from "./package-plugin.mjs";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const name = "codex-with-chatgpt";
const sourceFiles = ["package.json", "pnpm-lock.yaml", "src/version.ts", "web-skill/SKILL.md", "web-skill/agents/openai.yaml",
  "skill/references/workflow.md", "skill/references/workflow-web.md", "scripts/package-web-skill.mjs",
  "scripts/package-plugin.mjs", "scripts/build-c2c.mjs"];
const fail = message => { throw new Error(`WEB_SKILL_INVALID: ${message}`); };

export function expectedWebSkill({ sourceRoot = repository } = {}) {
  const source = canonicalDirectory(sourceRoot);
  const inputs = new Map(sourceFiles.map(file => [file, read(source, file)]));
  const metadata = JSON.parse(inputs.get("package.json"));
  if (metadata.name !== name || !/^\d+\.\d+\.\d+$/.test(metadata.version)
    || !inputs.get("src/version.ts").toString().includes(`export const VERSION = "${metadata.version}";`)) fail("Identity/version mismatch");

  // Flatten only links to the excluded Local sender; preserve the remaining common text.
  // The receiver is byte-for-byte canonical, with no manually maintained snapshot.
  const common = inputs.get("skill/references/workflow.md").toString("utf8")
    .replace(/\[([^\]]+)\]\(workflow-async\.md(?:#[^)]*)?\)/g, "$1 (Codex Local only)");
  const skill = new Map([
    ["SKILL.md", inputs.get("web-skill/SKILL.md")],
    ["agents/openai.yaml", inputs.get("web-skill/agents/openai.yaml")],
    ["references/workflow.md", Buffer.from(common)],
    ["references/workflow-web.md", inputs.get("skill/references/workflow-web.md")],
  ]);
  const entry = skill.get("SKILL.md").toString("utf8");
  if (!/^---\r?\nname: codex-with-chatgpt\r?\ndescription: [\s\S]+?\r?\n---\r?\n/.test(entry)) fail("Invalid Web Skill metadata");
  const ui = skill.get("agents/openai.yaml").toString("utf8");
  if (!ui.includes('display_name: "codex-with-chatgpt"') || !/^  allow_implicit_invocation: true\r?$/m.test(ui)
    || /^(?:dependencies|hooks|apps):/m.test(ui)) fail("Invalid automatic discovery metadata");
  for (const bytes of skill.values()) {
    const text = bytes.toString("utf8");
    if (/(?:^|[\s`"(])(?:[A-Za-z]:[\\/]|\\\\|<ACTUAL_CHECKOUT_PATH>|\/Users\/|\/home\/|~\/)/m.test(text)) fail("Machine-local path in Web Skill");
    if (/\b(?:(?:plugin_)?asdk_app_|connector_|templated_apps_)[A-Za-z0-9_-]+|\bhub-[a-f0-9]{8}-|\b[a-f0-9]{12}\b/.test(text))
      fail("Connection identity in Web Skill; use Project routing");
  }
  validateLinks(skill);
  const entries = new Map([...skill].map(([file, bytes]) => [`${name}/${file}`, bytes]));
  const archive = "skill.zip", payload = zip(entries);
  const provenance = { formatVersion: 1, name, version: metadata.version, host: "chatgpt-web-skill",
    source: { revision: git(source, "rev-parse", "HEAD"),
      inputs: Object.fromEntries([...inputs].map(([file, bytes]) => [file, sha256(bytes)])) },
    transforms: { "references/workflow.md": "Flatten workflow-async.md links to Codex Local only text; preserve all other text." },
    files: Object.fromEntries([...entries].map(([file, bytes]) => [file, sha256(bytes)])),
    archive: { file: archive, sha256: sha256(payload) },
  };
  const distribution = new Map([...entries, [archive, payload], ["provenance.json", json(provenance)]]);
  distribution.set("SHA256SUMS", Buffer.from([...distribution].map(([file, bytes]) => `${sha256(bytes)}  ${file}\n`).sort().join("")));
  for (const [file, bytes] of inputs) if (!read(source, file).equals(bytes)) fail(`Source changed during packaging: ${file}`);
  return { distribution, archive, sha256: sha256(payload) };
}

export function packageWebSkill({ output = path.join(repository, "dist", "web-skill"), check = false, ...options } = {}) {
  return writeDistribution(expectedWebSkill(options), output, check);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2), check = args[0] === "--check";
    if (check) args.shift();
    if (args.length) fail("Usage: [--check]");
    console.log(JSON.stringify(packageWebSkill({ check })));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
