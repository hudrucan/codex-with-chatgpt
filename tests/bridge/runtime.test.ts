import { fixtureHub, fixtureWorkspace, fixtureAuthFile } from "../helpers.js";
import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import path from "node:path";
import { startBridge } from "../../src/bridge/server.js";
import {
  findBridgeObservation,
  findLiveBridge,
  readRuntimeState,
  runtimeFile,
  writeRuntimeState,
  type RuntimeState,
} from "../../src/bridge/runtime.js";
import { adminFetch, ensureBridge, stopBridge } from "../../src/process/daemon.js";
import { SERVICE_NAME, VERSION } from "../../src/version.js";
import fs from "node:fs";
import { fixtureHub as resolveHub } from "../helpers.js";
import { createHub } from "../../src/hub/store.js";
import { WorkspaceRegistry } from "../../src/workspace/registry.js";
import { Workspace } from "../../src/workspace/manager.js";
import { cleanup, isolateStateDir, makeTmpDir, write } from "../helpers.js";

function stubRuntime(hubId: string, pid: number, port: number): RuntimeState {
  return {
    stateVersion: 1, hubId,
    service: SERVICE_NAME,
    version: VERSION,
    pid,
    port,
    adminToken: "test-token",
    publicUrl: null,
    startedAt: new Date().toISOString(),
  };
}

describe("findBridgeObservation", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) cleanup(dir);
    dirs.length = 0;
    delete process.env.C2C_STATE_DIR;
  });

  it("treats a missing runtime file as stopped", async () => {
    dirs.push(isolateStateDir());
    const root = makeTmpDir("obs-missing");
    dirs.push(root);
    write(root, "a.txt", "a");
    const workspace = new Workspace(root);
    const observation = await findBridgeObservation(resolveHub(workspace).hubId);
    expect(observation.state).toBe("stopped");
    if (observation.state === "stopped") expect(observation.reason).toBe("runtime_missing");
    expect(await findLiveBridge(resolveHub(workspace).hubId)).toBeNull();
  });

  it("treats a dead pid plus a failed probe as stopped", async () => {
    dirs.push(isolateStateDir());
    const root = makeTmpDir("obs-dead");
    dirs.push(root);
    write(root, "a.txt", "a");
    const workspace = new Workspace(root);
    write(process.env.C2C_STATE_DIR!, `runtime/${resolveHub(workspace).hubId}.json`, JSON.stringify(stubRuntime(resolveHub(workspace).hubId, 999_999_999, 1)));
    const observation = await findBridgeObservation(resolveHub(workspace).hubId);
    expect(observation.state).toBe("stopped");
    if (observation.state === "stopped") expect(observation.reason).toBe("pid_missing");
    expect(await findLiveBridge(resolveHub(workspace).hubId)).toBeNull();
  });

  it("does not treat a live pid plus a failed probe as stopped", async () => {
    dirs.push(isolateStateDir());
    const root = makeTmpDir("obs-unknown");
    dirs.push(root);
    write(root, "a.txt", "a");
    const workspace = new Workspace(root);
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
      detached: true,
    });
    child.unref();
    try {
      if (!child.pid) throw new Error("failed to spawn helper");
      write(process.env.C2C_STATE_DIR!, `runtime/${resolveHub(workspace).hubId}.json`, JSON.stringify(stubRuntime(resolveHub(workspace).hubId, child.pid, 1)));
      const observation = await findBridgeObservation(resolveHub(workspace).hubId);
      expect(observation.state).toBe("unknown");
      if (observation.state === "unknown") expect(observation.reason).toBe("probe_failed");
      expect(await findLiveBridge(resolveHub(workspace).hubId)).toBeNull();
      await expect(ensureBridge(resolveHub(workspace).hubId)).rejects.toThrow(/uncertain/);
    } finally {
      if (child.pid) {
        try {
          process.kill(child.pid, "SIGKILL");
        } catch {
          /* ignore */
        }
      }
    }
  });

  it.each(["file", "health"])("refuses another Hub's %s identity without reusing or stopping its bridge", async (source) => {
    dirs.push(isolateStateDir());
    const own = createHub("Own Hub"), foreign = createHub("Other Hub");
    const bridge = await startBridge({ hubId: foreign.hubId, port: 0 });
    try {
      const runtime = readRuntimeState(foreign.hubId)!;
      fs.writeFileSync(runtimeFile(own.hubId), JSON.stringify({ ...runtime, hubId: source === "file" ? foreign.hubId : own.hubId }));
      expect(await findBridgeObservation(own.hubId)).toMatchObject({ state: "unknown", reason: source === "file" ? "runtime_invalid" : "hub_mismatch" });
      await expect(ensureBridge(own.hubId)).rejects.toThrow(/uncertain/);
      await expect(stopBridge(own.hubId)).rejects.toThrow(/uncertain/);
      expect(await findLiveBridge(foreign.hubId)).toEqual(runtime);
    } finally { await bridge.close(); }
  });

  it.each([0, 2])("starts with %i workspaces and keeps Hub metadata stable through hot registry changes", async (count) => {
    dirs.push(isolateStateDir());
    const hub = createHub("Independent Hub"), registry = new WorkspaceRegistry(hub.hubId);
    const roots = [makeTmpDir("hub-repo-a"), makeTmpDir("hub-repo-b")];
    dirs.push(...roots);
    for (let index = 0; index < count; index++) registry.add(roots[index], `repo-${index}`);
    const first = registry.list()[0];
    const bridge = await startBridge({ hubId: hub.hubId, port: 0 });
    try {
      const metadata = async () => ({
        health: await fetch(`${bridge.localBaseUrl()}/health`).then(response => response.json()),
        admin: await adminFetch(startedRuntime, "GET", "/admin/info"),
        runtime: fs.readFileSync(runtimeFile(hub.hubId), "utf8"),
      });
      const startedRuntime = readRuntimeState(hub.hubId)!;
      expect(Object.keys(startedRuntime).sort()).toEqual([
        "service", "version", "stateVersion", "hubId", "pid", "port", "adminToken", "publicUrl", "startedAt",
      ].sort());
      const before = await metadata();
      expect(before.health).toEqual({ service: SERVICE_NAME, version: VERSION, hubId: hub.hubId, status: "ok" });
      expect(before.admin).toMatchObject({ hubId: hub.hubId, hubName: hub.displayName });
      for (const key of ["workspaceId", "workspaceRoot", "workspaceName"]) expect(before.admin).not.toHaveProperty(key);
      if (first) registry.remove(first.workspaceId);
      else registry.add(roots[0], "added");
      expect(await metadata()).toEqual(before);
      for (const entry of registry.list()) registry.remove(entry.workspaceId);
      expect(await metadata()).toEqual(before);
      registry.add(roots[1], "remaining");
      expect(await metadata()).toEqual(before);
      expect(await ensureBridge(hub.hubId)).toEqual({ spawned: false, runtime: startedRuntime });
    } finally { await bridge.close(); }
  });

  it("reports healthy when the local bridge answers", async () => {
    dirs.push(isolateStateDir());
    const root = makeTmpDir("obs-live");
    dirs.push(root);
    write(root, "a.txt", "a");
    const auth = path.join(makeTmpDir("obs-auth"), "store.json");
    dirs.push(path.dirname(auth));
    const bridge = await startBridge({
      hubId: fixtureHub(root).hubId,
      port: 0,
      persistRuntime: true,
      authStoreFile: fixtureAuthFile(fixtureHub(root).hubId, auth),
    });
    try {
      const observation = await findBridgeObservation(bridge.hubId);
      expect(observation.state).toBe("healthy");
      expect(readRuntimeState(bridge.hubId)).toMatchObject({ stateVersion: 1, hubId: bridge.hubId });
      expect(fs.existsSync(runtimeFile(bridge.hubId))).toBe(true);
      expect(fs.existsSync(path.join(process.env.C2C_STATE_DIR!, "runtime", `${fixtureWorkspace(bridge).id}.json`))).toBe(false);
      const health = await fetch(`${bridge.localBaseUrl()}/health`).then((response) => response.json());
      expect(health).toEqual({ service: SERVICE_NAME, version: VERSION, hubId: bridge.hubId, status: "ok" });
      expect(await findLiveBridge(bridge.hubId)).not.toBeNull();

      // A deployed v1 file remains observable/reusable without rewriting it on read.
      const current = readRuntimeState(bridge.hubId)!;
      const deployed = { ...current, workspaceId: fixtureWorkspace(bridge).id, workspaceRoot: root };
      fs.writeFileSync(runtimeFile(bridge.hubId), JSON.stringify(deployed));
      const bytes = fs.readFileSync(runtimeFile(bridge.hubId));
      expect(readRuntimeState(bridge.hubId)).toEqual(current);
      expect(await findBridgeObservation(bridge.hubId)).toEqual({ state: "healthy", runtime: current });
      expect(await ensureBridge(bridge.hubId)).toEqual({ spawned: false, runtime: current });
      expect(fs.readFileSync(runtimeFile(bridge.hubId))).toEqual(bytes);
      writeRuntimeState(deployed);
      expect(JSON.parse(fs.readFileSync(runtimeFile(bridge.hubId), "utf8"))).toEqual(current);
    } finally {
      await bridge.close();
    }
    expect(readRuntimeState(bridge.hubId)).toBeNull();
  });
});
