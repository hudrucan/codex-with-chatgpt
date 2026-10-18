import { spawn } from "node:child_process";
import { handoffLegacyWorkspace } from "../../src/migration/adoption.js";
import fs from "node:fs";
import path from "node:path";
import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runtimeFile, writeRuntimeState } from "../../src/bridge/runtime.js";
import { findBridgeObservation } from "../../src/migration/runtime.js";
import { ensureBridge, stopBridge } from "../../src/process/daemon.js";
import { LegacyAuthSnapshot as AuthStore, finalizeAuthHandoff } from "../../src/migration/adoption.js";
import { startBridge } from "../../src/bridge/server.js";
import { resolveHub } from "../../src/migration/store.js";
import { Workspace } from "../../src/workspace/manager.js";
import { SERVICE_NAME, VERSION } from "../../src/version.js";
import { cleanup, isolateStateDir, makeTmpDir, write, legacyAuthFixture } from "../helpers.js";

let state: string;
let root: string;
let foreignRoot: string;
let server: Server | undefined;
beforeEach(() => { state = isolateStateDir(); root = makeTmpDir("legacy-runtime"); foreignRoot = makeTmpDir("legacy-runtime-foreign"); });
afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
  [state, root, foreignRoot].forEach(cleanup);
  delete process.env.C2C_STATE_DIR;
});
async function legacyRuntime(healthOwner: string, runtimeOwner = new Workspace(root), pid = process.pid) {
  let shutdowns = 0;
  server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/health") res.end(JSON.stringify({ service: SERVICE_NAME, version: VERSION, workspaceId: healthOwner, status: "ok" }));
    else if (req.url === "/admin/shutdown" && req.headers.authorization === "Bearer legacy-admin") {
      shutdowns++; res.end(JSON.stringify({ shuttingDown: true }));
    } else { res.statusCode = 404; res.end("{}"); }
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test port");
  const runtime = { service: SERVICE_NAME, version: VERSION, workspaceId: runtimeOwner.id, workspaceRoot: runtimeOwner.root,
    pid, port: address.port, adminToken: "legacy-admin", publicUrl: null, startedAt: new Date().toISOString() };
  const file = write(state, `runtime/${new Workspace(root).id}.json`, JSON.stringify(runtime));
  return { runtime, file, shutdowns: () => shutdowns };
}

describe("live legacy runtime compatibility", () => {
  it("observes legacy health only through migration and blocks normal Hub startup", async () => {
    const workspace = new Workspace(root), hub = resolveHub(workspace);
    const legacy = await legacyRuntime(workspace.id);
    const contents = fs.readFileSync(legacy.file, "utf8");
    expect(await findBridgeObservation(hub.hubId)).toMatchObject({state:"healthy",runtime:legacy.runtime});
    await expect(ensureBridge(hub.hubId)).rejects.toThrow(/HUB_MIGRATION_REQUIRED/);
    expect(fs.existsSync(runtimeFile(hub.hubId))).toBe(false);
    expect(legacy.shutdowns()).toBe(0);
    expect(fs.readFileSync(legacy.file, "utf8")).toBe(contents);
  });

  it.each(["runtime owner", "health owner"])("never reuses or stops a live legacy bridge with a foreign %s", async (kind) => {
    const workspace = new Workspace(root), foreign = new Workspace(foreignRoot), hub = resolveHub(workspace);
    const legacy = await legacyRuntime(kind === "health owner" ? foreign.id : workspace.id, kind === "runtime owner" ? foreign : workspace);
    const contents = fs.readFileSync(legacy.file, "utf8");
    expect((await findBridgeObservation(hub.hubId)).state).toBe("unknown");
    await expect(ensureBridge(hub.hubId)).rejects.toThrow(/HUB_MIGRATION_REQUIRED/);
    await expect(stopBridge(hub.hubId)).rejects.toThrow(/HUB_MIGRATION_REQUIRED/);
    expect(legacy.shutdowns()).toBe(0);
    expect(fs.existsSync(runtimeFile(hub.hubId))).toBe(false);
    expect(fs.readFileSync(legacy.file, "utf8")).toBe(contents);
  });

  it.each(["legacy", "Hub"])("refuses finalization and Hub startup while a %s auth writer is active", async (kind) => {
    const workspace = new Workspace(root), hub = resolveHub(workspace);
    const auth = legacyAuthFixture(state, workspace.id);
    new AuthStore(hub.hubId);
    const before = fs.readFileSync(path.join(state, "auth", `${hub.hubId}.json`), "utf8");
    const legacy = await legacyRuntime(workspace.id);
    if (kind === "Hub") writeRuntimeState({ ...legacy.runtime, hubId: hub.hubId, stateVersion: 1 });
    expect(() => finalizeAuthHandoff(hub.hubId, workspace)).toThrow(/AUTH_HANDOFF_BUSY/);
    await expect(startBridge({ hubId: hub.hubId, port: 0, persistRuntime: false })).rejects.toThrow(/HUB_MIGRATION_REQUIRED/);
    expect(fs.readFileSync(path.join(state, "auth", `${hub.hubId}.json`), "utf8")).toBe(before);
    expect(fs.readFileSync(auth.file, "utf8")).toBe(auth.contents);
    expect(legacy.shutdowns()).toBe(0);
  });

  it("does not let a dead legacy PID block the Hub even if its old port serves another owner", async () => {
    const workspace = new Workspace(root), hub = resolveHub(workspace);
    await legacyRuntime(new Workspace(foreignRoot).id, workspace, 999_999_999);
    expect(await findBridgeObservation(hub.hubId)).toMatchObject({ state: "stopped", reason: "pid_missing" });
  });
});


it("hands off a verified live legacy writer through shutdown only and retains its exact runtime proof",async()=>{
  const owner=new Workspace(root),auth=legacyAuthFixture(state,owner.id);
  const runtimeFile=path.join(state,"runtime",`${owner.id}.json`),calls=path.join(state,"requests.jsonl");
  fs.mkdirSync(path.dirname(runtimeFile),{recursive:true});
  const script=`const fs=require("node:fs"),http=require("node:http");
const [file,owner,root,calls]=process.argv.slice(1);
const server=http.createServer((req,res)=>{
 fs.appendFileSync(calls,JSON.stringify({method:req.method,path:req.url})+"\\n");res.setHeader("content-type","application/json");
 if(req.url==="/health")res.end(JSON.stringify({service:"c2c-bridge",version:"0",workspaceId:owner,status:"ok"}));
 else if(req.url==="/admin/shutdown"&&req.headers.authorization==="Bearer legacy-admin"){
  res.end(JSON.stringify({shuttingDown:true}));setTimeout(()=>{fs.unlinkSync(file);server.close(()=>process.exit(0));},50);
 }else{res.statusCode=404;res.end("{}");}
});
server.listen(0,"127.0.0.1",()=>fs.writeFileSync(file,JSON.stringify({service:"c2c-bridge",version:"0",workspaceId:owner,workspaceRoot:root,pid:process.pid,port:server.address().port,adminToken:"legacy-admin",publicUrl:null,startedAt:new Date().toISOString()})));`;
  const child=spawn(process.execPath,["-e",script,runtimeFile,owner.id,root,calls],{stdio:"ignore"});
  try{
    for(let n=0;n<100&&!fs.existsSync(runtimeFile);n++)await new Promise(r=>setTimeout(r,20));
    const before=fs.readFileSync(runtimeFile,"utf8");
    const hubId=await handoffLegacyWorkspace(root);
    expect(fs.readFileSync(runtimeFile,"utf8")).toBe(before);
    expect(fs.readFileSync(auth.file,"utf8")).toBe(auth.contents);
    expect(JSON.parse(fs.readFileSync(path.join(state,"hub-mappings",`${owner.id}.json`),"utf8"))).toMatchObject({authHandoffFinalized:true});
    expect(fs.existsSync(path.join(state,"runtime",`${hubId}.json`))).toBe(false);
    const requests=fs.readFileSync(calls,"utf8").trim().split("\n").map(line=>JSON.parse(line));
    expect(requests.some(req=>req.method==="POST"&&req.path==="/admin/shutdown")).toBe(true);
    expect(requests.every(req=>req.path==="/health"||req.path==="/admin/shutdown")).toBe(true);
  }finally{if(child.exitCode===null){child.kill("SIGTERM");await new Promise(resolve=>child.once("exit",resolve));}}
});
