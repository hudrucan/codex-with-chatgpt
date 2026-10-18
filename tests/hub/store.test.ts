import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hubFile, hubMappingFile, resolveHub } from "../../src/hub/store.js";
import { Workspace } from "../../src/workspace/manager.js";
import { cleanup, isolateStateDir, makeTmpDir, write } from "../helpers.js";

let state: string;
let root: string;
let other: string;
beforeEach(() => { state = isolateStateDir(); root = makeTmpDir("hub"); other = makeTmpDir("hub-other"); });
afterEach(() => { vi.restoreAllMocks(); [state, root, other].forEach(cleanup); delete process.env.C2C_STATE_DIR; });

function mapping(owner: string) { return JSON.parse(fs.readFileSync(hubMappingFile(owner), "utf8")); }

describe("persistent Hub identity", () => {
  it("creates an opaque stable identity and deterministic owner mapping outside the repo", () => {
    const workspace = new Workspace(root);
    const first = resolveHub(workspace);
    expect(first).toEqual({ version: 1, hubId: expect.stringMatching(/^hub_[a-f0-9-]{36}$/),
      displayName: workspace.name, createdAt: expect.any(String), legacyOwnerWorkspaceId: workspace.id });
    expect(new Date(first.createdAt).toISOString()).toBe(first.createdAt);
    expect(first.hubId).not.toContain(workspace.id);
    expect(resolveHub({ id: workspace.id, name: "Changed display name" })).toEqual(first);
    const link = path.join(state, "workspace-link");
    fs.symlinkSync(root, link, "junction");
    expect(resolveHub(new Workspace(link))).toEqual(first);
    expect(mapping(workspace.id)).toEqual({ version: 1, legacyOwnerWorkspaceId: workspace.id, hubId: first.hubId, registryInitialized: false });
    expect(fs.readdirSync(root)).toEqual([]);
    if (process.platform !== "win32") {
      for (const file of [hubFile(first.hubId), hubMappingFile(workspace.id)]) expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    }
  });

  it("keeps two owners distinct even when their display names match", () => {
    const a = resolveHub({ id: new Workspace(root).id, name: "Shared name" });
    const b = resolveHub({ id: new Workspace(other).id, name: "Shared name" });
    expect(a.hubId).not.toBe(b.hubId);
    expect(a.displayName).toBe(b.displayName);
  });

  it("accepts independent Hub records without a legacy owner but does not auto-adopt them", () => {
    const id = `hub_${randomUUID()}`;
    write(state, `hubs/${id}.json`, JSON.stringify({ version: 1, hubId: id, displayName: "Independent", createdAt: new Date().toISOString() }));
    expect(resolveHub(new Workspace(root)).hubId).not.toBe(id);
  });

  it("recovers a sole Hub claim after a failed mapping write without creating another identity", () => {
    const workspace = new Workspace(root);
    const original = fs.renameSync;
    const rename = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (String(to) === hubMappingFile(workspace.id)) throw new Error("mapping write failed");
      return original(from, to);
    });
    expect(() => resolveHub(workspace)).toThrow(/mapping write failed/);
    const hubNames = fs.readdirSync(path.join(state, "hubs"));
    expect(hubNames).toHaveLength(1);
    rename.mockRestore();
    const hub = resolveHub(workspace);
    expect(`${hub.hubId}.json`).toBe(hubNames[0]);
    expect(fs.readdirSync(path.join(state, "hubs"))).toEqual(hubNames);
  });

  it.each(["malformed", "wrong filename", "missing hub", "wrong owner", "duplicate claim", "duplicate mapping"])(
    "fails closed on %s state without creating another Hub",
    (kind) => {
      const workspace = new Workspace(root);
      const hub = resolveHub(workspace);
      const foreign = new Workspace(other);
      if (kind === "malformed") fs.writeFileSync(hubMappingFile(workspace.id), "{");
      if (kind === "wrong filename") write(state, `hubs/hub_invalid.json`, JSON.stringify(hub));
      if (kind === "missing hub") fs.unlinkSync(hubFile(hub.hubId));
      if (kind === "wrong owner") fs.writeFileSync(hubFile(hub.hubId), JSON.stringify({ ...hub, legacyOwnerWorkspaceId: foreign.id }));
      if (kind === "duplicate claim") {
        const id = `hub_${randomUUID()}`;
        write(state, `hubs/${id}.json`, JSON.stringify({ ...hub, hubId: id }));
      }
      if (kind === "duplicate mapping") write(state, `hub-mappings/${foreign.id}.json`, JSON.stringify({ ...mapping(workspace.id), legacyOwnerWorkspaceId: foreign.id }));
      const filesBefore = fs.readdirSync(path.join(state, "hubs"));
      const bytesBefore = fs.readFileSync(hubMappingFile(workspace.id), "utf8");
      expect(() => resolveHub(workspace)).toThrow(/HUB_(?:STATE_INVALID|MAPPING_CONFLICT)/);
      expect(fs.readdirSync(path.join(state, "hubs"))).toEqual(filesBefore);
      expect(fs.readFileSync(hubMappingFile(workspace.id), "utf8")).toBe(bytesBefore);
    }
  );

  it("rejects malformed Hub fields and owner path inputs", () => {
    const workspace = new Workspace(root);
    const hub = resolveHub(workspace);
    for (const patch of [{ displayName: "" }, { displayName: "unsafe\nname" }, { createdAt: "yesterday" }, { version: 2 }]) {
      fs.writeFileSync(hubFile(hub.hubId), JSON.stringify({ ...hub, ...patch }));
      expect(() => resolveHub(workspace)).toThrow(/HUB_STATE_INVALID/);
    }
    expect(() => resolveHub({ id: "../escape", name: "Invalid" })).toThrow(/HUB_MAPPING_INVALID/);
    expect(() => hubFile("../escape")).toThrow(/HUB_STATE_INVALID/);
  });

  it("fails closed while another mapping writer holds the lock", () => {
    write(state, "hub-mappings/.lock", "");
    expect(() => resolveHub(new Workspace(root))).toThrow(/HUB_STATE_BUSY/);
    expect(fs.existsSync(path.join(state, "hubs"))).toBe(false);
  });
});
