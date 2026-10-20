import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fixtureHub as resolveHub } from "../helpers.js";
import { Workspace } from "../../src/workspace/manager.js";
import { saveWorkspaceDisplayName, workspaceRegistrationFile } from "../../src/config/naming.js";
import { connectorNameFor, persistHubEndpoint, readLastEndpoint, writeLastEndpoint } from "../../src/config/endpoint.js";
import { normalizeTunnelName, provisionNamedTunnel, TunnelNamingConflict, type CloudflaredAccount, type ListedTunnel } from "../../src/tunnel/named-provision.js";
import { readTunnelState, writeTunnelState } from "../../src/tunnel/state.js";
import { cleanup, isolateStateDir, makeTmpDir, write } from "../helpers.js";

describe("runtime naming", () => {
  const dirs: string[] = [];
  let hubId: string;
  const previousStateDir = process.env.C2C_STATE_DIR;
  beforeEach(() => { dirs.push(isolateStateDir()); hubId = resolveHub({ id: "abcdef123456", name: "Demo" }).hubId; });
  afterEach(() => {
    for (const dir of dirs.splice(0)) cleanup(dir);
    if (previousStateDir === undefined) delete process.env.C2C_STATE_DIR;
    else process.env.C2C_STATE_DIR = previousStateDir;
  });

  function accountFixture(initial: ListedTunnel[] = []) {
    const tunnels = [...initial];
    const routes = new Map<string, string>();
    const account = {
      hasCert: () => true,
      login: vi.fn(async () => undefined),
      listTunnels: vi.fn(async () => [...tunnels]),
      createTunnel: vi.fn(async (name: string) => {
        const tunnel = { id: `00000000-0000-4000-8000-${String(tunnels.length + 1).padStart(12, "0")}`, name };
        tunnels.push(tunnel);
        return tunnel;
      }),
      routeDns: vi.fn(async (tunnel: string, hostname: string) => { routes.set(hostname, tunnel); }),
      dns: vi.fn(async (_zone: string, hostname: string) => routes.has(hostname) ? { id: hostname, name: hostname, type: "CNAME", content: routes.get(hostname) + ".cfargotunnel.com" } : null),
      deleteDns: vi.fn(async (_zone: string, hostname: string, _id: string) => { routes.delete(hostname); }),
      renameTunnel: vi.fn(async (_zone: string, id: string, _expected: string, name: string) => { tunnels.find((row) => row.id === id)!.name = name; }),
      deleteTunnel: vi.fn(async (tunnel: ListedTunnel) => { const index = tunnels.findIndex((row) => row.id === tunnel.id); if (index >= 0) tunnels.splice(index, 1); }),
    } satisfies CloudflaredAccount;
    return account;
  }

  it("honors an explicit tunnel name and hostname without a hash suffix", async () => {
    const account = accountFixture();
    const result = await provisionNamedTunnel({
      hubId, hubName: "Codex with ChatGPT", zone: "example.com",
      tunnelName: "desk-c2c", hostname: "code.example.com", account,
    });
    expect(result).toMatchObject({ ok: true, fallback: false, state: { tunnelName: "desk-c2c", hostname: "code.example.com" } });
    expect(account.createTunnel).toHaveBeenCalledWith("desk-c2c");
    expect(account.routeDns).toHaveBeenCalledWith(result.state.tunnelId, "code.example.com");
  });

  it("suggests tunnel names from the Hub display name without exposing its ID", async () => {
    const result = await provisionNamedTunnel({
      hubId, hubName: "Demo", zone: "example.com", account: accountFixture(),
    });
    expect(result.state).toMatchObject({ tunnelName: "c2c-demo", hostname: "c2c-demo.example.com" });
  });

  it("reuses persisted names on rerun even after the workspace display name changes", async () => {
    const account = accountFixture();
    const first = await provisionNamedTunnel({
      hubId, hubName: "Original", zone: "example.com",
      tunnelName: "desk-c2c", hostname: "code.example.com", account,
    });
    const rerun = await provisionNamedTunnel({ hubId, hubName: "Renamed Project", account });
    expect(rerun.ok).toBe(true);
    expect(rerun.state).toMatchObject({
      tunnelName: first.state.tunnelName, tunnelId: first.state.tunnelId,
      hostname: first.state.hostname, zone: first.state.zone,
    });
    expect(account.createTunnel).toHaveBeenCalledTimes(1);
    expect(account.routeDns).toHaveBeenCalledTimes(1);
  });

  it("allows explicit names to override saved values without inventing a suffix", async () => {
    const account = accountFixture();
    await provisionNamedTunnel({ hubId, hubName: "Demo", zone: "example.com", account });
    const result = await provisionNamedTunnel({
      hubId, hubName: "Demo", tunnelName: "chosen-tunnel", hostname: "chosen.example.com", account,
    });
    expect(result.state).toMatchObject({ tunnelName: "chosen-tunnel", hostname: "chosen.example.com" });
  });

  it("rejects an existing name without a matching workspace binding and preserves state", async () => {
    const account = accountFixture([{ id: "foreign-resource", name: "desk-c2c" }]);
    const previous = readTunnelState(hubId);
    const result = await provisionNamedTunnel({
      hubId, hubName: "Demo", zone: "example.com", tunnelName: "desk-c2c", account,
    });
    expect(result).toMatchObject({ ok: false, fallback: false, error: expect.stringContaining("TUNNEL_NAMING_CONFLICT") });
    expect(account.createTunnel).not.toHaveBeenCalled();
    expect(account.routeDns).not.toHaveBeenCalled();
    expect(readTunnelState(hubId)).toEqual(previous);
  });

  it("rejects the same name with a different Cloudflare resource ID", async () => {
    const previous = writeTunnelState({
      hubId, preference: "named", tunnelName: "desk-c2c", tunnelId: "expected-resource",
      hostname: "code.example.com", zone: "example.com",
    });
    const result = await provisionNamedTunnel({
      hubId, hubName: "Demo", account: accountFixture([{ id: "foreign-resource", name: "desk-c2c" }]),
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/saved Tunnel ID|Saved tunnel/);
    expect(readTunnelState(hubId)).toEqual(previous);
  });

  it("does not erase persisted names or fall back when repair provisioning fails", async () => {
    const account = accountFixture();
    await provisionNamedTunnel({
      hubId, hubName: "Demo", zone: "example.com", tunnelName: "desk-c2c", hostname: "code.example.com", account,
    });
    const previous = readTunnelState(hubId);
    account.listTunnels.mockRejectedValueOnce(new Error("Account unavailable"));
    const result = await provisionNamedTunnel({ hubId, hubName: "Demo", account });
    expect(result).toMatchObject({ ok: false, fallback: false, error: "Account unavailable" });
    expect(readTunnelState(hubId)).toEqual(previous);
  });

  it("reports DNS conflicts instead of claiming a chosen hostname was applied", async () => {
    const account = accountFixture();
    account.routeDns.mockRejectedValueOnce(new TunnelNamingConflict("Hostname already has a different route"));
    const result = await provisionNamedTunnel({
      hubId, hubName: "Demo", zone: "example.com", tunnelName: "desk-c2c", hostname: "code.example.com", account,
    });
    expect(result).toMatchObject({ ok: false, fallback: false, error: expect.stringContaining("Hostname") });
    expect(readTunnelState(hubId).preference).toBe("unset");
  });

  it("renames in place and rolls back both names when routing fails", async () => {
    const account = accountFixture();
    const first = await provisionNamedTunnel({ hubId, hubName: "Demo", zone: "example.com", account });
    account.routeDns.mockRejectedValueOnce(new Error("DNS failed"));
    const failed = await provisionNamedTunnel({ hubId, hubName: "Demo", tunnelName: "renamed", hostname: "new.example.com", account });
    expect(failed.ok).toBe(false);
    expect(readTunnelState(hubId)).toEqual(first.state);
    expect(await account.listTunnels()).toEqual([{ id: first.state.tunnelId, name: first.state.tunnelName }]);
    expect(account.createTunnel).toHaveBeenCalledTimes(1);
    expect(await account.dns("example.com", "new.example.com")).toBeNull();
  });

  it("cleans the old hostname only after routing the new one", async () => {
    const account = accountFixture();
    const first = await provisionNamedTunnel({ hubId, hubName: "Demo", zone: "example.com", account });
    const next = await provisionNamedTunnel({ hubId, hubName: "Demo", hostname: "new.example.com", account });
    expect(next.ok).toBe(true);
    expect(next.state.tunnelId).toBe(first.state.tunnelId);
    expect(account.deleteDns).toHaveBeenCalledWith("example.com", first.state.hostname, first.state.tunnelId);
    expect(await account.dns("example.com", first.state.hostname!)).toBeNull();
    expect(await account.dns("example.com", "new.example.com")).not.toBeNull();
  });

  it("keeps a recoverable journal when rollback fails and retries cleanup first", async () => {
    const account = accountFixture();
    account.routeDns.mockRejectedValueOnce(new Error("DNS timed out"));
    account.deleteDns.mockRejectedValueOnce(new Error("cleanup offline"));
    const failed = await provisionNamedTunnel({ hubId, hubName: "Demo", zone: "example.com", tunnelName: "chosen", account });
    expect(failed.error).toContain("TUNNEL_ROLLBACK_PENDING");
    expect(readTunnelState(hubId).pending?.tunnelId).toBeTruthy();
    const retry = await provisionNamedTunnel({ hubId, hubName: "Demo", zone: "example.com", tunnelName: "chosen", account });
    expect(retry.ok).toBe(true);
    expect(account.deleteTunnel).toHaveBeenCalledTimes(1);
    expect(readTunnelState(hubId).pending).toBeUndefined();
    expect(await account.listTunnels()).toHaveLength(1);
  });

  it("rolls back a partially deleted old DNS route when cleanup reports failure", async () => {
    const account = accountFixture();
    const first = await provisionNamedTunnel({ hubId, hubName: "Demo", zone: "example.com", account });
    const remove = account.deleteDns.getMockImplementation()!;
    account.deleteDns.mockImplementationOnce(async (...args) => { await remove(...args); throw new Error("delete response lost"); });
    const next = await provisionNamedTunnel({ hubId, hubName: "Demo", hostname: "new.example.com", account });
    expect(next.ok).toBe(false);
    expect(readTunnelState(hubId)).toEqual(first.state);
    expect(await account.dns("example.com", first.state.hostname!)).not.toBeNull();
    expect(await account.dns("example.com", "new.example.com")).toBeNull();
  });

  it("validates empty, control-character, option-like and oversized names", () => {
    for (const name of [" ", "bad\nname", "--other-option", "a".repeat(129)]) {
      expect(() => normalizeTunnelName(name)).toThrow(/INVALID_NAME/);
    }
    expect(() => connectorNameFor({ hubName: "Demo", explicitName: " " })).toThrow(/INVALID_NAME/);
  });

  it("preserves a legacy connector name across setup, display changes and endpoint repair", () => {
    const endpoint = { hubId, hubName: "Demo", port: 1234, publicUrl: null, mcpUrl: null };
    expect(persistHubEndpoint({ ...endpoint, connectorName: "Desk C2C Hub" })).toBe("Desk C2C Hub");
    expect(persistHubEndpoint({ ...endpoint, hubName: "Changed" })).toBe("Desk C2C Hub");
    expect(persistHubEndpoint({ ...endpoint, publicUrl: "https://new.example.com", mcpUrl: "https://new.example.com/mcp" })).toBe("Desk C2C Hub");
    expect(readLastEndpoint(hubId)?.desiredConnectorName).toBe("Desk C2C Hub");
    expect(persistHubEndpoint({ ...endpoint, connectorName: "Explicit Replacement" })).toBe("Explicit Replacement");
  });

  it("preserves canonical identity when changing an external display name", () => {
    const root = makeTmpDir("display-name");
    dirs.push(root);
    const original = new Workspace(root);
    saveWorkspaceDisplayName(original, "Codex with ChatGPT");
    const renamed = new Workspace(root);
    expect(renamed.name).toBe("Codex with ChatGPT");
    expect(renamed.id).toBe(original.id);
    expect(renamed.root).toBe(original.root);
    expect(fs.readdirSync(root)).toEqual([]);
    expect(JSON.parse(fs.readFileSync(workspaceRegistrationFile(original.id), "utf8"))).toMatchObject({ workspaceId: original.id, workspaceRoot: original.root, displayName: "Codex with ChatGPT" });
  });
});
