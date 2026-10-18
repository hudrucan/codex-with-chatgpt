import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Workspace } from "../src/workspace/manager.js";
import { AuthStore } from "../src/auth/store.js";
import { startBridge, type Bridge } from "../src/bridge/server.js";
import { readRuntimeState } from "../src/bridge/runtime.js";
import { readLastEndpoint, writeLastEndpoint, confirmConnectorBinding } from "../src/config/endpoint.js";
import { readTunnelState, writeTunnelState } from "../src/tunnel/state.js";
import type { TunnelProvider } from "../src/tunnel/provider.js";
import { cleanup, isolateStateDir, makeTmpDir, write } from "./helpers.js";

const execFileAsync = promisify(execFile);
const cliEntry = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));

describe("naming through setup and repair commands", () => {
  const dirs: string[] = [];
  const originalStateDir = process.env.C2C_STATE_DIR;
  let root: string;
  let stateDir: string;
  let codexHome: string;
  let bridge: Bridge | null;
  let ownsDaemon: boolean;

  beforeEach(() => {
    stateDir = isolateStateDir();
    root = makeTmpDir("naming-cli-workspace");
    codexHome = makeTmpDir("naming-cli-codex");
    dirs.push(stateDir, root, codexHome);
    bridge = null;
    ownsDaemon = false;
  });

  async function runCli(args: string[], env: NodeJS.ProcessEnv = {}) {
    const options = {
      encoding: "utf8" as const,
      timeout: 25_000,
      env: { ...process.env, C2C_STATE_DIR: stateDir, CODEX_HOME: codexHome, ...env },
    };
    try {
      const result = await execFileAsync(process.execPath, ["--import", "tsx", cliEntry, ...args, "-w", root, "--json"], options);
      return { status: 0, payload: JSON.parse(result.stdout) };
    } catch (error) {
      const failed = error as Error & { stdout?: string; stderr?: string; code?: number };
      if (!failed.stdout?.trim()) throw new Error(`${failed.message}\n${failed.stderr ?? ""}`);
      return { status: failed.code, payload: JSON.parse(failed.stdout) };
    }
  }

  afterEach(async () => {
    if (bridge) await bridge.close();
    if (ownsDaemon) {
      const workspace = new Workspace(root);
      // stop has no --json flag; invoke it separately and wait for state cleanup.
      await execFileAsync(process.execPath, ["--import", "tsx", cliEntry, "stop", "-w", root], {
        env: { ...process.env, C2C_STATE_DIR: stateDir }, timeout: 10_000,
      });
      for (let attempt = 0; attempt < 100 && readRuntimeState(workspace.id); attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(readRuntimeState(workspace.id)).toBeNull();
    }
    for (const dir of dirs.splice(0)) cleanup(dir);
    if (originalStateDir === undefined) delete process.env.C2C_STATE_DIR;
    else process.env.C2C_STATE_DIR = originalStateDir;
  });

  it("persists explicit names through setup reruns, doctor, restart, and display-name changes without revoking tokens", async () => {
    write(root, ".c2c.json", JSON.stringify({ name: "Original", maxIterations: 7 }));
    const workspace = new Workspace(root);
    const token = new AuthStore(workspace.id).issueTokens({ clientId: "naming-test", scopes: ["workspace.read"] }).accessToken;
    ownsDaemon = true;
    const first = await runCli(["setup", "--no-tunnel", "--workspace-name", "Desk C2C Hub", "--connector-name", "Desk Connector"]);
    expect(first.status, JSON.stringify(first.payload)).toBe(0);
    expect(first.payload).toMatchObject({ workspaceId: workspace.id, workspaceName: "Desk C2C Hub", connectorName: "Desk Connector" });
    const initialPid = readRuntimeState(workspace.id)!.pid;

    const rerun = await runCli(["setup", "--no-tunnel"]);
    expect(rerun.status).toBe(0);
    expect(rerun.payload.connectorName).toBe("Desk Connector");
    expect(readRuntimeState(workspace.id)!.pid).toBe(initialPid);
    expect((await runCli(["doctor"])).payload.chatgptRepair.connectorName).toBe("Desk Connector");

    const renamed = await runCli(["setup", "--no-tunnel", "--workspace-name", "Renamed Workspace"]);
    expect(renamed.status).toBe(1);
    expect(renamed.payload.error).toContain("WORKSPACE_NAME_RESTART_REQUIRED");
    expect(readRuntimeState(workspace.id)!.pid).toBe(initialPid);
    expect((await runCli(["status"])).payload).toMatchObject({ workspaceNameRestartRequired: true, configuredWorkspaceName: "Renamed Workspace" });
    const diagnosis = await runCli(["doctor"]);
    expect(diagnosis.payload.workspaceNameRestartRequired).toBe(true);
    expect(readRuntimeState(workspace.id)!.pid).toBe(initialPid);

    const restarted = await runCli(["restart"]);
    expect(restarted.status, JSON.stringify(restarted.payload)).toBe(0);
    expect(restarted.payload).toMatchObject({ workspaceId: workspace.id, workspaceName: "Renamed Workspace", connectorName: "Desk Connector" });
    expect(new Workspace(root).id).toBe(workspace.id);
    expect(readLastEndpoint(workspace.id)?.desiredConnectorName).toBe("Desk Connector");
    expect(JSON.parse(fs.readFileSync(path.join(root, ".c2c.json"), "utf8"))).toEqual({ name: "Original", maxIterations: 7 });

    const runtime = readRuntimeState(workspace.id)!;
    const response = await fetch(`http://127.0.0.1:${runtime.port}/mcp`, { headers: { authorization: `Bearer ${token}` } });
    expect(response.status).toBe(405); // Bearer guard accepted the original token.
    expect((await runCli(["setup", "--no-tunnel"])).payload.connectorName).toBe("Desk Connector");
  });

  it("disconnects the daemon while preserving naming and keeps doctor from restarting it", async () => {
    ownsDaemon = true;
    const setup = await runCli(["setup", "--no-tunnel", "--workspace-name", "Local Name", "--connector-name", "Retained Connector"]);
    const id = setup.payload.workspaceId;
    const disconnected = await runCli(["disconnect"]);
    expect(disconnected.payload).toMatchObject({ ok: true, disconnected: true, resourcesRetained: true });
    expect(readRuntimeState(id)).toBeNull();
    expect((await runCli(["doctor"])).payload.disconnected).toBe(true);
    expect(readRuntimeState(id)).toBeNull();
    const reconnect = await runCli(["setup", "--no-tunnel"]);
    expect(reconnect.payload).toMatchObject({ workspaceName: "Local Name", connectorName: "Retained Connector" });
    expect(readLastEndpoint(id)?.disconnected).toBe(false);
    expect(fs.existsSync(path.join(root, ".c2c.json"))).toBe(false);
  });

  it("preserves configured connector, tunnel name and hostname when doctor repairs a changed endpoint", async () => {
    let url: string | null = null;
    const tunnel: TunnelProvider = {
      name: "cloudflare-named",
      start: async (port) => (url = `http://127.0.0.1:${port}`),
      stop: async () => { url = null; },
      restart: async (port) => (url = `http://127.0.0.1:${port}`),
      status: () => ({ running: url !== null, url, provider: "cloudflare-named" }),
      getPublicUrl: () => url,
      doctor: async () => ({ provider: "cloudflare-named", binaryFound: true, binaryPath: "test", running: url !== null, url, problems: [] }),
    };
    bridge = await startBridge({ workspaceRoot: root, port: 0, tunnelProvider: tunnel });
    const setup = await runCli(["setup", "--no-tunnel", "--connector-name", "Desk Connector"]);
    expect(setup.status).toBe(0);
    const workspaceId = bridge.workspace.id;
    const tunnelId = "11111111-1111-4111-8111-111111111111";
    const savedTunnel = writeTunnelState({
      workspaceId, preference: "named", provider: "cloudflare-named", tunnelId,
      tunnelName: "desk-c2c", hostname: "code.example.com", zone: "example.com",
    });
    const cert = write(stateDir, "test-cert.pem", "synthetic certificate");
    const credential = write(stateDir, "test-credential.json", JSON.stringify({ TunnelID: tunnelId, TunnelSecret: "synthetic secret" }));
    await fetch(`${bridge.localBaseUrl()}/admin/tunnel/start`, {
      method: "POST", headers: { authorization: `Bearer ${bridge.adminToken}` },
    });
    writeLastEndpoint({ ...readLastEndpoint(workspaceId)!, publicUrl: "https://old.example.com", mcpUrl: "https://old.example.com/mcp" });
    confirmConnectorBinding(workspaceId, { name: "Desk Connector", mcpUrl: "https://old.example.com/mcp", connectorId: "plugin_owned" });
    const result = await runCli(["doctor"], { TUNNEL_ORIGIN_CERT: cert, TUNNEL_CRED_FILE: credential });
    expect(result.payload.chatgptRepair).toMatchObject({ needed: true, connectorAction: "update", connectorName: "Desk Connector" });
    expect(readLastEndpoint(workspaceId)).toMatchObject({ connectorName: "Desk Connector", publicUrl: url });
    expect(readTunnelState(workspaceId)).toEqual(savedTunnel);
    const secondDoctor = await runCli(["doctor"], { TUNNEL_ORIGIN_CERT: cert, TUNNEL_CRED_FILE: credential });
    expect(secondDoctor.payload.chatgptRepair).toMatchObject({ needed: true, previousMcpUrl: "https://old.example.com/mcp" });
    const bind = await runCli(["connector", "bind", "--name", "Desk Connector", "--mcp-url", `${url!}/mcp`, "--connector-id", "plugin_new", "--verified-workspace", workspaceId]);
    expect(bind.status, JSON.stringify(bind.payload)).toBe(0);
    expect((await runCli(["doctor"], { TUNNEL_ORIGIN_CERT: cert, TUNNEL_CRED_FILE: credential })).payload.chatgptRepair.needed).toBe(false);
  });

  it.skipIf(process.platform === "win32")("honors all setup naming flags through the Cloudflare process adapter and reuses them on rerun", async () => {
    const accountFile = path.join(stateDir, "fake-account.json");
    const binary = write(stateDir, "fake-cloudflared.cjs", `#!${process.execPath}
const fs = require("node:fs");
const file = process.env.C2C_TEST_ACCOUNT_FILE;
const db = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { tunnels: [], routes: [] };
const args = process.argv.slice(2);
if (args.includes("run")) {
  console.log("INF Registered tunnel connection");
  setInterval(() => {}, 1000);
} else {
  if (args[0] === "--version") console.log("cloudflared version test");
  if (args[1] === "list") console.log(JSON.stringify(db.tunnels));
  if (args[1] === "create") {
    const tunnel = { id: "11111111-1111-4111-8111-111111111111", name: args[2] };
    db.tunnels.push(tunnel);
    console.log("Created tunnel " + tunnel.name + " with id " + tunnel.id);
  }
  if (args[1] === "route") db.routes.push({ tunnel: args[3], hostname: args[4] });
  fs.writeFileSync(file, JSON.stringify(db));
}
`);
    fs.chmodSync(binary, 0o755);
    const cert = write(stateDir, "fake-cert.pem", "synthetic certificate");
    const env = { C2C_CLOUDFLARED_PATH: binary, TUNNEL_ORIGIN_CERT: cert, C2C_TEST_ACCOUNT_FILE: accountFile };
    ownsDaemon = true;
    const flags = ["--workspace-name", "Desk C2C Hub", "--connector-name", "Desk Connector", "--tunnel-name", "desk-c2c", "--hostname", "code.example.com", "--zone", "example.com"];
    const first = await runCli(["setup", ...flags], env);
    expect(first.status, JSON.stringify(first.payload)).toBe(0);
    expect(fs.existsSync(path.join(root, ".c2c.json"))).toBe(false);
    expect(first.payload).toMatchObject({ workspaceName: "Desk C2C Hub", connectorName: "Desk Connector", tunnel: { name: "desk-c2c", hostname: "code.example.com" } });
    const pid = readRuntimeState(first.payload.workspaceId)!.pid;
    const rerun = await runCli(["setup", ...flags], env);
    expect(rerun.status, JSON.stringify(rerun.payload)).toBe(0);
    expect(rerun.payload.tunnel).toEqual(first.payload.tunnel);
    expect(rerun.payload.connectorName).toBe("Desk Connector");
    expect(readRuntimeState(first.payload.workspaceId)!.pid).toBe(pid);
    const saved = await runCli(["setup"], env);
    expect(saved.payload.tunnel).toEqual(first.payload.tunnel);
    expect(saved.payload.connectorName).toBe("Desk Connector");
    const choice = await runCli(["tunnel", "choose", "--mode", "named"], env);
    expect(choice.payload.state).toMatchObject({ tunnelName: "desk-c2c", hostname: "code.example.com" });
    expect(readRuntimeState(first.payload.workspaceId)!.pid).toBe(pid);
    const account = JSON.parse(fs.readFileSync(accountFile, "utf8"));
    expect(account.tunnels).toHaveLength(1);
    expect(account.routes).toEqual([{ tunnel: account.tunnels[0].id, hostname: "code.example.com" }]);
  });
});
