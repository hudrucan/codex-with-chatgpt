import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Workspace } from "../src/workspace/manager.js";
import { WorkspaceRegistry } from "../src/workspace/registry.js";
import { cleanup, isolateStateDir, makeTmpDir, write } from "./helpers.js";

let state: string;
let root: string;
let other: string;
let registry: WorkspaceRegistry;
beforeEach(() => {
  state = isolateStateDir();
  root = makeTmpDir("registry-a");
  other = makeTmpDir("registry-b");
  registry = new WorkspaceRegistry(new Workspace(root).id);
});
afterEach(() => {
  for (const dir of [state, root, other]) cleanup(dir);
  delete process.env.C2C_STATE_DIR;
});

describe("external workspace registry", () => {
  it("persists canonical identities and stable aliases without writing repo configuration", () => {
    const link = path.join(state, "link");
    fs.symlinkSync(root, link, "junction");
    write(root, ".c2c.json", '{"name":"Legacy display"}');
    const before = fs.readFileSync(path.join(root, ".c2c.json"), "utf8");
    const entry = registry.add(link);
    expect(entry).toEqual({ workspaceId: new Workspace(root).id, alias: expect.stringMatching(/^registry-a-.*-[a-f0-9]{12}$/), root });
    expect(new WorkspaceRegistry(new Workspace(root).id).add(root)).toEqual(entry);
    expect(registry.list()).toEqual([entry]);
    expect(registry.resolve().id).toBe(entry.workspaceId);
    expect(registry.resolve(entry.alias).name).toBe("Legacy display");
    expect(registry.resolve(entry.workspaceId).root).toBe(root);
    expect(fs.readdirSync(root)).toEqual([".c2c.json"]);
    expect(fs.readFileSync(path.join(root, ".c2c.json"), "utf8")).toBe(before);
    expect(JSON.parse(fs.readFileSync(registry.file, "utf8"))).toEqual({ version: 1, ownerWorkspaceId: registry.ownerWorkspaceId, workspaces: [entry] });
    if (process.platform !== "win32") expect(fs.statSync(registry.file).mode & 0o777).toBe(0o600);
  });

  it("requires selection for multiple roots and never accepts a path or guesses after removal", () => {
    const a = registry.add(root, "alpha");
    const b = registry.add(other, "beta");
    expect(() => registry.resolve()).toThrow(expect.objectContaining({ code: "WORKSPACE_REQUIRED", workspaces: [
      { alias: "alpha", workspaceId: a.workspaceId }, { alias: "beta", workspaceId: b.workspaceId },
    ] }));
    for (const selector of [root, other, ".", "../", "workspace:/", "unknown", ""]) {
      expect(() => registry.resolve(selector)).toThrow(expect.objectContaining({ code: "WORKSPACE_NOT_FOUND" }));
    }
    registry.remove(a.workspaceId);
    expect(registry.resolve().root).toBe(other);
    expect(() => registry.resolve("alpha")).toThrow();
    registry.remove("beta");
    expect(() => registry.resolve()).toThrow(expect.objectContaining({ code: "WORKSPACE_NOT_FOUND" }));
  });

  it("rejects ambiguous/unsafe aliases and preserves explicit aliases on automatic registration", () => {
    const a = registry.add(root, "alpha");
    expect(registry.add(root)).toEqual(a);
    expect(() => registry.add(other, "alpha")).toThrow(expect.objectContaining({ code: "WORKSPACE_ALIAS_CONFLICT" }));
    for (const alias of ["", "UPPER", "../path", "hello world", "a\n", a.workspaceId]) {
      expect(() => registry.add(other, alias)).toThrow(expect.objectContaining({ code: "INVALID_WORKSPACE_ALIAS" }));
    }
    registry.add(root, "renamed");
    expect(() => registry.resolve("alpha")).toThrow();
    expect(registry.resolve("renamed").root).toBe(root);
  });

  it("disambiguates identical basenames deterministically regardless of registration order", () => {
    const first = path.dirname(write(root, "same/file.txt", "a"));
    const second = path.dirname(write(other, "same/file.txt", "b"));
    const a = registry.add(first);
    const b = registry.add(second);
    expect(a.alias).not.toBe(b.alias);
    registry.remove(a.alias);
    registry.remove(b.alias);
    expect(registry.add(second)).toEqual(b);
    expect(registry.add(first)).toEqual(a);
  });

  it("fails closed for corrupt registries and conflicting identities", () => {
    const a = registry.add(root, "alpha");
    for (const value of ["{", JSON.stringify({ version: 2, workspaces: [] }), JSON.stringify({ version: 1, ownerWorkspaceId: registry.ownerWorkspaceId, workspaces: [a, a] })]) {
      fs.writeFileSync(registry.file, value);
      expect(() => registry.list()).toThrow(expect.objectContaining({ code: "WORKSPACE_REGISTRY_INVALID" }));
      expect(() => registry.add(other)).toThrow();
      expect(fs.readFileSync(registry.file, "utf8")).toBe(value);
    }
    expect(fs.existsSync(`${registry.file}.lock`)).toBe(false);
  });

  it("prevents concurrent writers from overwriting registrations", () => {
    registry.add(root);
    fs.writeFileSync(`${registry.file}.lock`, "");
    expect(() => registry.add(other)).toThrow(expect.objectContaining({ code: "WORKSPACE_REGISTRY_BUSY" }));
    expect(registry.list()).toHaveLength(1);
  });

  it("does not follow a replaced canonical root or expose its local path in errors", () => {
    const entry = registry.add(root);
    cleanup(root);
    fs.symlinkSync(other, root, "junction");
    expect(() => registry.resolve(entry.alias)).toThrow(expect.objectContaining({ code: "WORKSPACE_UNAVAILABLE" }));
    expect(registry.choices()).toEqual([{ alias: entry.alias, workspaceId: entry.workspaceId }]);
  });

  it("isolates owner grants and ignores the unowned legacy registry", () => {
    const legacyFile = write(state, "workspace-registry.json", JSON.stringify({ version: 1, workspaces: [
      { workspaceId: new Workspace(other).id, alias: "legacy", root: other },
    ] }));
    const legacy = fs.readFileSync(legacyFile, "utf8");
    const anotherOwner = new WorkspaceRegistry(new Workspace(other).id);
    expect(registry.list()).toEqual([]);
    expect(anotherOwner.list()).toEqual([]);
    const a = registry.add(root, "shared");
    const b = anotherOwner.add(other, "shared");
    expect(registry.file).toBe(path.join(state, "workspace-registries", `${a.workspaceId}.json`));
    expect(registry.resolve("shared").root).toBe(root);
    expect(anotherOwner.resolve("shared").root).toBe(other);
    expect(() => registry.resolve(b.workspaceId)).toThrow(expect.objectContaining({ code: "WORKSPACE_NOT_FOUND" }));
    expect(() => anotherOwner.remove(a.workspaceId)).toThrow(expect.objectContaining({ code: "WORKSPACE_NOT_FOUND" }));
    expect(fs.readFileSync(legacyFile, "utf8")).toBe(legacy);
  });

  it("rejects invalid owner IDs and registry files belonging to another owner", () => {
    for (const owner of ["", "../escape", root, "OWNER", "0123456789ab/other"]) {
      expect(() => new WorkspaceRegistry(owner)).toThrow(expect.objectContaining({ code: "INVALID_WORKSPACE_OWNER" }));
    }
    registry.add(root);
    const anotherOwner = new WorkspaceRegistry(new Workspace(other).id);
    anotherOwner.add(other);
    fs.copyFileSync(anotherOwner.file, registry.file);
    expect(() => registry.resolve()).toThrow(expect.objectContaining({ code: "WORKSPACE_REGISTRY_INVALID" }));
    expect(() => registry.add(root)).toThrow(expect.objectContaining({ code: "WORKSPACE_REGISTRY_INVALID" }));
  });

});
