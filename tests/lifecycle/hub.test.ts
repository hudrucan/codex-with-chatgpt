import fs from "node:fs";
import path from "node:path";
import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import {createHub,hubFile,resolveHub} from "../../src/hub/store.js";
import {AuthStore} from "../../src/auth/store.js";
import {acquireHubLock,destroyHub,disconnectHub,lifecycleFile} from "../../src/lifecycle/hub.js";
import {boundConnector,confirmConnectorBinding,connectorReconciliation,persistHubEndpoint,readLastEndpoint,writeLastEndpoint} from "../../src/config/endpoint.js";
import {readTunnelState,writeTunnelState} from "../../src/tunnel/state.js";
import {WorkspaceRegistry} from "../../src/workspace/registry.js";
import {bindProject,projectInstructions} from "../../src/project/bindings.js";
import {CloudflareApi} from "../../src/tunnel/cloudflare-api.js";
import {verifyForkOrigin} from "../../src/config/update.js";
import {cleanup,isolateStateDir,makeTmpDir,write} from "../helpers.js";
const originalApiToken=process.env.CLOUDFLARE_API_TOKEN;
let state:string,root:string,hub:ReturnType<typeof createHub>;
beforeEach(()=>{state=isolateStateDir();root=makeTmpDir("hub-lifecycle");hub=createHub("Desk");new WorkspaceRegistry(hub.hubId).add(root);});
afterEach(()=>{vi.restoreAllMocks();[root,state].forEach(cleanup);delete process.env.C2C_STATE_DIR;if(originalApiToken===undefined)delete process.env.CLOUDFLARE_API_TOKEN;else process.env.CLOUDFLARE_API_TOKEN=originalApiToken;});
function endpoint(name="Original") {return persistHubEndpoint({hubId:hub.hubId,hubName:hub.displayName,connectorName:name,port:1234,publicUrl:"https://code.example.com",mcpUrl:"https://code.example.com/mcp"});}
function bind(name="Original"){return confirmConnectorBinding(hub.hubId,{name,mcpUrl:"https://code.example.com/mcp",connectorId:"plugin_owned"});}
function resources(){
 const saved=writeTunnelState({hubId:hub.hubId,preference:"named",tunnelId:"id-owned",tunnelName:"owned",hostname:"code.example.com",zone:"example.com"});
 const account={hasCert:()=>true,login:vi.fn(),createTunnel:vi.fn(),routeDns:vi.fn(),renameTunnel:vi.fn(),
  listTunnels:vi.fn(async()=>[{id:"id-owned",name:"owned"}]),dns:vi.fn(async()=>({id:"record-owned",name:"code.example.com",type:"CNAME",content:"id-owned.cfargotunnel.com"})),
  deleteDns:vi.fn(async()=>undefined),deleteTunnel:vi.fn(async()=>undefined)};
 return {saved,account};
}
describe("transactional connector reconciliation",()=>{
 it("retains the verified binding through desired-name changes until exact acknowledgement",()=>{
  endpoint();expect(boundConnector(readLastEndpoint(hub.hubId))).toBeNull();bind();endpoint("Chosen");
  expect(connectorReconciliation(readLastEndpoint(hub.hubId))).toMatchObject({needed:true,connectorAction:"update",previousConnectorName:"Original",connectorName:"Chosen"});
  const saved=readLastEndpoint(hub.hubId);
  for(const change of [{name:"Original",mcpUrl:"https://code.example.com/mcp"},{name:"Chosen",mcpUrl:"https://foreign.example.com/mcp"}])expect(()=>confirmConnectorBinding(hub.hubId,{...change,connectorId:"foreign"})).toThrow(/CONFLICT/);
  expect(readLastEndpoint(hub.hubId)).toEqual(saved);bind("Chosen");expect(connectorReconciliation(readLastEndpoint(hub.hubId)).needed).toBe(false);
 });
});
describe("Hub lifecycle",()=>{
 function projectBinding(id=hub.hubId,url="https://chatgpt.com/g/g-p-6ad414a9a390819194cd6a676854de21-desk-home/project"){
  const workspaceId=new WorkspaceRegistry(id).list()[0].workspaceId;
  return bindProject(id,url,projectInstructions(id,url,workspaceId).instructionHash,workspaceId);
 }
 it.each(["file","directory"])("retains a recovery receipt on Project %s cleanup failure, then removes only this Hub's acknowledgements",async(stage)=>{
  endpoint();bind();const {account}=resources(),binding=projectBinding(),other=createHub("Other");
  new WorkspaceRegistry(other.hubId).add(root);
  persistHubEndpoint({hubId:other.hubId,hubName:"Other",port:1,publicUrl:"https://other.example.com",mcpUrl:"https://other.example.com/mcp"});
  const name=readLastEndpoint(other.hubId)!.desiredConnectorName!;
  confirmConnectorBinding(other.hubId,{name,mcpUrl:"https://other.example.com/mcp",connectorId:"other_connector"});
  const foreign=projectBinding(other.hubId,"https://chatgpt.com/g/g-p-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-other/project");
  const directory=path.join(state,"project-bindings",hub.hubId),file=path.join(directory,`${binding.projectId}.json`);
  const otherFile=path.join(state,"project-bindings",other.hubId,`${foreign.projectId}.json`),retained=fs.readFileSync(otherFile);
  const unlink=fs.unlinkSync,rmdir=fs.rmdirSync;
  const failure=stage==="file"?vi.spyOn(fs,"unlinkSync").mockImplementation(p=>{if(String(p)===file)throw new Error("Project cleanup interrupted");return unlink(p);}):
   vi.spyOn(fs,"rmdirSync").mockImplementation((p,opts)=>{if(String(p)===directory)throw new Error("Project cleanup interrupted");return rmdir(p,opts);});
  await expect(destroyHub(hub.hubId,{account,confirm:true,connectorRemoved:"plugin_owned"})).rejects.toThrow("Project cleanup interrupted");
  expect(JSON.parse(fs.readFileSync(lifecycleFile(hub.hubId),"utf8"))).toMatchObject({localCleanup:true,tunnelRemoved:true});
  expect(fs.existsSync(hubFile(hub.hubId))).toBe(true);expect(fs.readFileSync(otherFile)).toEqual(retained);
  failure.mockRestore();expect((await destroyHub(hub.hubId,{account,confirm:true})).destroyed).toBe(true);
  expect(fs.existsSync(directory)).toBe(false);expect(fs.readFileSync(otherFile)).toEqual(retained);
  expect(account.deleteDns).toHaveBeenCalledTimes(1);expect(account.deleteTunnel).toHaveBeenCalledTimes(1);
 });
 it.each(["malformed","foreign owner","wrong filename","directory symlink","file symlink","unexpected file"])("blocks destroy before remote deletion for %s Project state",async(kind)=>{
  endpoint();bind();const {account}=resources(),binding=projectBinding();
  const directory=path.join(state,"project-bindings",hub.hubId),file=path.join(directory,`${binding.projectId}.json`);
  if(kind==="malformed")fs.writeFileSync(file,"{");
  if(kind==="foreign owner")fs.writeFileSync(file,JSON.stringify({...binding,hubId:createHub("Foreign").hubId}));
  if(kind==="wrong filename")fs.renameSync(file,path.join(directory,"g-p-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.json"));
  if(kind==="directory symlink"){fs.rmSync(directory,{recursive:true});fs.symlinkSync(root,directory,"dir");}
  if(kind==="file symlink"){fs.unlinkSync(file);fs.symlinkSync(write(state,"retained-binding.json",JSON.stringify(binding)),file);}
  if(kind==="unexpected file")fs.writeFileSync(path.join(directory,"notes.txt"),"retain");
  await expect(destroyHub(hub.hubId,{account,confirm:true,connectorRemoved:"plugin_owned"})).rejects.toThrow(/PROJECT_BINDING_INVALID|STATE_PATH_INVALID/);
  expect(account.deleteDns).not.toHaveBeenCalled();expect(account.deleteTunnel).not.toHaveBeenCalled();
  expect(fs.existsSync(hubFile(hub.hubId))).toBe(true);expect(fs.existsSync(lifecycleFile(hub.hubId))).toBe(false);
 });
 it("disconnects without the original repo, revoking only Hub auth and retaining grants/resources",async()=>{
  endpoint();bind();const {saved}=resources(),registry=new WorkspaceRegistry(hub.hubId),grants=fs.readFileSync(registry.file);
  const auth=new AuthStore(hub.hubId),token=auth.issueTokens({clientId:"test",scopes:["workspace.read"]}).accessToken;
  cleanup(root);await disconnectHub(hub.hubId);
  expect(new AuthStore(hub.hubId).verifyAccessToken(token).ok).toBe(false);
  expect(readLastEndpoint(hub.hubId)).toMatchObject({connectorId:"plugin_owned",disconnected:true});
  expect(readTunnelState(hub.hubId)).toEqual(saved);expect(fs.readFileSync(registry.file)).toEqual(grants);expect(resolveHub().hubId).toBe(hub.hubId);
 });
 it("remembers disconnect before any endpoint was configured",async()=>{await disconnectHub(hub.hubId);expect(readLastEndpoint(hub.hubId)).toMatchObject({disconnected:true,boundMcpUrl:null});});
 it("plans exact Hub-owned resources and requires ChatGPT removal evidence before mutations",async()=>{
  endpoint();bind();const {account}=resources();const result=await destroyHub(hub.hubId,{account});
  expect(result.plan).toEqual({version:1,hubId:hub.hubId,connector:{id:"plugin_owned",name:"Original",mcpUrl:"https://code.example.com/mcp"},desired:connectorReconciliation(readLastEndpoint(hub.hubId)),tunnel:{id:"id-owned",name:"owned",hostname:"code.example.com",zone:"example.com"}});
  for(const connectorRemoved of [undefined,"foreign"])await expect(destroyHub(hub.hubId,{account,confirm:true,connectorRemoved})).rejects.toThrow(/CONNECTOR_REMOVAL_REQUIRED/);
  expect(account.deleteDns).not.toHaveBeenCalled();expect(fs.existsSync(lifecycleFile(hub.hubId))).toBe(false);
 });
 it.each(["foreign UUID","changed name","foreign DNS"])("fails closed on %s",async(kind)=>{
  endpoint();bind();const {account}=resources();
  if(kind==="foreign UUID")account.listTunnels.mockResolvedValue([{id:"foreign",name:"owned"}]);
  if(kind==="changed name")account.listTunnels.mockResolvedValue([{id:"id-owned",name:"changed"}]);
  if(kind==="foreign DNS")account.dns.mockResolvedValue({id:"record",name:"code.example.com",type:"CNAME",content:"foreign.cfargotunnel.com"});
  await expect(destroyHub(hub.hubId,{account,confirm:true,connectorRemoved:"plugin_owned"})).rejects.toThrow(/OWNERSHIP_CONFLICT/);expect(account.deleteDns).not.toHaveBeenCalled();
 });
 it("requires separate absence evidence for an unreconciled desired binding",async()=>{
  endpoint();bind();endpoint("Changed");const {account}=resources();
  await expect(destroyHub(hub.hubId,{account,confirm:true,connectorRemoved:"plugin_owned"})).rejects.toThrow(/unreconciled/);
  expect(account.deleteTunnel).not.toHaveBeenCalled();
 });
 it("retains a partial receipt and resumes exact deletion without asking for the connector receipt again",async()=>{
  endpoint();bind();const {account}=resources();account.deleteTunnel.mockRejectedValueOnce(new Error("active connections"));
  await expect(destroyHub(hub.hubId,{account,confirm:true,connectorRemoved:"plugin_owned"})).rejects.toThrow(/active connections/);
  expect(JSON.parse(fs.readFileSync(lifecycleFile(hub.hubId),"utf8"))).toMatchObject({hubId:hub.hubId,accessStopped:true,dnsRemoved:true,tunnelRemoved:false});
  expect(fs.existsSync(new WorkspaceRegistry(hub.hubId).file)).toBe(true);
  expect((await destroyHub(hub.hubId,{account,confirm:true})).destroyed).toBe(true);
  expect(account.deleteDns).toHaveBeenCalledTimes(1);expect(fs.existsSync(hubFile(hub.hubId))).toBe(false);
 });
 it.each(["auth","workspace-registries","hubs","lifecycle"])("recovers from a failed %s local removal without affecting another Hub",async(stage)=>{
  endpoint();bind();const {account}=resources(),other=createHub("Other");
  const blocked=path.join(state,stage,`${hub.hubId}.json`),remove=fs.rmSync;
  const removal=vi.spyOn(fs,"rmSync").mockImplementation((file,options)=>{if(String(file)===blocked)throw new Error("local cleanup interrupted");return remove(file,options);});
  await expect(destroyHub(hub.hubId,{account,confirm:true,connectorRemoved:"plugin_owned"})).rejects.toThrow(/local cleanup interrupted/);
  expect(fs.existsSync(lifecycleFile(hub.hubId))).toBe(true);
  expect(fs.existsSync(hubFile(other.hubId))).toBe(true);
  removal.mockRestore();expect((await destroyHub(hub.hubId,{account,confirm:true})).destroyed).toBe(true);
  expect(fs.existsSync(hubFile(other.hubId))).toBe(true);
 });
 it.each(["pending tunnel","foreign endpoint","uncertain runtime","state symlink","invalid receipt"])("blocks destroy before remote deletion for %s",async(kind)=>{
  endpoint();bind();const {account}=resources();
  if(kind==="pending tunnel")writeTunnelState({...readTunnelState(hub.hubId),pending:{tunnelName:"owned",hostname:"code.example.com",zone:"example.com",created:false}});
  if(kind==="foreign endpoint")write(state,`endpoints/${hub.hubId}.json`,JSON.stringify({...readLastEndpoint(hub.hubId),hubId:createHub("Foreign").hubId}));
  if(kind==="uncertain runtime")write(state,`runtime/${hub.hubId}.json`,JSON.stringify({stateVersion:1,hubId:hub.hubId,service:"c2c-bridge",version:"0",pid:process.pid,port:1,adminToken:"test",publicUrl:null,startedAt:new Date().toISOString()}));
  if(kind==="invalid receipt"){const result=await destroyHub(hub.hubId,{account});write(state,`lifecycle/${hub.hubId}.json`,JSON.stringify({version:1,hubId:hub.hubId,plan:result.plan,accessStopped:false,connectorRemoved:true,desiredConnectorAbsent:true,dnsRemoved:true,tunnelRemoved:true,localCleanup:true}));}
  if(kind==="state symlink"){const file=path.join(state,"auth",`${hub.hubId}.json`);fs.unlinkSync(file);fs.symlinkSync(path.join(state,"endpoints",`${hub.hubId}.json`),file);}
  await expect(destroyHub(hub.hubId,{account,confirm:true,connectorRemoved:"plugin_owned"})).rejects.toThrow(/CONFLICT|BUSY|ROLLBACK|PATH_INVALID/);
  expect(account.deleteDns).not.toHaveBeenCalled();
 });
 it("serializes lifecycle operations per Hub",()=>{const release=acquireHubLock(hub.hubId);expect(()=>acquireHubLock(hub.hubId)).toThrow(/LIFECYCLE_BUSY/);release();acquireHubLock(hub.hubId)();});
});
describe("Cloudflare cleanup API", () => {
  it("requires an API token without reading the cloudflared certificate", async () => {
    delete process.env.CLOUDFLARE_API_TOKEN;
    const request = vi.fn();
    await expect(new CloudflareApi(request).dns("example.com", "code.example.com")).rejects.toThrow(/NEED_CLOUDFLARE_API_TOKEN/);
    expect(request).not.toHaveBeenCalled();
  });

  it("rechecks the exact DNS record and refuses a changed CNAME target", async () => {
    process.env.CLOUDFLARE_API_TOKEN = "synthetic";
    const record = { id: "record", name: "code.example.com", type: "CNAME", content: "owned.cfargotunnel.com" };
    const request = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
      const url = String(input);
      let result: unknown = [{ id: "zone", name: "example.com", account: { id: "account" } }];
      if (url.includes("dns_records?")) result = [record];
      else if (url.endsWith("dns_records/record")) result = { ...record, content: "foreign.cfargotunnel.com" };
      return Response.json({ success: true, result });
    });
    await expect(new CloudflareApi(request).deleteDns("example.com", "code.example.com", "owned")).rejects.toThrow(/OWNERSHIP_CONFLICT/);
    expect(request.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
    expect(request.mock.calls).toHaveLength(4); // zone, zone, list record, read exact record; no DELETE
  });
  it("deletes only the exact owned DNS record ID", async () => {
    process.env.CLOUDFLARE_API_TOKEN = "synthetic";
    const record = { id: "record", name: "code.example.com", type: "CNAME", content: "owned.cfargotunnel.com." };
    const request = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const result = url.includes("/zones?") ? [{ id: "zone", name: "example.com", account: { id: "account" } }] : url.includes("dns_records?") ? [record] : record;
      return Response.json({ success: true, result });
    });
    await new CloudflareApi(request).deleteDns("example.com", "code.example.com", "owned");
    const deletes = request.mock.calls.filter(([, init]) => init?.method === "DELETE");
    expect(deletes.map(([url]) => url)).toEqual(["https://api.cloudflare.com/client/v4/zones/zone/dns_records/record"]);
  });

  it("renames the saved UUID without changing its tunnel secret", async () => {
    process.env.CLOUDFLARE_API_TOKEN = "synthetic";
    const request = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const result = String(input).includes("/zones?") ? [{ id: "zone", name: "example.com", account: { id: "account" } }] : { id: "uuid", name: init?.method === "PATCH" ? "chosen" : "original" };
      return Response.json({ success: true, result });
    });
    await new CloudflareApi(request).renameTunnel("example.com", "uuid", "original", "chosen");
    const patches = request.mock.calls.filter(([, init]) => init?.method === "PATCH");
    expect(patches).toHaveLength(1);
    expect(JSON.parse(String(patches[0][1]?.body))).toEqual({ name: "chosen" });
  });

});

describe("fork update origin guard", () => {
  it.each(["git@github.com:hudrucan/desk-c2c-hub.git", "https://github.com/hudrucan/desk-c2c-hub", "ssh://git@github.com/hudrucan/desk-c2c-hub.git"])("accepts the exact fork: %s", (url) => {
    expect(() => verifyForkOrigin(() => ({ ok: true, stdout: url }))).not.toThrow();
  });
  it.each(["https://github.com/XiaoDuoYa/codex-with-chatgpt.git", "https://github.com/hudrucan/desk-c2c-hub-evil", "https://github.com.evil/hudrucan/desk-c2c-hub", "https://github.com/hudrucan/desk-c2c-hub\nhttps://foreign.example/repo", ""])("rejects an unverified origin: %s", (url) => {
    const run = vi.fn(() => ({ ok: true, stdout: url }));
    expect(() => verifyForkOrigin(run)).toThrow(/UPDATE_ORIGIN_CONFLICT/);
    expect(run).toHaveBeenCalledTimes(1); // no fetch/pull
  });
});
