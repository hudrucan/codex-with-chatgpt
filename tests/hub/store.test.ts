import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHub, hubFile, renameHub, resolveHub as discoverHub } from "../../src/hub/store.js";
import { AuthStore as NativeAuthStore } from "../../src/auth/store.js";
import { WorkspaceRegistry } from "../../src/workspace/registry.js";
import { cleanup, isolateStateDir, makeTmpDir } from "../helpers.js";
let state: string, root: string;
beforeEach(() => { state = isolateStateDir(); root = makeTmpDir("hub-native"); });
afterEach(() => { [state, root].forEach(cleanup); delete process.env.C2C_STATE_DIR; });

describe("native Hub discovery and grants",()=>{
  it("keeps stable persisted identity through display-name changes",()=>{
    const first=createHub("Demo Hub"), renamed=renameHub(first.hubId,"Chosen Hub");
    expect(renamed).toEqual({...first,displayName:"Chosen Hub"});
    expect(discoverHub()).toEqual(renamed);
    expect(JSON.parse(fs.readFileSync(hubFile(first.hubId),"utf8"))).toEqual(renamed);
    expect(fs.readdirSync(root)).toEqual([]);
  });
  it.each(["malformed","foreign identity"])("fails closed on %s Hub state",kind=>{
    const first=createHub("Demo Hub");
    fs.writeFileSync(hubFile(first.hubId),kind==="malformed"?"{":JSON.stringify({...first,hubId:createHub("Other").hubId}));
    expect(()=>discoverHub()).toThrow(/HUB_STATE_INVALID/);
  });
  it("creates a self-sufficient Hub independently of repo identity",()=>{
    expect(()=>discoverHub()).toThrow(/HUB_NOT_CONFIGURED/);
    const hub=createHub("Demo Hub");
    expect(hub.hubId).toMatch(/^hub-[a-f0-9-]{36}$/);
    expect(discoverHub()).toEqual(hub);expect(discoverHub(hub.hubId)).toEqual(hub);
    const registry=new WorkspaceRegistry(hub.hubId);const grant=registry.add(root,"first");
    const files=["auth","endpoints","tunnels","hubs"].map(dir=>({file:path.join(state,dir,`${hub.hubId}.json`),bytes:fs.readFileSync(path.join(state,dir,`${hub.hubId}.json`))}));
    registry.remove(grant.workspaceId);cleanup(root);
    expect(discoverHub()).toEqual(hub);expect(new NativeAuthStore(hub.hubId).tokenCount()).toBe(0);
    for(const item of files)expect(fs.readFileSync(item.file)).toEqual(item.bytes);
  });
  it("requires a stable explicit selector for multiple Hubs",()=>{
    const a=createHub("Same name"),b=createHub("Same name");
    expect(()=>discoverHub()).toThrow(/HUB_SELECTION_REQUIRED/);
    expect(discoverHub(a.hubId)).toEqual(a);expect(discoverHub(b.hubId)).toEqual(b);
    for(const selector of [root,"Same name","../escape"])expect(()=>discoverHub(selector)).toThrow(/HUB_NOT_CONFIGURED/);
  });
});
