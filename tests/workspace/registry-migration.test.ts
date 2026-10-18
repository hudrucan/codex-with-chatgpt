import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveHub, hubMappingFile } from "../../src/migration/store.js";
import { Workspace } from "../../src/workspace/manager.js";
import { LegacyWorkspaceRegistry as WorkspaceRegistry } from "../../src/migration/adoption.js";
import { cleanup, isolateStateDir, makeTmpDir, write } from "../helpers.js";

let state: string;
let root: string;
let repo: string;
let foreignRoot: string;
beforeEach(() => { state = isolateStateDir(); root = makeTmpDir("migration-owner"); repo = makeTmpDir("migration-repo"); foreignRoot = makeTmpDir("migration-foreign"); });
afterEach(() => { vi.restoreAllMocks(); [state, root, repo, foreignRoot].forEach(cleanup); delete process.env.C2C_STATE_DIR; });
function legacy(owner = new Workspace(root)) {
  const registrations = [{ workspaceId: owner.id, alias: "custom-owner", root: owner.root },
    { workspaceId: new Workspace(repo).id, alias: "custom-repo", root: repo }];
  const file = write(state, `workspace-registries/${owner.id}.json`, JSON.stringify({ version: 1, ownerWorkspaceId: owner.id, workspaces: registrations }));
  return { file, registrations, contents: fs.readFileSync(file, "utf8") };
}
function initialized(owner: Workspace) { return JSON.parse(fs.readFileSync(hubMappingFile(owner.id), "utf8")).registryInitialized; }

describe("owner registry adoption by Hub", () => {
  it("copies only the verified owner registry, preserving aliases and resource identities without cleanup", () => {
    const owner = new Workspace(root);
    const saved = legacy(owner);
    const other = legacy(new Workspace(foreignRoot));
    const resources = ["auth", "runtime", "tunnels", "endpoints", "lifecycle"].map((dir) => {
      const file = write(state, `${dir}/${owner.id}.json`, JSON.stringify({ workspaceId: owner.id, marker: dir }));
      return { file, contents: fs.readFileSync(file, "utf8") };
    });
    const registry = WorkspaceRegistry.forWorkspace(owner);
    const hub = resolveHub(owner);
    expect(registry.hubId).toBe(hub.hubId);
    expect(registry.file).toBe(path.join(state, "workspace-registries", `${hub.hubId}.json`));
    expect(registry.list()).toEqual(saved.registrations);
    expect(registry.resolve("custom-repo").root).toBe(repo);
    expect(JSON.parse(fs.readFileSync(registry.file, "utf8"))).toEqual({ version: 2, hubId: hub.hubId, workspaces: saved.registrations });
    expect(initialized(owner)).toBe(true);
    for (const entry of [saved, other, ...resources]) expect(fs.readFileSync(entry.file, "utf8")).toBe(entry.contents);
    for (const dir of ["auth", "runtime", "tunnels", "endpoints", "lifecycle"]) expect(fs.readdirSync(path.join(state, dir))).toEqual([`${owner.id}.json`]);
  });

  it("never re-imports stale grants after initialization, including when the Hub registry is missing", () => {
    const owner = new Workspace(root);
    const saved = legacy(owner);
    const registry = WorkspaceRegistry.forWorkspace(owner);
    registry.remove("custom-repo");
    expect(WorkspaceRegistry.forWorkspace(owner).choices()).toEqual([{ alias: "custom-owner", workspaceId: owner.id }]);
    fs.unlinkSync(registry.file);
    expect(WorkspaceRegistry.forWorkspace(owner).list()).toEqual([]);
    expect(fs.readFileSync(saved.file, "utf8")).toBe(saved.contents);
  });

  it("does not adopt unowned or other-owner grants", () => {
    const owner = new Workspace(root);
    const foreign = legacy(new Workspace(foreignRoot));
    const unowned = write(state, "workspace-registry.json", JSON.stringify({ version: 1, workspaces: foreign.registrations }));
    const contents = fs.readFileSync(unowned, "utf8");
    const registry = WorkspaceRegistry.forWorkspace(owner);
    expect(registry.list()).toEqual([]);
    expect(() => registry.resolve(new Workspace(repo).id)).toThrow(expect.objectContaining({ code: "WORKSPACE_NOT_FOUND" }));
    expect(fs.readFileSync(foreign.file, "utf8")).toBe(foreign.contents);
    expect(fs.readFileSync(unowned, "utf8")).toBe(contents);
  });

  it.each(["wrong owner", "malformed", "duplicate alias"])("rejects %s legacy state without overwriting it", (kind) => {
    const owner = new Workspace(root);
    const saved = legacy(owner);
    const value = JSON.parse(saved.contents);
    if (kind === "wrong owner") value.ownerWorkspaceId = new Workspace(foreignRoot).id;
    if (kind === "duplicate alias") value.workspaces[1].alias = value.workspaces[0].alias;
    const content = kind === "malformed" ? "{" : JSON.stringify(value);
    fs.writeFileSync(saved.file, content);
    expect(() => WorkspaceRegistry.forWorkspace(owner)).toThrow(expect.objectContaining({ code: "WORKSPACE_REGISTRY_INVALID" }));
    expect(fs.readFileSync(saved.file, "utf8")).toBe(content);
    expect(initialized(owner)).toBe(false);
    expect(fs.existsSync(new WorkspaceRegistry(resolveHub(owner).hubId).file)).toBe(false);
  });

  it("refuses to merge a pending Hub registry with different grants", () => {
    const owner = new Workspace(root);
    legacy(owner);
    const hub = resolveHub(owner);
    const registry = new WorkspaceRegistry(hub.hubId);
    registry.add(foreignRoot, "foreign");
    const before = fs.readFileSync(registry.file, "utf8");
    expect(() => WorkspaceRegistry.forWorkspace(owner)).toThrow(/conflicts with pending legacy adoption/);
    expect(fs.readFileSync(registry.file, "utf8")).toBe(before);
    expect(initialized(owner)).toBe(false);
  });

  it("resumes a completed copy after an interrupted mapping checkpoint without creating another Hub", () => {
    const owner = new Workspace(root);
    const saved = legacy(owner);
    const hub = resolveHub(owner);
    const original = fs.renameSync;
    const rename = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (String(to) === hubMappingFile(owner.id)) throw new Error("checkpoint failed");
      return original(from, to);
    });
    expect(() => WorkspaceRegistry.forWorkspace(owner)).toThrow(/checkpoint failed/);
    expect(initialized(owner)).toBe(false);
    rename.mockRestore();
    const registry = WorkspaceRegistry.forWorkspace(owner);
    expect(registry.hubId).toBe(hub.hubId);
    expect(registry.list()).toEqual(saved.registrations);
    expect(initialized(owner)).toBe(true);
    expect(fs.readdirSync(path.join(state, "hubs"))).toEqual([`${hub.hubId}.json`]);
  });

  it("defers adoption while a legacy writer holds its lock", () => {
    const owner = new Workspace(root);
    const saved = legacy(owner);
    fs.writeFileSync(`${saved.file}.lock`, "");
    expect(() => WorkspaceRegistry.forWorkspace(owner)).toThrow(expect.objectContaining({ code: "WORKSPACE_REGISTRY_BUSY" }));
    expect(initialized(owner)).toBe(false);
    expect(fs.readFileSync(saved.file, "utf8")).toBe(saved.contents);
    fs.unlinkSync(`${saved.file}.lock`);
    expect(WorkspaceRegistry.forWorkspace(owner).list()).toEqual(saved.registrations);
  });
});
