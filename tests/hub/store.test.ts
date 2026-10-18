import { readTunnelState as nativeTunnel } from "../../src/tunnel/state.js";
import { readLastEndpoint as nativeEndpoint } from "../../src/config/endpoint.js";
import { createHub, resolveHub as discoverHub, readConfiguredHub as readNativeHub } from "../../src/hub/store.js";
import { AuthStore as NativeAuthStore } from "../../src/auth/store.js";
import { adoptLegacyWorkspace, finalizeAuthHandoff } from "../../src/migration/adoption.js";
import { detachHub, legacyCleanup } from "../../src/migration/finalize.js";
import { WorkspaceRegistry } from "../../src/workspace/registry.js";
import { legacyAuthFixture } from "../helpers.js";
import { adoptLegacyTunnel as readTunnelState, adoptLegacyEndpoint as readLastEndpoint } from "../../src/migration/adoption.js";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hubFile, hubMappingFile, resolveHub } from "../../src/migration/store.js";
import { tunnelStateFile } from "../../src/tunnel/state.js";
import { endpointFile } from "../../src/config/endpoint.js";
import { ProcessCloudflaredAccount } from "../../src/tunnel/named-provision.js";
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
    expect(first).toEqual({ version: 1, hubId: expect.stringMatching(/^hub-[a-f0-9-]{36}$/),
      displayName: workspace.name, createdAt: expect.any(String), legacyOwnerWorkspaceId: workspace.id });
    expect(new Date(first.createdAt).toISOString()).toBe(first.createdAt);
    expect(first.hubId).not.toContain(workspace.id);
    expect(resolveHub({ id: workspace.id, name: "Changed display name" })).toEqual(first);
    const foreign = resolveHub({ id: new Workspace(other).id, name: first.displayName });
    expect(foreign.hubId).not.toBe(first.hubId);
    expect(foreign.displayName).toBe(first.displayName);
    const link = path.join(state, "workspace-link");
    fs.symlinkSync(root, link, "junction");
    expect(resolveHub(new Workspace(link))).toEqual(first);
    expect(mapping(workspace.id)).toEqual({ version: 1, legacyOwnerWorkspaceId: workspace.id, hubId: first.hubId, registryInitialized: false });
    expect(fs.readdirSync(root)).toEqual([]);
    if (process.platform !== "win32") {
      for (const file of [hubFile(first.hubId), hubMappingFile(workspace.id)]) expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    }
  });

  it("accepts independent Hub records without a legacy owner but does not auto-adopt them", () => {
    const id = `hub-${randomUUID()}`;
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

  it.each(["malformed mapping", "malformed Hub", "old prefix", "wrong filename", "missing hub", "wrong owner", "duplicate claim", "duplicate mapping"])(
    "fails closed on %s state without creating another Hub",
    (kind) => {
      const workspace = new Workspace(root);
      const hub = resolveHub(workspace);
      const foreign = new Workspace(other);
      if (kind === "malformed mapping") fs.writeFileSync(hubMappingFile(workspace.id), "{");
      if (kind === "malformed Hub") fs.writeFileSync(hubFile(hub.hubId), "{");
      if (kind === "old prefix") fs.writeFileSync(hubFile(hub.hubId), JSON.stringify({ ...hub, hubId: hub.hubId.replace("hub-", "hub_") }));
      if (kind === "wrong filename") write(state, `hubs/hub-invalid.json`, JSON.stringify(hub));
      if (kind === "missing hub") fs.unlinkSync(hubFile(hub.hubId));
      if (kind === "wrong owner") fs.writeFileSync(hubFile(hub.hubId), JSON.stringify({ ...hub, legacyOwnerWorkspaceId: foreign.id }));
      if (kind === "duplicate claim") {
        const id = `hub-${randomUUID()}`;
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

  it("rejects unsafe owner path inputs without creating ownership state", () => {
    expect(() => resolveHub({ id: "../escape", name: "Invalid" })).toThrow(/HUB_MAPPING_INVALID/);
    expect(fs.readdirSync(state)).toEqual([]);
  });

  it("fails closed while another mapping writer holds the lock", () => {
    write(state, "hub-mappings/.lock", "");
    expect(() => resolveHub(new Workspace(root))).toThrow(/HUB_STATE_BUSY/);
    expect(fs.existsSync(path.join(state, "hubs"))).toBe(false);
  });
});

function resourceFixture(resource: "tunnel" | "endpoint", owner: Workspace) {
  const fields = resource === "tunnel" ? {
    preference: "named", provider: "cloudflare-named", askedAt: "2026-10-01T00:00:00.000Z",
    tunnelName: `existing-${owner.id}`, tunnelId: "11111111-1111-4111-8111-111111111111",
    hostname: `${owner.id}.example.com`, zone: "example.com", configuredAt: "2026-10-01T00:00:00.000Z",
    fallbackReason: "previous-fallback", pending: { tunnelId: "22222222-2222-4222-8222-222222222222",
      tunnelName: "pending", hostname: "pending.example.com", zone: "example.com", created: true },
  } : {
    port: 1234, publicUrl: `https://${owner.id}.example.com`, mcpUrl: `https://${owner.id}.example.com/mcp`,
    desiredConnectorName: "Desired name", connectorName: "Verified name", connectorId: `plugin_${owner.id}`,
    boundMcpUrl: "https://bound.example.com/mcp", bindingVersion: 1, disconnected: true, savedAt: "2026-10-01T00:00:00.000Z",
  };
  const contents = JSON.stringify({ workspaceId: owner.id, ...fields });
  const source = write(state, `${resource}s/${owner.id}.json`, contents);
  return { fields, source, contents,
    file: (id: string) => resource === "tunnel" ? tunnelStateFile(id) : endpointFile(id),
    read: (id: string) => resource === "tunnel" ? readTunnelState(id) : readLastEndpoint(id),
  };
}

describe.each(["tunnel", "endpoint"] as const)("Hub-owned %s adoption", (resource) => {
  it("preserves the complete legacy binding and journal without remote mutations", () => {
    const owner = new Workspace(root), hub = resolveHub(owner);
    const legacy = resourceFixture(resource, owner);
    const mutations = ["login", "createTunnel", "routeDns", "deleteDns", "renameTunnel", "deleteTunnel"] as const;
    const spies = mutations.map((name) => vi.spyOn(ProcessCloudflaredAccount.prototype, name).mockRejectedValue(new Error("Unexpected remote mutation")));
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected remote request"));
    expect(legacy.read(hub.hubId)).toEqual({ version: 1, hubId: hub.hubId, ...legacy.fields });
    expect(mapping(owner.id)[`${resource}Initialized`]).toBe(true);
    expect(fs.readFileSync(legacy.source, "utf8")).toBe(legacy.contents);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("retries a copied state after checkpoint failure and never reimports stale legacy state", () => {
    const owner = new Workspace(root), hub = resolveHub(owner);
    const legacy = resourceFixture(resource, owner);
    const original = fs.renameSync;
    const rename = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (String(to) === hubMappingFile(owner.id)) throw new Error("checkpoint interrupted");
      return original(from, to);
    });
    expect(() => legacy.read(hub.hubId)).toThrow(/checkpoint interrupted/);
    expect(mapping(owner.id)[`${resource}Initialized`]).not.toBe(true);
    expect(fs.existsSync(legacy.file(hub.hubId))).toBe(true);
    rename.mockRestore();
    const adopted = legacy.read(hub.hubId);
    expect(adopted).toEqual({ version: 1, hubId: hub.hubId, ...legacy.fields });
    expect(mapping(owner.id)[`${resource}Initialized`]).toBe(true);
    fs.writeFileSync(legacy.source, "{stale legacy state");
    expect(legacy.read(hub.hubId)).toEqual(adopted);
    fs.unlinkSync(legacy.file(hub.hubId));
    expect(() => legacy.read(hub.hubId)).toThrow(/STATE_CONFLICT/);
    expect(fs.existsSync(legacy.file(hub.hubId))).toBe(false);
  });

  it("refuses conflicting pending state without merging or changing either file", () => {
    const owner = new Workspace(root), hub = resolveHub(owner);
    const legacy = resourceFixture(resource, owner);
    const fields = resource === "tunnel" ? { ...legacy.fields, tunnelName: "different-tunnel" } : { ...legacy.fields, connectorId: "different_connector" };
    const contents = JSON.stringify({ version: 1, hubId: hub.hubId, ...fields });
    write(state, `${resource}s/${hub.hubId}.json`, contents);
    expect(() => legacy.read(hub.hubId)).toThrow(/STATE_CONFLICT/);
    expect(fs.readFileSync(legacy.file(hub.hubId), "utf8")).toBe(contents);
    expect(fs.readFileSync(legacy.source, "utf8")).toBe(legacy.contents);
    expect(mapping(owner.id)[`${resource}Initialized`]).not.toBe(true);
  });

  it("keeps two owners isolated and rejects a Hub file copied from another owner", () => {
    const a = new Workspace(root), b = new Workspace(other);
    const hubA = resolveHub(a), hubB = resolveHub(b);
    const legacyA = resourceFixture(resource, a), legacyB = resourceFixture(resource, b);
    expect(legacyA.read(hubA.hubId)).toEqual({ version: 1, hubId: hubA.hubId, ...legacyA.fields });
    const savedB = legacyB.read(hubB.hubId);
    expect(savedB).toEqual({ version: 1, hubId: hubB.hubId, ...legacyB.fields });
    fs.copyFileSync(legacyB.file(hubB.hubId), legacyA.file(hubA.hubId));
    const before = fs.readFileSync(legacyA.file(hubA.hubId), "utf8");
    expect(() => legacyA.read(hubA.hubId)).toThrow(/STATE_CONFLICT/);
    expect(fs.readFileSync(legacyA.file(hubA.hubId), "utf8")).toBe(before);
    expect(legacyB.read(hubB.hubId)).toEqual(savedB);
  });

  it.each(["foreign owner", "malformed"])("rejects %s legacy state before creating Hub state", (kind) => {
    const owner = new Workspace(root), hub = resolveHub(owner);
    const legacy = resourceFixture(resource, owner);
    const contents = kind === "malformed" ? "{" : JSON.stringify({ ...legacy.fields, workspaceId: new Workspace(other).id });
    fs.writeFileSync(legacy.source, contents);
    expect(() => legacy.read(hub.hubId)).toThrow(/STATE_CONFLICT/);
    expect(fs.existsSync(legacy.file(hub.hubId))).toBe(false);
    expect(fs.readFileSync(legacy.source, "utf8")).toBe(contents);
  });
});


describe("native Hub discovery and grants",()=>{
  it("creates a self-sufficient Hub without repo identity or a legacy mapping",()=>{
    expect(()=>discoverHub()).toThrow(/HUB_NOT_CONFIGURED/);
    const hub=createHub("Desk");
    expect(hub.legacyOwnerWorkspaceId).toBeUndefined();expect(hub.hubId).toMatch(/^hub-[a-f0-9-]{36}$/);
    expect(discoverHub()).toEqual(hub);expect(discoverHub(hub.hubId)).toEqual(hub);
    expect(fs.existsSync(path.join(state,"hub-mappings"))).toBe(false);
    const registry=new WorkspaceRegistry(hub.hubId);const grant=registry.add(root,"first");
    const files=["auth","endpoints","tunnels","hubs"].map(dir=>({file:path.join(state,dir,`${hub.hubId}.json`),bytes:fs.readFileSync(path.join(state,dir,`${hub.hubId}.json`))}));
    registry.remove(grant.workspaceId);cleanup(root);
    expect(discoverHub()).toEqual(hub);expect(new NativeAuthStore(hub.hubId).tokenCount()).toBe(0);
    for(const item of files)expect(fs.readFileSync(item.file)).toEqual(item.bytes);
  });
  it("requires a stable explicit selector for multiple Hubs and ignores stale mappings",()=>{
    const a=createHub("Same name"),b=createHub("Same name");
    write(state,"hub-mappings/unrelated.json","{stale");
    expect(()=>discoverHub()).toThrow(/HUB_SELECTION_REQUIRED/);
    expect(discoverHub(a.hubId)).toEqual(a);expect(discoverHub(b.hubId)).toEqual(b);
    for(const selector of [root,"Same name","../escape"])expect(()=>discoverHub(selector)).toThrow(/HUB_NOT_CONFIGURED/);
  });
});

function readyLegacy(){
  const owner=new Workspace(root);legacyAuthFixture(state,owner.id,root);
  write(state,`workspace-registries/${owner.id}.json`,JSON.stringify({version:1,ownerWorkspaceId:owner.id,workspaces:[{workspaceId:owner.id,alias:"first",root}]}));
  write(state,`tunnels/${owner.id}.json`,JSON.stringify({workspaceId:owner.id,preference:"named",tunnelId:"11111111-1111-4111-8111-111111111111",tunnelName:"existing",hostname:"code.example.com",zone:"example.com"}));
  write(state,`endpoints/${owner.id}.json`,JSON.stringify({workspaceId:owner.id,port:1234,publicUrl:"https://code.example.com",mcpUrl:"https://code.example.com/mcp",connectorId:"plugin_owned",connectorName:"Existing",desiredConnectorName:"Existing",boundMcpUrl:"https://code.example.com/mcp",bindingVersion:1,savedAt:new Date().toISOString()}));
  const result=adoptLegacyWorkspace(root);finalizeAuthHandoff(result.hub.hubId,owner);return {...result,owner};
}
describe("explicit detach and verified local cleanup",()=>{
  it("detaches a fully migrated Hub, preserves credentials and then ignores every stale legacy source",async()=>{
    const {hub,owner,registry}=readyLegacy();
    const auth=fs.readFileSync(path.join(state,"auth",`${hub.hubId}.json`));
    expect(()=>discoverHub()).toThrow(/HUB_MIGRATION_REQUIRED/);
    expect((await detachHub(hub.hubId)).eligible).toBe(true);
    expect(readNativeHub(hub.hubId).legacyOwnerWorkspaceId).toBe(owner.id);
    expect((await detachHub(hub.hubId,true)).detached).toBe(true);
    for(const dir of ["auth","endpoints","tunnels","runtime","workspace-registries"])write(state,`${dir}/${owner.id}.json`,"{obsolete");
    fs.writeFileSync(hubMappingFile(owner.id),"{obsolete mapping");
    registry.remove(owner.id);cleanup(root);
    expect(discoverHub().hubId).toBe(hub.hubId);
    expect(new NativeAuthStore(hub.hubId).tokenCount()).toBe(2);
    expect(fs.readFileSync(path.join(state,"auth",`${hub.hubId}.json`))).toEqual(auth);
    expect(nativeTunnel(hub.hubId).tunnelName).toBe("existing");
    expect(nativeEndpoint(hub.hubId)?.connectorId).toBe("plugin_owned");
    expect(registry.choices()).toEqual([]);
  });
  it.each(["checkpoint","live legacy runtime","pending tunnel","missing auth","uncertain Hub runtime","state symlink"])("refuses detach for %s without advancing ownership",async(kind)=>{
    const {hub,owner}=readyLegacy(),before=fs.readFileSync(hubFile(hub.hubId));
    if(kind==="checkpoint")fs.writeFileSync(hubMappingFile(owner.id),JSON.stringify({...mapping(owner.id),authHandoffFinalized:false}));
    if(kind==="live legacy runtime"){const file=path.join(state,"runtime",`${owner.id}.json`);fs.writeFileSync(file,JSON.stringify({...JSON.parse(fs.readFileSync(file,"utf8")),pid:process.pid}));}
    if(kind==="pending tunnel"){const file=path.join(state,"tunnels",`${hub.hubId}.json`);fs.writeFileSync(file,JSON.stringify({...JSON.parse(fs.readFileSync(file,"utf8")),pending:{tunnelName:"pending",hostname:"code.example.com",zone:"example.com",created:false}}));}
    if(kind==="missing auth")fs.unlinkSync(path.join(state,"auth",`${hub.hubId}.json`));
    if(kind==="state symlink"){const file=path.join(state,"auth",`${hub.hubId}.json`);fs.unlinkSync(file);fs.symlinkSync(path.join(state,"auth",`${owner.id}.json`),file);}
    if(kind==="uncertain Hub runtime")write(state,`runtime/${hub.hubId}.json`,JSON.stringify({stateVersion:1,hubId:hub.hubId,service:"c2c-bridge",version:"0",pid:process.pid,port:1,adminToken:"test",publicUrl:null,startedAt:new Date().toISOString()}));
    await expect(detachHub(hub.hubId,true)).rejects.toThrow();
    expect(fs.readFileSync(hubFile(hub.hubId))).toEqual(before);
  });
  it("retries a detach interrupted before its final archive checkpoint",async()=>{
    const {hub}=readyLegacy(),original=fs.renameSync;let count=0;
    const rename=vi.spyOn(fs,"renameSync").mockImplementation((from,to)=>{if(String(to)===path.join(state,"migrations",`${hub.hubId}.json`)&&++count===2)throw new Error("checkpoint interrupted");return original(from,to);});
    await expect(detachHub(hub.hubId,true)).rejects.toThrow(/checkpoint interrupted/);rename.mockRestore();
    expect((await detachHub(hub.hubId,true)).detached).toBe(true);
  });
  it("plans cleanup before detach and deletes only validated legacy-owner files after detach",async()=>{
    const {hub,owner}=readyLegacy(),other=createHub("Other");
    const unowned=write(state,"workspace-registry.json","unowned retained"),backup=write(state,"migration-gates/backups/legacy.json","backup retained");
    const foreign=write(state,`auth/${new Workspace(otherRoot()).id}.json`,"foreign retained");
    const plan=await legacyCleanup(hub.hubId);expect(plan.eligible).toBe(false);expect(plan.requiresDetach).toBe(true);
    await expect(legacyCleanup(hub.hubId,true)).rejects.toThrow(/HUB_MIGRATION_REQUIRED/);
    await detachHub(hub.hubId,true);const before=fs.readFileSync(path.join(state,"auth",`${hub.hubId}.json`));
    const ready=await legacyCleanup(hub.hubId);expect(ready.files.map(f=>path.basename(f.file))).toEqual(expect.arrayContaining([`${owner.id}.json`]));
    expect((await legacyCleanup(hub.hubId,true)).cleaned).toBe(true);
    for(const item of ready.files)expect(fs.existsSync(item.file)).toBe(false);
    expect(fs.readFileSync(path.join(state,"auth",`${hub.hubId}.json`))).toEqual(before);
    for(const file of [hubFile(other.hubId),unowned,backup,foreign])expect(fs.existsSync(file)).toBe(true);
  });
  it.each(["foreign owner","foreign resource","symlink"])("rejects %s legacy cleanup before deleting any file",async(kind)=>{
    const {hub,owner}=readyLegacy();await detachHub(hub.hubId,true);
    const file=path.join(state,"tunnels",`${owner.id}.json`);
    if(kind==="foreign owner")fs.writeFileSync(file,JSON.stringify({...JSON.parse(fs.readFileSync(file,"utf8")),workspaceId:"abcdef123456"}));
    else if(kind==="foreign resource")fs.writeFileSync(file,JSON.stringify({...JSON.parse(fs.readFileSync(file,"utf8")),tunnelId:"foreign-uuid"}));
    else{fs.unlinkSync(file);fs.symlinkSync(path.join(state,"tunnels",`${hub.hubId}.json`),file);}
    await expect(legacyCleanup(hub.hubId,true)).rejects.toThrow();expect(fs.existsSync(path.join(state,"auth",`${owner.id}.json`))).toBe(true);
  });
});
function otherRoot(){return other;}
