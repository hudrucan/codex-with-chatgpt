import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { adminFetch, ensureBridge, stopBridge } from "../../src/process/daemon.js";
import { readTunnelState } from "../../src/tunnel/state.js";
import { readRuntimeState } from "../../src/bridge/runtime.js";
import { resolveHub } from "../../src/hub/store.js";
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
    const started = await ensureBridge(root, { port: 0 });
    spawnedPid = started.runtime.pid;
    expect(started.spawned).toBe(true);
    expect(started.runtime.hubId).toBe(hub.hubId);
    expect(readTunnelState(hub.hubId)).toMatchObject({ hubId: hub.hubId, tunnelId: legacyTunnel.tunnelId });
    expect(fs.readFileSync(tunnelFile, "utf8")).toBe(JSON.stringify(legacyTunnel));
    const info = await adminFetch<{ hubId: string; workspaceId: string }>(started.runtime, "GET", "/admin/info");
    expect(info).toMatchObject({ hubId: hub.hubId, workspaceId: workspace.id });
    expect((await ensureBridge(root)).spawned).toBe(false);
    expect(fs.existsSync(path.join(state, "logs", `bridge-${hub.hubId}.out.log`))).toBe(true);
    expect(fs.readFileSync(legacyFile, "utf8")).toBe(original);
    expect(await stopBridge(root)).toBe(true);
    for (let n = 0; n < 100 && readRuntimeState(hub.hubId); n++) await new Promise((resolve) => setTimeout(resolve, 50));
    expect(readRuntimeState(hub.hubId)).toBeNull();
    expect(fs.readFileSync(legacyFile, "utf8")).toBe(original);
  } finally {
    if (spawnedPid && readRuntimeState(hub.hubId)) {
      try { process.kill(spawnedPid, "SIGTERM"); } catch { /* helper already exited */ }
    }
    [state, root].forEach(cleanup);
    delete process.env.C2C_STATE_DIR;
  }
});
