import { createHub as createFixtureHub, listHubs as fixtureHubs } from "../src/hub/store.js";
import { Workspace as FixtureWorkspace } from "../src/workspace/manager.js";
import { WorkspaceRegistry as FixtureRegistry } from "../src/workspace/registry.js";
import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Temp dirs live inside the repo (.tooling/test-tmp) so tests also run in
 * sandboxed environments where the system temp dir is not writable.
 */
export function makeTmpDir(name: string): string {
  const dir = path.join(projectRoot, ".tooling", "test-tmp", `${name}-${randomBytes(4).toString("hex")}`);
  fs.mkdirSync(dir, { recursive: true });
  return fs.realpathSync.native(dir);
}

export function cleanup(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // best effort
  }
}

export function write(dir: string, rel: string, content: string): string {
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "c2c-test",
  GIT_AUTHOR_EMAIL: "test@c2c.local",
  GIT_COMMITTER_NAME: "c2c-test",
  GIT_COMMITTER_EMAIL: "test@c2c.local",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

export function git(dir: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd: dir, encoding: "utf8", env: GIT_ENV });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout;
}

export function makeGitRepo(dir: string): void {
  git(dir, "init", "-b", "main");
  write(dir, "hello.txt", "Hello from Desk C2C Hub!\n");
  write(dir, "src/index.ts", "export const answer = 42;\n");
  git(dir, "add", ".");
  git(dir, "commit", "-m", "initial commit");
}

/** Point the persistent state dir at an isolated temp location. */
export function isolateStateDir(): string {
  const dir = makeTmpDir("state");
  process.env.C2C_STATE_DIR = dir;
  return dir;
}

export function pkceVerifierAndChallenge(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

// Explicit native Hub fixtures; repository identity is only a test lookup key.
const nativeFixtures = new Map<string, import("../src/hub/store.js").Hub>();
export function fixtureHub(value: string | Pick<import("../src/workspace/manager.js").Workspace, "id" | "name">) {
  const workspace = typeof value === "string" ? new FixtureWorkspace(value) : value;
  const key = `${process.env.C2C_STATE_DIR}:${workspace.id}`;
  let hub = nativeFixtures.get(key);
  if (!hub) { hub = fixtureHubs().find(candidate => new FixtureRegistry(candidate.hubId).choices().some(entry => entry.workspaceId === workspace.id)) ?? createFixtureHub(workspace.name); nativeFixtures.set(key, hub); }
  if (typeof value === "string" || "root" in value) {
    const root = typeof value === "string" ? value : String(value.root);
    if (fs.existsSync(root) && fs.existsSync(path.join(process.env.C2C_STATE_DIR!,"hubs",`${hub.hubId}.json`))) new FixtureRegistry(hub.hubId).add(root);
  }
  return hub;
}
export function fixtureRegistry(workspace: import("../src/workspace/manager.js").Workspace) {
  return new FixtureRegistry(fixtureHub(workspace).hubId);
}
export function fixtureWorkspace(bridge: {hubId:string}) {
  return new FixtureWorkspace(new FixtureRegistry(bridge.hubId).list()[0].root);
}
export function fixtureAuthFile(hubId: string, file: string): string {
  fs.mkdirSync(path.dirname(file),{recursive:true});
  fs.copyFileSync(path.join(process.env.C2C_STATE_DIR!,"auth",`${hubId}.json`),file);return file;
}
