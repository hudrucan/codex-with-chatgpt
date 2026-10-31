import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { buildC2C } from "./build-c2c.mjs";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pluginName = "codex-with-chatgpt";
const marketplaceName = "hudrucan";
const skillFiles = ["SKILL.md", "agents/openai.yaml", ...[
  "deprovision", "operations", "projects", "setup", "workflow", "workflow-async", "workflow-web",
].map(name => `references/${name}.md`)];
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const json = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);

function fail(message) { throw new Error(`PLUGIN_PACKAGE_INVALID: ${message}`); }
function read(root, relative) {
  if (!relative || relative.includes("\\") || relative.split("/").some(part => !part || part === "." || part === ".."))
    fail(`Invalid relative path: ${relative}`);
  let current = root;
  for (const component of relative.split("/")) {
    current = path.join(current, component);
    if (fs.lstatSync(current).isSymbolicLink()) fail(`Symbolic link: ${relative}`);
  }
  if (!fs.statSync(current).isFile()) fail(`Not a regular file: ${relative}`);
  return fs.readFileSync(current);
}
function canonicalDirectory(value) {
  if (typeof value !== "string" || !path.isAbsolute(value) || /[\x00-\x1f`<>]/.test(value)) fail("Expected an absolute directory path");
  // Reject traversal and symlink/junction components, including in the output parent.
  if (value.split(/[\\/]/).includes("..")) fail("Directory traversal");
  let current = path.parse(value).root;
  for (const component of value.slice(current.length).split(/[\\/]/).filter(Boolean)) {
    current = path.join(current, component);
    if (fs.lstatSync(current).isSymbolicLink()) fail("Directory alias is not supported");
  }
  if (!fs.statSync(value).isDirectory()) fail("Expected a directory");
  return fs.realpathSync.native(value);
}
function git(root, ...args) {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) fail("Cannot establish source revision");
  return result.stdout.trim();
}
function files(root, relative = "") {
  return fs.readdirSync(path.join(root, relative), { withFileTypes: true }).flatMap(entry => {
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) fail(`Symbolic link: ${name}`);
    if (entry.isDirectory()) return files(root, name);
    if (!entry.isFile()) fail(`Not a regular file: ${name}`);
    return [name];
  }).sort();
}
function validateLinks(contents) {
  for (const [name, bytes] of contents) {
    if (!name.endsWith(".md")) continue;
    for (const [, target] of bytes.toString("utf8").matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      if (/^https?:\/\//.test(target)) continue;
      const [file, anchor] = target.split("#");
      if (target.includes("\\") || path.posix.isAbsolute(file) || /^[a-z]+:/i.test(file)) fail(`Invalid link: ${target}`);
      const resolved = file ? path.posix.normalize(path.posix.join(path.posix.dirname(name), file)) : name;
      const destination = contents.get(resolved);
      if (!destination) fail(`Missing reference: ${target}`);
      if (anchor) {
        const headings = [...destination.toString("utf8").matchAll(/^#+ (.+)$/gm)]
          .map(([, heading]) => heading.trim().toLowerCase().replace(/[^\p{L}\p{N}_ -]/gu, "").replace(/ /g, "-"));
        if (!headings.includes(anchor)) fail(`Missing anchor: ${target}`);
      }
    }
  }
}

// Stored ZIP entries with a fixed DOS epoch, sorted names, no host paths or timestamps.
function zip(entries) {
  const local = [], central = [];
  let offset = 0;
  for (const [name, bytes] of [...entries].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    const filename = Buffer.from(name);
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6);
    header.writeUInt16LE(33, 12); header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(bytes.length, 18); header.writeUInt32LE(bytes.length, 22); header.writeUInt16LE(filename.length, 26);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(0x800, 8); directory.writeUInt16LE(33, 14); directory.writeUInt32LE(crc, 16);
    directory.writeUInt32LE(bytes.length, 20); directory.writeUInt32LE(bytes.length, 24);
    directory.writeUInt16LE(filename.length, 28); directory.writeUInt32LE(offset, 42);
    local.push(header, filename, bytes); central.push(directory, filename);
    offset += header.length + filename.length + bytes.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.size, 8); end.writeUInt16LE(entries.size, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

export async function expectedDistribution({ sourceRoot = repository, runtimeCheckout }) {
  const source = canonicalDirectory(sourceRoot), runtime = canonicalDirectory(runtimeCheckout);
  const metadata = JSON.parse(read(source, "package.json"));
  if (metadata.name !== pluginName || !/^\d+\.\d+\.\d+$/.test(metadata.version)) fail("Invalid package identity/version");
  if (!read(source, "src/version.ts").toString("utf8").includes(`export const VERSION = "${metadata.version}";`)) fail("Contract version mismatch");
  if (files(path.join(source, "src")).some(name => !name.endsWith(".ts"))) fail("Unexpected runtime source contents");
  const sourceFiles = ["package.json", "pnpm-lock.yaml", "LICENSE", "tsconfig.json", "bin/c2c.js", "scripts/build.mjs", "scripts/build-c2c.mjs", "scripts/package-plugin.mjs",
    ...files(path.join(source, "src")).map(name => `src/${name}`), ...skillFiles.map(name => `skill/${name}`)].sort();
  const inputs = Object.fromEntries(sourceFiles.map(name => [name, sha256(read(source, name))]));
  if (JSON.stringify(files(path.join(source, "skill"))) !== JSON.stringify([...skillFiles].sort())) fail("Unexpected Skill contents");
  if (JSON.parse(read(runtime, "package.json")).version !== metadata.version) fail("Runtime version mismatch");
  for (const name of sourceFiles.filter(name => name.startsWith("src/") || ["bin/c2c.js", "tsconfig.json"].includes(name))) {
    if (sha256(read(runtime, name)) !== inputs[name]) fail(`Runtime source mismatch: ${name}`);
  }
  const runtimeArtifacts = {};
  const config = ts.parseJsonConfigFileContent(JSON.parse(read(source, "tsconfig.json")), ts.sys, source);
  const program = ts.createProgram(config.fileNames, { ...config.options, noEmit: false });
  const emitted = new Map();
  const result = program.emit(undefined, (name, text) => {
    if (name.endsWith(".js")) emitted.set(path.relative(path.join(source, "dist"), name).split(path.sep).join("/"), Buffer.from(text));
  });
  if (result.emitSkipped || !emitted.size || result.diagnostics.length) fail("Cannot validate runtime build");
  for (const [name, bytes] of emitted) {
    const relative = `dist/${name}`;
    if (sha256(read(runtime, relative)) !== sha256(bytes)) fail(`Stale runtime artifact: ${relative}`);
    runtimeArtifacts[relative] = sha256(bytes);
  }
  for (const output of await buildC2C(path.join(source, "dist", "c2c"), { write: false, sourceRoot: source })) {
    const relative = `dist/c2c/${path.basename(output.path)}`;
    if (sha256(read(runtime, relative)) !== sha256(output.contents)) fail(`Stale runtime artifact: ${relative}`);
    runtimeArtifacts[relative] = sha256(output.contents);
  }
  const skill = new Map(skillFiles.map(name => [name, read(source, `skill/${name}`)]));
  const entrypoint = skill.get("SKILL.md").toString("utf8");
  if ((entrypoint.match(/<ACTUAL_CHECKOUT_PATH>/g) ?? []).length !== 1) fail("Expected exactly one checkout binding");
  if (!entrypoint.startsWith(`---\r\nname: ${pluginName}\r\n`) && !entrypoint.startsWith(`---\nname: ${pluginName}\n`)) fail("Invalid Skill identity");
  skill.set("SKILL.md", Buffer.from(entrypoint.replace("<ACTUAL_CHECKOUT_PATH>", runtime.split(path.sep).join("/"))));
  validateLinks(skill);
  const plugin = new Map([
    [".codex-plugin/plugin.json", json({ name: pluginName, version: metadata.version, description: metadata.description,
      skills: "./skills/", interface: { displayName: pluginName } })],
    ["LICENSE", read(source, "LICENSE")],
    ...[...skill].map(([name, bytes]) => [`skills/${pluginName}/${name}`, bytes]),
  ]);
  plugin.set("provenance.json", json({ formatVersion: 1, name: pluginName, version: metadata.version,
    source: { revision: git(source, "rev-parse", "HEAD"), inputs },
    runtime: { checkout: runtime.split(path.sep).join("/"), revision: git(runtime, "rev-parse", "HEAD"), artifacts: runtimeArtifacts },
    files: Object.fromEntries([...plugin].map(([name, bytes]) => [name, sha256(bytes)])),
  }));
  const distribution = new Map([
    [".agents/plugins/marketplace.json", json({ name: marketplaceName, interface: { displayName: "hudrucan" },
      plugins: [{ name: pluginName, source: { source: "local", path: `./${pluginName}` },
        policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" } }] })],
    ...[...plugin].map(([name, bytes]) => [`${pluginName}/${name}`, bytes]),
  ]);
  const archive = `${pluginName}-${metadata.version}.zip`;
  distribution.set(archive, zip(new Map(distribution)));
  distribution.set("SHA256SUMS", Buffer.from([...distribution].map(([name, bytes]) => `${sha256(bytes)}  ${name}\n`).sort().join("")));
  for (const [name, hash] of Object.entries(inputs)) if (sha256(read(source, name)) !== hash) fail(`Source changed during packaging: ${name}`);
  for (const [name, hash] of Object.entries(runtimeArtifacts)) if (sha256(read(runtime, name)) !== hash) fail(`Runtime changed during packaging: ${name}`);
  return { distribution, archive, sha256: sha256(distribution.get(archive)) };
}

export async function packagePlugin({ output = path.join(repository, "dist", "plugin-marketplace"), check = false, ...options }) {
  const expected = await expectedDistribution(options);
  const parent = canonicalDirectory(path.dirname(output));
  if (path.resolve(output) !== path.join(parent, path.basename(output)) || !/^[a-zA-Z0-9][a-zA-Z0-9._ -]*$/.test(path.basename(output))) fail("Invalid output path");
  if (fs.existsSync(output)) {
    canonicalDirectory(output);
    if (JSON.stringify(files(output)) !== JSON.stringify([...expected.distribution.keys()].sort())) fail("Stale distribution file list");
    for (const [name, bytes] of expected.distribution) if (!read(output, name).equals(bytes)) fail(`Distribution/source mismatch: ${name}`);
  } else {
    if (check) fail("Missing distribution");
    fs.mkdirSync(output);
    for (const [name, bytes] of expected.distribution) {
      const destination = path.join(output, name);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, bytes, { flag: "wx" });
    }
  }
  return { artifact: path.join(output, expected.archive), sha256: expected.sha256, files: expected.distribution.size };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2), check = args[0] === "--check";
    if (check) args.shift();
    if (args.length !== 2 || args[0] !== "--runtime-checkout") fail("Usage: [--check] --runtime-checkout <absolute checkout>");
    console.log(JSON.stringify(await packagePlugin({ runtimeCheckout: args[1], check })));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
