import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createHub } from "../../src/hub/store.js";
import { Workspace } from "../../src/workspace/manager.js";
import { cleanup, isolateStateDir, makeTmpDir } from "../helpers.js";
const entry=fileURLToPath(new URL("../../src/cli/index.ts",import.meta.url));
let state:string,root:string,other:string;
beforeEach(()=>{state=isolateStateDir();root=makeTmpDir("registry-cli");other=makeTmpDir("registry-cli-other");});
afterEach(()=>{[state,root,other].forEach(cleanup);delete process.env.C2C_STATE_DIR;});
function cli(args:string[],cwd=root){return spawnSync(process.execPath,["--import","tsx",entry,"workspace",...args],{cwd,env:{...process.env,C2C_STATE_DIR:state},encoding:"utf8",timeout:10000});}
function json(args:string[],cwd=root){const result=cli([...args,"--json"],cwd);expect(result.status,`${result.stdout}\n${result.stderr}`).toBe(0);return JSON.parse(result.stdout);}
it("inspects a repo without configuring a Hub; registry commands discover one Hub without an owner root",()=>{
  const id=new Workspace(root).id;
  expect(json(["-w",root])).toMatchObject({workspaceId:id,root});
  expect(fs.readdirSync(state)).toEqual([]);
  expect(JSON.parse(cli(["list","--json"]).stdout).error).toContain("HUB_NOT_CONFIGURED");
  const hub=createHub("Desk");
  const immutable=["auth","tunnels","endpoints","hubs"].map(dir=>{const file=path.join(state,dir,`${hub.hubId}.json`);return {file,bytes:fs.readFileSync(file)};});
  expect(json(["list"]).workspaces).toEqual([]);
  expect(json(["add",root,"--alias","backend"])).toMatchObject({workspaceId:id,alias:"backend"});
  const second=json(["add",other]);expect(second.alias).toContain(second.workspaceId);
  expect(json(["list"],other).workspaces).toHaveLength(2);
  expect(json(["remove","backend"],other).workspaceId).toBe(id);
  expect(json(["remove",second.workspaceId]).workspaceId).toBe(second.workspaceId);
  expect(json(["list"]).workspaces).toEqual([]);
  for(const item of immutable)expect(fs.readFileSync(item.file)).toEqual(item.bytes);
  expect(fs.readdirSync(root)).toEqual([]);
});
it("requires --hub for multiple Hubs and keeps grants isolated regardless of cwd",()=>{
  const a=createHub("One"),b=createHub("Two");
  const result=cli(["list","--json"]);expect(result.status).toBe(1);expect(JSON.parse(result.stdout).error).toContain("HUB_SELECTION_REQUIRED");
  json(["--hub",a.hubId,"add",root,"--alias","shared"],other);
  json(["add",other,"--hub",b.hubId,"--alias","shared"]);
  expect(json(["list","--hub",a.hubId],other).workspaces[0].workspaceId).toBe(new Workspace(root).id);
  expect(json(["--hub",b.hubId,"list"]).workspaces[0].workspaceId).toBe(new Workspace(other).id);
  expect(cli(["remove",new Workspace(root).id,"--hub",b.hubId]).status).toBe(1);
});
it("rejects root ownership flags, invalid aliases, missing paths and unknown removals",()=>{
  createHub("Desk");
  expect(cli(["add"]).status).not.toBe(0);
  expect(cli(["add","-w",root]).status).not.toBe(0);
  json(["add",root,"--alias","alpha"]);
  for(const args of [["list","-w",root],["add",path.join(root,"missing")],["add",other,"--alias","alpha"],["add",other,"--alias","../bad"],["remove",root]])expect(cli([...args,"--json"]).status).not.toBe(0);
  expect(json(["list"]).workspaces).toHaveLength(1);
});
