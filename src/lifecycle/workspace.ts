import fs from "node:fs";
import path from "node:path";
import { resolveHub } from "../hub/store.js";
import { Workspace } from "../workspace/manager.js";
import { AuthStore } from "../auth/store.js";
import { adminFetch } from "../process/daemon.js";
import { findBridgeObservation } from "../bridge/runtime.js";
import { boundConnector, readLastEndpoint as readHubEndpoint, writeLastEndpoint, connectorReconciliation,
  readLegacyEndpoint as readLastEndpoint, legacyEndpointFile as endpointFile, connectorNameFor } from "../config/endpoint.js";
import { ensureDir, getStateDir, readJsonIfExists, writeSecureJson } from "../config/paths.js";
import { readLegacyTunnelState as readTunnelState, legacyTunnelStateFile as tunnelStateFile } from "../tunnel/state.js";
import { ProcessCloudflaredAccount, type CloudflaredAccount } from "../tunnel/named-provision.js";
import { assertDnsOwnership } from "../tunnel/cloudflare-api.js";

export function lifecycleFile(id: string): string {
  return path.join(getStateDir(), "lifecycle", `${id}.json`);
}

/** CLI operations serialize per canonical workspace. Stale locks fail closed. */
export function acquireWorkspaceLock(id: string): () => void {
  const file = path.join(ensureDir(path.join(getStateDir(), "locks")), `${id}.lock`);
  let fd: number;
  try { fd = fs.openSync(file, "wx", 0o600); }
  catch { throw new Error(`LIFECYCLE_BUSY: Another operation holds ${file}. After a crash, verify that process is gone before removing its lock.`); }
  fs.writeFileSync(fd, String(process.pid));
  return () => { fs.closeSync(fd); fs.rmSync(file, { force: true }); };
}

export async function disconnectWorkspace(root: string, opts: { remember?: boolean } = {}): Promise<void> {
  const workspace = new Workspace(root);
  const hub = resolveHub(workspace);
  const observed = await findBridgeObservation(hub.hubId);
  const endpoint = opts.remember === false ? null : readHubEndpoint(hub.hubId);
  if (endpoint && endpoint.hubId !== hub.hubId) throw new Error("OWNERSHIP_CONFLICT: Endpoint belongs to another Hub.");
  const disconnected = endpoint ?? {
    hubId: hub.hubId, port: observed.runtime?.port ?? 0,
    publicUrl: observed.runtime?.publicUrl ?? null,
    mcpUrl: observed.runtime?.publicUrl ? `${observed.runtime.publicUrl}/mcp` : null,
    desiredConnectorName: connectorNameFor({ workspaceId: hub.hubId, workspaceName: hub.displayName, hadEndpointBefore: false }),
    bindingVersion: 1 as const, boundMcpUrl: null,
  };
  if (observed.state === "unknown") throw new Error("LIFECYCLE_BUSY: Cannot verify the running bridge; access state was retained.");
  if (observed.state === "healthy") {
    if (observed.runtime.workspaceRoot !== workspace.root || observed.runtime.workspaceId !== workspace.id) throw new Error("OWNERSHIP_CONFLICT: Runtime belongs to another root.");
    await adminFetch(observed.runtime, "POST", "/admin/revoke-all");
    if (opts.remember !== false) writeLastEndpoint({ ...disconnected, disconnected: true });
    await adminFetch(observed.runtime, "POST", "/admin/shutdown", 5000);
    for (let n = 0; n < 50; n++) {
      if ((await findBridgeObservation(hub.hubId)).state === "stopped") return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("LIFECYCLE_BUSY: Bridge shutdown is not confirmed; no resources were deleted.");
  }
  new AuthStore(hub.hubId).revokeAll();
  if (opts.remember !== false) writeLastEndpoint({ ...disconnected, disconnected: true });
}

interface DestroyPlan {
  workspaceId: string;
  workspaceRoot: string;
  connector: ReturnType<typeof boundConnector>;
  desired: ReturnType<typeof connectorReconciliation>;
  tunnel: { id: string; name?: string; hostname?: string; zone?: string } | null;
}

/** Plan is read-only. Removal receipts come from the Skill after exact plugin
 * ID/name/Server URL checks and ChatGPT-side deletion. No private web API. */
export async function destroyWorkspace(root: string, opts: {
  confirm?: boolean; connectorRemoved?: string; desiredConnectorAbsent?: boolean; account?: CloudflaredAccount;
} = {}) {
  const workspace = new Workspace(root);
  const endpoint = readLastEndpoint(workspace.id);
  const tunnel = readTunnelState(workspace.id);
  for (const file of [endpointFile(workspace.id), tunnelStateFile(workspace.id), lifecycleFile(workspace.id)]) {
    if (fs.existsSync(file)) {
      const raw = readJsonIfExists<{ workspaceId?: string }>(file);
      if (!raw || raw.workspaceId !== workspace.id) throw new Error("OWNERSHIP_CONFLICT: Persisted lifecycle state is unreadable or belongs to another workspace.");
    }
  }
  if ((endpoint && endpoint.workspaceId !== workspace.id) || tunnel.workspaceId !== workspace.id) throw new Error("OWNERSHIP_CONFLICT: Local resource binding has a different workspace ID.");
  if (tunnel.pending) throw new Error("TUNNEL_ROLLBACK_PENDING: Recover the pending operation before destroy.");
  const receipt = readJsonIfExists<DestroyPlan>(lifecycleFile(workspace.id));
  if (receipt && (receipt.workspaceId !== workspace.id || receipt.workspaceRoot !== workspace.root)) throw new Error("OWNERSHIP_CONFLICT: Destroy receipt belongs to another root.");
  const connector = boundConnector(endpoint);
  const plan: DestroyPlan = receipt ?? { workspaceId: workspace.id, workspaceRoot: workspace.root, connector,
    desired: connectorReconciliation(endpoint),
    tunnel: tunnel.tunnelId ? { id: tunnel.tunnelId, name: tunnel.tunnelName, hostname: tunnel.hostname, zone: tunnel.zone } : null };
  if (receipt) {
    const changedEndpoint = endpoint && (JSON.stringify(receipt.connector) !== JSON.stringify(connector) ||
      receipt.desired.connectorName !== connectorReconciliation(endpoint).connectorName || receipt.desired.mcpUrl !== endpoint.mcpUrl);
    const changedTunnel = tunnel.tunnelId && (tunnel.tunnelId !== receipt.tunnel?.id || tunnel.tunnelName !== receipt.tunnel.name);
    if (changedEndpoint || changedTunnel) throw new Error("OWNERSHIP_CONFLICT: Resource binding changed during destroy.");
  }
  const account = opts.account ?? new ProcessCloudflaredAccount();
  if (plan.tunnel) {
    if (!plan.tunnel.name || !plan.tunnel.zone || !plan.tunnel.hostname) throw new Error("OWNERSHIP_CONFLICT: Saved tunnel binding is incomplete; restore it before destroy.");
    const rows = await account.listTunnels();
    const current = rows.find((row) => row.id === plan.tunnel!.id);
    if ((current && current.name !== plan.tunnel.name) || rows.some((row) => row.name === plan.tunnel!.name && row.id !== plan.tunnel!.id)) throw new Error("OWNERSHIP_CONFLICT: Cloudflare tunnel ID/name changed.");
    const dns = await account.dns(plan.tunnel.zone, plan.tunnel.hostname);
    if (dns) assertDnsOwnership(dns, plan.tunnel.id);
  }
  if (!opts.confirm) return { ok: true, destroyed: false, plan };
  if (!receipt && connector && (!connector.id || opts.connectorRemoved !== connector.id)) {
    throw new Error("CONNECTOR_REMOVAL_REQUIRED: Verify the bound plugin ID/name/Server URL in ChatGPT, delete that plugin, then pass --connector-removed <id>. Legacy bindings need connector bind first.");
  }
  if (!receipt && plan.desired.needed && plan.desired.mcpUrl && !opts.desiredConnectorAbsent) {
    throw new Error("CONNECTOR_REMOVAL_REQUIRED: A desired binding is unreconciled. Verify no plugin for its exact name/Server URL remains, then pass --desired-connector-absent.");
  }
  writeSecureJson(lifecycleFile(workspace.id), plan);
  await disconnectWorkspace(root, { remember: false });
  if (plan.tunnel) {
    await account.deleteDns(plan.tunnel.zone!, plan.tunnel.hostname!, plan.tunnel.id);
    await account.deleteTunnel({ id: plan.tunnel.id, name: plan.tunnel.name! });
  }
  // Remove only workspace-scoped state. Shared settings, account credentials,
  // global logs, ChatGPT history, and repository configuration are retained.
  const stateDir = fs.realpathSync(getStateDir());
  const entries = [
    ["workspaces", `${workspace.id}.json`], ["auth", `${workspace.id}.json`], ["endpoints", `${workspace.id}.json`],
    ["tunnels", `${workspace.id}.json`], ["runtime", `${workspace.id}.json`],
    // Cleanup-only compatibility: legacy workflow data is never read by the bridge.
    ["sessions", `${workspace.id}.json`], ["executions", `${workspace.id}.jsonl`],
    ["execution-outputs", workspace.id], ["logs", `bridge-${workspace.id}.out.log`],
  ];
  const registryEntry = ["workspace-registries", `${workspace.id}.json`];
  // Validate every parent before removing anything locally.
  for (const [dir] of [...entries, registryEntry]) {
    const parent = path.join(stateDir, dir);
    if (fs.existsSync(parent) && fs.realpathSync(parent) !== parent) throw new Error("OWNERSHIP_CONFLICT: Refusing cleanup through a state-directory symlink.");
  }
  for (const entry of entries) fs.rmSync(path.join(stateDir, ...entry), { recursive: true, force: true });
  fs.rmSync(lifecycleFile(workspace.id), { force: true });
  // Remove this owner's read grants last, only after all other local cleanup
  // succeeds. A registry removal failure retains the grants and recovery plan.
  try {
    fs.rmSync(path.join(stateDir, ...registryEntry), { force: true });
  } catch (error) {
    writeSecureJson(lifecycleFile(workspace.id), plan);
    throw error;
  }
  return { ok: true, destroyed: true, plan };
}
