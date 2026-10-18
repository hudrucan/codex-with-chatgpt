import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Workspace } from "../src/workspace/manager.js";
import { AuthStore } from "../src/auth/store.js";
import { acquireWorkspaceLock, destroyWorkspace, disconnectWorkspace, lifecycleFile } from "../src/lifecycle/workspace.js";
import { boundConnector, confirmConnectorBinding, connectorReconciliation, persistWorkspaceEndpoint, readLastEndpoint, writeLastEndpoint } from "../src/config/endpoint.js";
import { readTunnelState, writeTunnelState } from "../src/tunnel/state.js";
import { CloudflareApi } from "../src/tunnel/cloudflare-api.js";
import { verifyForkOrigin } from "../src/config/update.js";
import { cleanup, isolateStateDir, makeTmpDir, write } from "./helpers.js";

const originalStateDir = process.env.C2C_STATE_DIR;
const originalApiToken = process.env.CLOUDFLARE_API_TOKEN;
let dirs: string[] = [];
let root: string;
let state: string;
beforeEach(() => { state = isolateStateDir(); root = makeTmpDir("lifecycle"); dirs = [root, state]; });
afterEach(async () => {
  dirs.forEach(cleanup);
  if (originalStateDir === undefined) delete process.env.C2C_STATE_DIR; else process.env.C2C_STATE_DIR = originalStateDir;
  if (originalApiToken === undefined) delete process.env.CLOUDFLARE_API_TOKEN; else process.env.CLOUDFLARE_API_TOKEN = originalApiToken;
});

function endpoint(name = "Original") {
  const ws = new Workspace(root);
  persistWorkspaceEndpoint({ workspaceId: ws.id, workspaceName: ws.name, connectorName: name, port: 1234, publicUrl: "https://code.example.com", mcpUrl: "https://code.example.com/mcp" });
  return ws;
}
function bind(ws: Workspace, name = "Original") {
  confirmConnectorBinding(ws.id, { name, mcpUrl: "https://code.example.com/mcp", connectorId: "plugin_owned" });
}
function resources(ws: Workspace) {
  const saved = writeTunnelState({ workspaceId: ws.id, preference: "named", tunnelId: "id-owned", tunnelName: "owned", hostname: "code.example.com", zone: "example.com" });
  const account = {
    hasCert: () => true, login: vi.fn(), createTunnel: vi.fn(), routeDns: vi.fn(), renameTunnel: vi.fn(),
    listTunnels: vi.fn(async () => [{ id: "id-owned", name: "owned" }]),
    dns: vi.fn(async () => ({ id: "record-owned", name: "code.example.com", type: "CNAME", content: "id-owned.cfargotunnel.com" })),
    deleteDns: vi.fn(async () => undefined), deleteTunnel: vi.fn(async () => undefined),
  };
  return { saved, account };
}

describe("transactional connector reconciliation", () => {
  it("does not claim a new binding until an explicit verified acknowledgement", () => {
    const ws = endpoint();
    expect(boundConnector(readLastEndpoint(ws.id))).toBeNull();
    expect(connectorReconciliation(readLastEndpoint(ws.id))).toMatchObject({ needed: true, connectorAction: "create" });
    bind(ws);
    endpoint("Chosen");
    endpoint(); // an explicit setup can still change desired; bound remains unchanged
    endpoint("Chosen");
    const pending = readLastEndpoint(ws.id)!;
    expect(pending).toMatchObject({ connectorName: "Original", desiredConnectorName: "Chosen", connectorId: "plugin_owned" });
    // Reruns without explicit values keep desired, never commit bound.
    persistWorkspaceEndpoint({ workspaceId: ws.id, workspaceName: "Display Changed", port: 1234, publicUrl: pending.publicUrl, mcpUrl: pending.mcpUrl });
    expect(connectorReconciliation(readLastEndpoint(ws.id))).toMatchObject({ needed: true, connectorName: "Chosen", previousConnectorName: "Original" });
    confirmConnectorBinding(ws.id, { name: "Chosen", mcpUrl: pending.mcpUrl!, connectorId: "plugin_new" });
    expect(connectorReconciliation(readLastEndpoint(ws.id)).needed).toBe(false);
  });

  it("rejects stale/wrong names and URLs without losing the previous binding", () => {
    const ws = endpoint(); bind(ws); endpoint("Chosen");
    const previous = readLastEndpoint(ws.id);
    expect(() => bind(ws)).toThrow(/CONFLICT/);
    expect(() => confirmConnectorBinding(ws.id, { name: "Chosen", mcpUrl: "https://foreign.example.com/mcp", connectorId: "foreign" })).toThrow(/CONFLICT/);
    expect(readLastEndpoint(ws.id)).toEqual(previous);
  });

  it("retains legacy binding/name and tracks address changes until confirmation", () => {
    const ws = new Workspace(root);
    writeLastEndpoint({ workspaceId: ws.id, port: 1, publicUrl: "https://old.example.com", mcpUrl: "https://old.example.com/mcp" });
    persistWorkspaceEndpoint({ workspaceId: ws.id, workspaceName: "Renamed", port: 2, publicUrl: "https://new.example.com", mcpUrl: "https://new.example.com/mcp" });
    expect(connectorReconciliation(readLastEndpoint(ws.id))).toMatchObject({ needed: true, connectorName: "Codex with ChatGPT", previousMcpUrl: "https://old.example.com/mcp" });
  });
});

describe("disconnect and ownership-checked destroy", () => {
  it("disconnect revokes tokens but retains resource and session state", async () => {
    const ws = endpoint(); bind(ws); const { saved } = resources(ws);
    const auth = new AuthStore(ws.id);
    const issued = auth.issueTokens({ clientId: "test", scopes: ["workspace.read"] });
    write(state, `sessions/${ws.id}.json`, JSON.stringify({ url: "https://chatgpt.com/c/saved" }));
    await disconnectWorkspace(root);
    expect(new AuthStore(ws.id).verifyAccessToken(issued.accessToken).ok).toBe(false);
    expect(readLastEndpoint(ws.id)).toMatchObject({ connectorName: "Original", disconnected: true });
    expect(readTunnelState(ws.id)).toEqual(saved);
    expect(fs.existsSync(path.join(state, "sessions", `${ws.id}.json`))).toBe(true);
  });

  it("records an intentional disconnect even before an endpoint was saved", async () => {
    const ws = new Workspace(root);
    await disconnectWorkspace(root);
    expect(readLastEndpoint(ws.id)).toMatchObject({ disconnected: true, bindingVersion: 1, boundMcpUrl: null });
  });

  it("plans without mutations; refuses missing or wrong connector receipts", async () => {
    const ws = endpoint(); bind(ws); const { account } = resources(ws);
    const result = await destroyWorkspace(root, { account });
    expect(result.destroyed).toBe(false);
    await expect(destroyWorkspace(root, { account, confirm: true, connectorRemoved: "plugin_foreign" })).rejects.toThrow(/CONNECTOR_REMOVAL_REQUIRED/);
    expect(account.deleteDns).not.toHaveBeenCalled();
    expect(account.deleteTunnel).not.toHaveBeenCalled();
    expect(fs.existsSync(lifecycleFile(ws.id))).toBe(false);
  });

  it("refuses foreign DNS or tunnel bindings before deleting anything", async () => {
    const ws = endpoint(); bind(ws); const { account } = resources(ws);
    account.dns.mockResolvedValueOnce({ id: "record-foreign", name: "code.example.com", type: "CNAME", content: "foreign.cfargotunnel.com" });
    await expect(destroyWorkspace(root, { account, confirm: true, connectorRemoved: "plugin_owned" })).rejects.toThrow(/OWNERSHIP_CONFLICT/);
    account.listTunnels.mockResolvedValueOnce([{ id: "id-foreign", name: "owned" }]);
    await expect(destroyWorkspace(root, { account, confirm: true, connectorRemoved: "plugin_owned" })).rejects.toThrow(/OWNERSHIP_CONFLICT/);
    expect(account.deleteDns).not.toHaveBeenCalled();
    expect(readLastEndpoint(ws.id)).not.toBeNull();
  });

  it("keeps retry receipts/state on failure and cleans only this workspace after retry", async () => {
    const ws = endpoint(); bind(ws); const { account } = resources(ws);
    write(state, "endpoints/other.json", JSON.stringify({ workspaceId: "other" }));
    write(root, ".c2c.json", JSON.stringify({ name: "Keep configuration" }));
    account.deleteTunnel.mockRejectedValueOnce(new Error("active connections"));
    await expect(destroyWorkspace(root, { account, confirm: true, connectorRemoved: "plugin_owned" })).rejects.toThrow(/active connections/);
    expect(readLastEndpoint(ws.id)).not.toBeNull();
    expect(fs.existsSync(lifecycleFile(ws.id))).toBe(true);
    const result = await destroyWorkspace(root, { account, confirm: true });
    expect(result.destroyed).toBe(true);
    expect(account.deleteDns.mock.invocationCallOrder[0]).toBeLessThan(account.deleteTunnel.mock.invocationCallOrder[0]);
    expect(readLastEndpoint(ws.id)).toBeNull();
    expect(readTunnelState(ws.id).preference).toBe("unset");
    expect(fs.existsSync(path.join(state, "endpoints/other.json"))).toBe(true);
    expect(fs.existsSync(path.join(root, ".c2c.json"))).toBe(true);
  });

  it("resumes a destroy receipt after partial local cleanup without inventing a new binding", async () => {
    const ws = endpoint(); bind(ws); const { account } = resources(ws);
    account.deleteTunnel.mockRejectedValueOnce(new Error("offline"));
    await expect(destroyWorkspace(root, { account, confirm: true, connectorRemoved: "plugin_owned" })).rejects.toThrow(/offline/);
    fs.rmSync(path.join(state, "endpoints", `${ws.id}.json`));
    account.deleteTunnel.mockRejectedValueOnce(new Error("still offline"));
    await expect(destroyWorkspace(root, { account, confirm: true })).rejects.toThrow(/still offline/);
    expect(readLastEndpoint(ws.id)).toBeNull();
    expect((await destroyWorkspace(root, { account, confirm: true })).destroyed).toBe(true);
  });

  it("refuses to forget a pending desired connector unless its absence is confirmed", async () => {
    const ws = endpoint(); bind(ws); endpoint("Chosen");
    await expect(destroyWorkspace(root, { confirm: true, connectorRemoved: "plugin_owned" })).rejects.toThrow(/unreconciled/);
    expect(readLastEndpoint(ws.id)?.connectorName).toBe("Original");
  });

  it("fails closed on malformed local resource state", async () => {
    const ws = endpoint(); bind(ws);
    write(state, `tunnels/${ws.id}.json`, "{broken");
    await expect(destroyWorkspace(root, { confirm: true, connectorRemoved: "plugin_owned" })).rejects.toThrow(/OWNERSHIP_CONFLICT/);
    expect(readLastEndpoint(ws.id)).not.toBeNull();
  });

  it("serializes workspace lifecycle operations and releases the lock", () => {
    const ws = new Workspace(root);
    const release = acquireWorkspaceLock(ws.id);
    expect(() => acquireWorkspaceLock(ws.id)).toThrow(/LIFECYCLE_BUSY/);
    release();
    acquireWorkspaceLock(ws.id)();
  });
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
