import fs from "node:fs";
import path from "node:path";
import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findBridgeObservation, runtimeFile } from "../../src/bridge/runtime.js";
import { ensureBridge, stopBridge } from "../../src/process/daemon.js";
import { resolveHub } from "../../src/hub/store.js";
import { Workspace } from "../../src/workspace/manager.js";
import { SERVICE_NAME, VERSION } from "../../src/version.js";
import { cleanup, isolateStateDir, makeTmpDir, write } from "../helpers.js";

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
  it("reuses a verified healthy legacy bridge without spawning, copying runtime or adopting live auth", async () => {
    const workspace = new Workspace(root), hub = resolveHub(workspace);
    const legacy = await legacyRuntime(workspace.id);
    const contents = fs.readFileSync(legacy.file, "utf8");
    const reused = await ensureBridge(root);
    expect(reused).toEqual({ runtime: legacy.runtime, spawned: false });
    expect(fs.existsSync(runtimeFile(hub.hubId))).toBe(false);
    expect(fs.existsSync(path.join(state, "auth", `${hub.hubId}.json`))).toBe(false);
    expect(fs.readFileSync(legacy.file, "utf8")).toBe(contents);
    expect(await stopBridge(root)).toBe(true);
    expect(legacy.shutdowns()).toBe(1);
    expect(fs.readFileSync(legacy.file, "utf8")).toBe(contents);
  });

  it.each(["runtime owner", "health owner"])("never reuses or stops a live legacy bridge with a foreign %s", async (kind) => {
    const workspace = new Workspace(root), foreign = new Workspace(foreignRoot), hub = resolveHub(workspace);
    const legacy = await legacyRuntime(kind === "health owner" ? foreign.id : workspace.id, kind === "runtime owner" ? foreign : workspace);
    const contents = fs.readFileSync(legacy.file, "utf8");
    expect((await findBridgeObservation(hub.hubId)).state).toBe("unknown");
    await expect(ensureBridge(root)).rejects.toThrow(/uncertain/);
    await expect(stopBridge(root)).rejects.toThrow(/uncertain/);
    expect(legacy.shutdowns()).toBe(0);
    expect(fs.existsSync(runtimeFile(hub.hubId))).toBe(false);
    expect(fs.readFileSync(legacy.file, "utf8")).toBe(contents);
  });

  it("does not let a dead legacy PID block the Hub even if its old port serves another owner", async () => {
    const workspace = new Workspace(root), hub = resolveHub(workspace);
    await legacyRuntime(new Workspace(foreignRoot).id, workspace, 999_999_999);
    expect(await findBridgeObservation(hub.hubId)).toMatchObject({ state: "stopped", reason: "pid_missing" });
  });
});
