import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import { hubIdSchema, hubFile, resolveHub } from "../hub/store.js";
import { AuthStore, parseHubAuth } from "../auth/store.js";
import { adminFetch } from "../process/daemon.js";
import { findBridgeObservation } from "../bridge/runtime.js";
import { boundConnector, readLastEndpoint, writeLastEndpoint, connectorReconciliation } from "../config/endpoint.js";
import { ensureDir, writeSecureJson } from "../config/paths.js";
import { stateFile } from "../config/state-files.js";
import { readTunnelState } from "../tunnel/state.js";
import { registrySchema } from "../workspace/registry.js";
import { ProcessCloudflaredAccount, type CloudflaredAccount } from "../tunnel/named-provision.js";
import { assertDnsOwnership } from "../tunnel/cloudflare-api.js";
import { inspectProjectBindings, removeProjectBindings } from "../project/state.js";
function localJson(file: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch { throw new Error("OWNERSHIP_CONFLICT: Local Hub state is unreadable or malformed."); }
}
export function lifecycleFile(hubId: string): string { hubIdSchema.parse(hubId); return stateFile("lifecycle", `${hubId}.json`); }
export function acquireHubLock(hubId: string): () => void {
  hubIdSchema.parse(hubId);
  const file = stateFile("locks", `${hubId}.lock`);
  ensureDir(path.dirname(file));
  let fd: number;
  try {
    fd = fs.openSync(file, "wx", 0o600);
  }
  catch {
    throw new Error("LIFECYCLE_BUSY: Another Hub operation holds the lifecycle lock.");
  }
  fs.writeFileSync(fd, String(process.pid));
  return () => { fs.closeSync(fd); fs.rmSync(file, { force: true }); };
}
async function disconnect(hubId: string, remember: boolean): Promise<void> {
  const hub = resolveHub(hubId), observed = await findBridgeObservation(hubId);
  const endpoint = readLastEndpoint(hubId);
  if (observed.state === "unknown")
    throw new Error("LIFECYCLE_BUSY: Cannot verify the running Hub; access state retained.");
  if (observed.state === "healthy")
    await adminFetch(observed.runtime, "POST", "/admin/revoke-all");
  else
    new AuthStore(hubId).revokeAll();
  if (remember)
    writeLastEndpoint({ ...(endpoint ?? { hubId, port: 0, publicUrl: null, mcpUrl: null, desiredConnectorName: hub.displayName, bindingVersion: 1 as const, boundMcpUrl: null }), disconnected: true });
  if (observed.state === "healthy") {
    await adminFetch(observed.runtime, "POST", "/admin/shutdown", 5000);
    for (let n = 0; n < 50; n++) {
      if ((await findBridgeObservation(hubId)).state === "stopped")
        return;
      await new Promise(r => setTimeout(r, 100));
    }
    throw new Error("LIFECYCLE_BUSY: Hub shutdown is not confirmed.");
  }
}
export async function disconnectHub(hubId: string): Promise<void> {
  const release = acquireHubLock(hubId);
  try {
    await disconnect(hubId, true);
  }
  finally {
    release();
  }
}
const desiredSchema = z.object({ needed: z.boolean(), connectorAction: z.enum(["none", "create", "update"]), connectorName: z.string(), previousConnectorName: z.string().nullable(), connectorId: z.string().nullable(), previousMcpUrl: z.string().nullable(), mcpUrl: z.string().nullable() }).strict();
const planSchema = z.object({ version: z.literal(1), hubId: hubIdSchema,
  connector: z.object({ id: z.string().optional(), name: z.string(), mcpUrl: z.string() }).strict().nullable(), desired: desiredSchema,
  tunnel: z.object({ id: z.string(), name: z.string(), hostname: z.string(), zone: z.string() }).strict().nullable(),
}).strict();
const receiptSchema = z.object({ version: z.literal(1), hubId: hubIdSchema, plan: planSchema,
  accessStopped: z.boolean(), connectorRemoved: z.literal(true), desiredConnectorAbsent: z.boolean(), dnsRemoved: z.boolean(), tunnelRemoved: z.boolean(), localCleanup: z.boolean() }).strict();
export type DestroyPlan = z.infer<typeof planSchema>;
function readReceipt(hubId: string): z.infer<typeof receiptSchema> | null {
  const file = lifecycleFile(hubId);
  if (!fs.existsSync(file))
    return null;
  try {
    const receipt = receiptSchema.parse(localJson(file));
    if (receipt.hubId !== hubId || receipt.plan.hubId !== hubId)
      throw new Error();
    if (receipt.plan.connector && !receipt.plan.connector.id)
      throw new Error();
    if (receipt.plan.desired.needed && receipt.plan.desired.mcpUrl && !receipt.desiredConnectorAbsent)
      throw new Error();
    if (receipt.localCleanup && (!receipt.accessStopped || receipt.plan.tunnel && (!receipt.dnsRemoved || !receipt.tunnelRemoved))) throw new Error();
    if ((receipt.dnsRemoved || receipt.tunnelRemoved) && !receipt.accessStopped) throw new Error();
    if (receipt.tunnelRemoved && !receipt.dnsRemoved) throw new Error();
    return receipt;
  }
  catch {
    throw new Error("OWNERSHIP_CONFLICT: Destroy receipt is malformed or belongs to another Hub.");
  }
}
/** Protect mutation APIs independently of CLI hooks; malformed receipts also fail closed. */
export function assertNoPendingDestroy(hubId: string): void {
  if (readReceipt(hubId)) throw new Error("DESTROY_PENDING: Finish this Hub's destroy before changing Project bindings.");
}
/** Exact resource plan; no ChatGPT APIs or deletion are performed during planning. */
export async function destroyHub(hubId: string, opts: {
  confirm?: boolean;
  connectorRemoved?: string;
  desiredConnectorAbsent?: boolean;
  account?: CloudflaredAccount;
} = {}) {
  const release = acquireHubLock(hubId);
  try {
    let receipt = readReceipt(hubId);
    if (fs.existsSync(hubFile(hubId)))
      resolveHub(hubId);
    else if (!receipt?.localCleanup)
      throw new Error("HUB_NOT_CONFIGURED");
    const endpointFile = stateFile("endpoints", `${hubId}.json`), tunnelFile = stateFile("tunnels", `${hubId}.json`);
    const endpoint = fs.existsSync(endpointFile) ? readLastEndpoint(hubId) : null;
    const tunnel = fs.existsSync(tunnelFile) ? readTunnelState(hubId) : null;
    if (!receipt && (!fs.existsSync(endpointFile) || !tunnel))
      throw new Error("OWNERSHIP_CONFLICT: Authoritative resource state is missing.");
    if (tunnel?.pending)
      throw new Error("TUNNEL_ROLLBACK_PENDING: Recover the operation before destroy.");
    const observed = fs.existsSync(hubFile(hubId)) ? await findBridgeObservation(hubId) : { state: "stopped" };
    if (observed.state === "unknown")
      throw new Error("LIFECYCLE_BUSY: Hub runtime state is uncertain.");
    const proposed = { version: 1 as const, hubId, connector: boundConnector(endpoint), desired: connectorReconciliation(endpoint),
      tunnel: tunnel?.tunnelId ? { id: tunnel.tunnelId, name: tunnel.tunnelName!, hostname: tunnel.hostname!, zone: tunnel.zone! } : null };
    const plan = receipt?.plan ?? planSchema.parse(proposed);
    if (receipt) {
      if (endpoint && (!isDeepStrictEqual(plan.connector, proposed.connector) || !isDeepStrictEqual(plan.desired, proposed.desired)))
        throw new Error("OWNERSHIP_CONFLICT: Connector binding changed during destroy.");
      if (tunnel && !isDeepStrictEqual(plan.tunnel, proposed.tunnel))
        throw new Error("OWNERSHIP_CONFLICT: Tunnel binding changed during destroy.");
    }
    const entries = ["auth", "endpoints", "tunnels", "runtime", "workspace-registries"];
    const paths = entries.map(dir => stateFile(dir, `${hubId}.json`));
    const logs = [stateFile("logs", `bridge-${hubId}.out.log`), stateFile("logs", `bridge-${hubId}.log`)];
    // Preflight containment and ownership before any remote deletion.
    for (let n = 0; n < paths.length; n++)
      if (fs.existsSync(paths[n])) {
        const raw = localJson(paths[n]);
        if (raw.hubId !== hubId)
          throw new Error("OWNERSHIP_CONFLICT: Local state has a foreign Hub owner.");
        if (entries[n] === "auth")
          parseHubAuth(hubId, raw);
        if (entries[n] === "workspace-registries")
          registrySchema.parse(raw);
      }
    inspectProjectBindings(hubId);
    const account = opts.account ?? new ProcessCloudflaredAccount();
    if (plan.tunnel && !(receipt?.dnsRemoved && receipt?.tunnelRemoved)) {
      const rows = await account.listTunnels(), current = rows.find(r => r.id === plan.tunnel!.id);
      if ((current && current.name !== plan.tunnel.name) || rows.some(r => r.name === plan.tunnel!.name && r.id !== plan.tunnel!.id))
        throw new Error("OWNERSHIP_CONFLICT: Cloudflare UUID/name changed.");
      const dns = await account.dns(plan.tunnel.zone, plan.tunnel.hostname);
      if (dns)
        assertDnsOwnership(dns, plan.tunnel.id);
    }
    if (!opts.confirm)
      return { ok: true, destroyed: false, plan };
    if (!receipt && plan.connector && (!plan.connector.id || opts.connectorRemoved !== plan.connector.id))
      throw new Error("CONNECTOR_REMOVAL_REQUIRED: Verify exact plugin ID/name/bound URL and provide its ChatGPT removal receipt.");
    if (!receipt && plan.desired.needed && plan.desired.mcpUrl && !opts.desiredConnectorAbsent)
      throw new Error("CONNECTOR_REMOVAL_REQUIRED: The desired binding is unreconciled; verify its absence explicitly.");
    receipt ??= { version: 1, hubId, plan, accessStopped: false, connectorRemoved: true, desiredConnectorAbsent: opts.desiredConnectorAbsent ?? false, dnsRemoved: false, tunnelRemoved: false, localCleanup: false };
    const save = () => writeSecureJson(lifecycleFile(hubId), receipt!);
    save();
    if (!receipt.accessStopped) {
      await disconnect(hubId, false);
      receipt.accessStopped = true;
      save();
    }
    if (plan.tunnel && !receipt.dnsRemoved) {
      await account.deleteDns(plan.tunnel.zone, plan.tunnel.hostname, plan.tunnel.id);
      receipt.dnsRemoved = true;
      save();
    }
    if (plan.tunnel && !receipt.tunnelRemoved) {
      await account.deleteTunnel({ id: plan.tunnel.id, name: plan.tunnel.name });
      receipt.tunnelRemoved = true;
      save();
    }
    receipt.localCleanup = true;
    save();
    removeProjectBindings(hubId);
    // Registry follows all resource state; the Hub identity is the last product file.
    for (const dir of entries.filter(dir => dir !== "workspace-registries")) {
      const file = stateFile(dir, `${hubId}.json`);
      if (fs.existsSync(file)) {
        const raw = localJson(file);
        if (raw.hubId !== hubId)
          throw new Error("OWNERSHIP_CONFLICT: Local owner changed during cleanup.");
        fs.rmSync(file, { force: true });
      }
    }
    for (const log of logs)
      fs.rmSync(log, { force: true });
    fs.rmSync(stateFile("workspace-registries", `${hubId}.json`), { force: true });
    fs.rmSync(hubFile(hubId), { force: true });
    fs.rmSync(lifecycleFile(hubId), { force: true });
    return { ok: true, destroyed: true, plan };
  }
  finally {
    release();
  }
}
