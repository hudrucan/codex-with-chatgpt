import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { expect, it } from "vitest";
import { adminFetch, ensureBridge, stopBridge } from "../../src/process/daemon.js";
import { WorkspaceRegistry } from "../../src/workspace/registry.js";
import { readTunnelState } from "../../src/tunnel/state.js";
import { readRuntimeState } from "../../src/bridge/runtime.js";
import { fixtureHub as resolveHub } from "../helpers.js";
import { Workspace } from "../../src/workspace/manager.js";
import { SERVICE_NAME, VERSION } from "../../src/version.js";
import { cleanup, isolateStateDir, makeTmpDir, write } from "../helpers.js";

it("starts and stops a Hub-owned source daemon without deleting or copying stale legacy runtime", async () => {
  const state = isolateStateDir(), root = makeTmpDir("hub-daemon");
  const workspace = new Workspace(root), hub = resolveHub(workspace);
  const legacyFile = write(state, `runtime/${workspace.id}.json`, JSON.stringify({ service: SERVICE_NAME, version: VERSION,
    workspaceId: workspace.id, workspaceRoot: root, pid: 999_999_999, port: 1,
    adminToken: "stale-admin", publicUrl: null, startedAt: new Date().toISOString() }));
  const original = fs.readFileSync(legacyFile, "utf8");
  const legacyTunnel = { workspaceId: workspace.id, preference: "named", provider: "cloudflare-named",
    tunnelName: "existing-tunnel", tunnelId: "11111111-1111-4111-8111-111111111111",
    hostname: "code.example.com", zone: "example.com" };
  const tunnelFile = write(state, `tunnels/${workspace.id}.json`, JSON.stringify(legacyTunnel));

  let spawnedPid: number | undefined;
  try {
    const started = await ensureBridge(hub.hubId, { port: 0 });
    spawnedPid = started.runtime.pid;
    expect(started.spawned).toBe(true);
    expect(started.runtime.hubId).toBe(hub.hubId);
    expect(readTunnelState(hub.hubId)).toMatchObject({ hubId: hub.hubId, preference: "unset" });
    expect(fs.readFileSync(tunnelFile, "utf8")).toBe(JSON.stringify(legacyTunnel));
    const extra=makeTmpDir("hub-extra-repo");
    const immutable=["auth","runtime","tunnels","endpoints"].map(dir=>{const file=path.join(state,dir,`${hub.hubId}.json`);return {file,bytes:fs.readFileSync(file)};});
    try {
      const cli=fileURLToPath(new URL("../../src/cli/index.ts",import.meta.url));
      for(const args of [["workspace","add",extra,"--alias","extra"],["workspace","remove","extra"]]) {
        const result=spawnSync(process.execPath,["--import","tsx",cli,...args,"--hub",hub.hubId,"--json"],{env:{...process.env,C2C_STATE_DIR:state},encoding:"utf8",timeout:10000});
        expect(result.status,result.stdout+result.stderr).toBe(0);
      }
      for(const item of immutable)expect(fs.readFileSync(item.file)).toEqual(item.bytes);
    } finally {cleanup(extra);}
    const info = await adminFetch<{ hubId: string; workspaceId: string }>(started.runtime, "GET", "/admin/info");
    expect(info).toMatchObject({ hubId: hub.hubId, workspaceId: workspace.id });
    new WorkspaceRegistry(hub.hubId).remove(workspace.id);
    cleanup(root);
    expect((await ensureBridge(hub.hubId)).spawned).toBe(false);
    expect(fs.existsSync(path.join(state, "logs", `bridge-${hub.hubId}.out.log`))).toBe(true);
    expect(fs.readFileSync(legacyFile, "utf8")).toBe(original);
    expect(await stopBridge(hub.hubId)).toBe(true);
    for (let n = 0; n < 100 && readRuntimeState(hub.hubId); n++) await new Promise((resolve) => setTimeout(resolve, 50));
    expect(readRuntimeState(hub.hubId)).toBeNull();
    const restarted=await ensureBridge(hub.hubId,{port:0});spawnedPid=restarted.runtime.pid;
    expect(restarted.runtime.hubId).toBe(hub.hubId);
    expect(restarted.runtime.workspaceRoot).toBeUndefined();
    expect(new WorkspaceRegistry(hub.hubId).choices()).toEqual([]);
    expect(await stopBridge(hub.hubId)).toBe(true);
    expect(fs.readFileSync(legacyFile, "utf8")).toBe(original);
  } finally {
    if (spawnedPid && readRuntimeState(hub.hubId)) {
      try { process.kill(spawnedPid, "SIGTERM"); } catch { /* helper already exited */ }
    }
    [state, root].forEach(cleanup);
    delete process.env.C2C_STATE_DIR;
  }
});
