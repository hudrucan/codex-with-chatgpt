import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";
import { Workspace } from "../src/workspace/manager.js";
import { cleanup, isolateStateDir, makeTmpDir } from "./helpers.js";

const entry = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));
let state: string;
let root: string;
let other: string;
beforeEach(() => { state = isolateStateDir(); root = makeTmpDir("registry-cli"); other = makeTmpDir("registry-cli-other"); });
afterEach(() => { for (const dir of [state, root, other]) cleanup(dir); delete process.env.C2C_STATE_DIR; });
function cli(args: string[], cwd = root) {
  return spawnSync(process.execPath, ["--import", "tsx", entry, "workspace", ...args], {
    cwd, env: { ...process.env, C2C_STATE_DIR: state }, encoding: "utf8", timeout: 10_000,
  });
}
function json(args: string[], cwd = root) {
  const result = cli([...args, "--json"], cwd);
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  return JSON.parse(result.stdout);
}

it("preserves bare workspace -w and supports owner-scoped list/add/remove by alias or ID", () => {
  const id = new Workspace(root).id;
  expect(json(["-w", root])).toMatchObject({ workspaceId: id, root });
  expect(json(["list", "-w", root])).toEqual({ workspaces: [] });
  expect(json(["add", root, "-w", root, "--alias", "alpha"])).toEqual({ ok: true, workspaceId: id, root, alias: "alpha" });
  const second = json(["add", other, "-w", root]);
  expect(second.alias).toContain(second.workspaceId);
  expect(json(["list", "-w", root]).workspaces).toHaveLength(2);
  expect(cli(["list", "-w", root]).stdout).toContain("alpha");
  expect(json(["remove", "alpha", "-w", root]).workspaceId).toBe(id);
  expect(json(["remove", second.workspaceId, "-w", root]).alias).toBe(second.alias);
  expect(json(["list", "-w", root])).toEqual({ workspaces: [] });
  expect(fs.readdirSync(root)).toEqual([]);
  expect(fs.readdirSync(other)).toEqual([]);
  expect(fs.readdirSync(state)).toEqual(["workspace-registries"]);
  expect(fs.readdirSync(path.join(state, "workspace-registries"))).toEqual([`${id}.json`]);
});

it("resolves the owner from -w before/after the subcommand or defaults to cwd", () => {
  const id = new Workspace(root).id;
  const otherId = new Workspace(other).id;
  // Run from the other owner's directory to prove -w takes precedence over cwd.
  json(["-w", root, "add", root, "--alias", "shared"], other);
  expect(json(["list", "-w", root], other).workspaces).toEqual([{ workspaceId: id, root, alias: "shared" }]);
  expect(json(["list"], other)).toEqual({ workspaces: [] });
  // The same alias is independently available to a second owner.
  json(["add", other, "--alias", "shared"], other);
  expect(json(["-w", other, "list"], root).workspaces).toEqual([{ workspaceId: otherId, root: other, alias: "shared" }]);
  const denied = cli(["remove", id, "-w", other]);
  expect(denied.status).toBe(1);
  expect(json(["list", "-w", root]).workspaces).toHaveLength(1);
  expect(json(["-w", root, "remove", "shared"], other).workspaceId).toBe(id);
  expect(json(["list", "-w", other]).workspaces).toHaveLength(1);
});

it("rejects missing repo paths, invalid owners/aliases, conflicts and unknown removals", () => {
  expect(cli(["add"]).status).not.toBe(0);
  // The old unowned syntax cannot silently reinterpret the target as the owner.
  expect(cli(["add", "-w", root]).status).not.toBe(0);
  json(["add", root, "-w", root, "--alias", "alpha"]);
  for (const args of [["add", path.join(root, "missing"), "-w", root], ["add", other, "-w", root, "--alias", "alpha"],
    ["add", other, "-w", root, "--alias", "../bad"], ["remove", root, "-w", root],
    ["list", "-w", path.join(root, "missing")]]) {
    const result = cli([...args, "--json"]);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).ok).toBe(false);
  }
  expect(json(["list", "-w", root]).workspaces).toHaveLength(1);
});
