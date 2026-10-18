/** Explicit one-shot upgrade boundary. Native stores never call these readers. */
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { Workspace } from "../workspace/manager.js";
import { WorkspaceRegistry, registrySchema, WorkspaceRegistryError } from "../workspace/registry.js";
import { AuthStore, AuthStateError, authSchema, clientSchema, tokenFields, withAuthLock, parseHubAuth, requireUniqueRecords, readAuthJson, canonical } from "../auth/store.js";
import { tunnelSchema } from "../tunnel/state.js";
import { endpointSchema, endpointStateSchema } from "../config/endpoint.js";
import { getStateDir, writeSecureJson } from "../config/paths.js";
import { stateFile } from "../config/state-files.js";
import { resolveHub, withHubControlPlane } from "./store.js";
import { assertAuthHandoffQuiescent } from "./runtime.js";
import { withHubResource } from "./resource-state.js";
function parseMigrationJson(raw: string): unknown {
  try { return JSON.parse(raw); }
  catch { throw new Error("MIGRATION_STATE_INVALID: Local upgrade state is malformed."); }
}
const ownerSchema = z.string().regex(/^[a-f0-9]{12}$/);
export const legacyAuthSchema = z.object({ clients: z.array(clientSchema), tokens: z.array(z.object({ ...tokenFields, workspaceId: ownerSchema }).strict()) }).strict();
export const legacyTunnelSchema = tunnelSchema.omit({ version: true, hubId: true }).extend({ workspaceId: ownerSchema }).strict();
export const legacyEndpointSchema = endpointSchema.omit({ version: true, hubId: true }).extend({ workspaceId: ownerSchema }).strict();
export const legacyRegistrySchema = registrySchema.omit({ version: true, hubId: true }).extend({ version: z.literal(1), ownerWorkspaceId: ownerSchema }).strict();
function translatedAuth(hubId: string, owner: string, raw: unknown) {
  if (raw === undefined)
    return authSchema.parse({ version: 1, hubId, clients: [], tokens: [] });
  try {
    const legacy = legacyAuthSchema.parse(raw);
    requireUniqueRecords(legacy);
    if (legacy.tokens.some((token) => token.workspaceId !== owner))
      throw new Error("Wrong legacy owner");
    return { version: 1 as const, hubId, clients: legacy.clients, tokens: legacy.tokens.map(({ workspaceId: _owner, ...token }) => ({ ...token, hubId })) };
  }
  catch {
    throw new AuthStateError("Legacy auth ownership or format is invalid.");
  }
}
export function adoptLegacyAuth(hubId: string, opts: {
  file?: string;
} = {}): void {
  withHubControlPlane(hubId, ({ hub, authInitialized, completeAuthAdoption }) => {
    const file = opts.file ?? stateFile("auth", `${hubId}.json`);
    withAuthLock(file, () => {
      const current = parseHubAuth(hubId, readAuthJson(file));
      if (authInitialized) {
        if (!current)
          throw new AuthStateError("Initialized Hub auth state is missing.");
        return;
      }
      const source = stateFile("auth", `${hub.legacyOwnerWorkspaceId}.json`);
      withAuthLock(source, () => {
        const raw = readAuthJson(source), expected = translatedAuth(hubId, hub.legacyOwnerWorkspaceId!, raw);
        if (current && canonical(current) !== canonical(expected))
          throw new AuthStateError("Hub and legacy auth stores conflict; merging is forbidden.");
        if (!current)
          writeSecureJson(file, expected);
        if (canonical(readAuthJson(source)) !== canonical(raw))
          throw new AuthStateError("Legacy auth changed during adoption.");
        completeAuthAdoption();
      });
    });
  });
}
export function finalizeAuthHandoff(hubId: string, owner: Workspace, opts: {
  file?: string;
} = {}): void {
  withHubControlPlane(hubId, ({ hub, authHandoffFinalized, completeAuthHandoff }) => {
    if (hub.legacyOwnerWorkspaceId && hub.legacyOwnerWorkspaceId !== owner.id)
      throw new AuthStateError("Legacy owner does not match this Hub.");
    if (authHandoffFinalized)
      return;
    const file = opts.file ?? stateFile("auth", `${hubId}.json`), source = stateFile("auth", `${owner.id}.json`);
    withAuthLock(file, () => withAuthLock(source, () => {
      const current = parseHubAuth(hubId, readAuthJson(file)), raw = readAuthJson(source);
      assertAuthHandoffQuiescent(hub, owner, raw !== undefined);
      if (raw === undefined && current && (current.clients.length || current.tokens.length))
        throw new AuthStateError("Legacy auth source is missing; refusing to discard a populated provisional snapshot.");
      writeSecureJson(file, translatedAuth(hubId, owner.id, raw));
      if (canonical(readAuthJson(source)) !== canonical(raw))
        throw new AuthStateError("Legacy auth changed during finalization.");
      assertAuthHandoffQuiescent(hub, owner, raw !== undefined);
      completeAuthHandoff();
    }));
  });
}
/** Compatibility fixture/API for explicit provisional adoption, never runtime startup. */
export class LegacyAuthSnapshot extends AuthStore {
  constructor(hubId: string, opts: {
    file?: string;
    requireFinalized?: boolean;
  } = {}) {
    adoptLegacyAuth(hubId, opts);
    if (opts.requireFinalized)
      withHubControlPlane(hubId, ({ authHandoffFinalized }) => { if (!authHandoffFinalized)
        throw new Error("AUTH_HANDOFF_REQUIRED: Finalize legacy auth first."); });
    super(hubId, opts);
  }
}
function copyRegistry(hubId: string, owner: string): void {
  const source = stateFile("workspace-registries", `${owner}.json`), file = stateFile("workspace-registries", `${hubId}.json`);
  try {
    withAuthLock(source, () => withAuthLock(file, () => {
      let raw: string | undefined;
      try {
        raw = fs.readFileSync(source, "utf8");
      }
      catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT")
          throw e;
      }
      const legacy = raw === undefined ? { ownerWorkspaceId: owner, workspaces: [] } : legacyRegistrySchema.parse(JSON.parse(raw));
      if (legacy.ownerWorkspaceId !== owner)
        throw new Error("Wrong owner");
      const expected = { version: 2, hubId, workspaces: legacy.workspaces.sort((a, b) => a.alias.localeCompare(b.alias)) };
      if (new Set(legacy.workspaces.map(e => e.workspaceId)).size !== legacy.workspaces.length || new Set(legacy.workspaces.map(e => e.alias)).size !== legacy.workspaces.length)
        throw new Error("Duplicate registrations");
      if (fs.existsSync(file)) {
        if (canonical(JSON.parse(fs.readFileSync(file, "utf8"))) !== canonical(expected))
          throw new Error("Hub registry conflicts with pending legacy adoption.");
      }
      else
        writeSecureJson(file, expected);
      if (raw !== undefined && fs.readFileSync(source, "utf8") !== raw)
        throw new Error("Legacy registry changed");
    }));
  }
  catch (error) {
    throw new WorkspaceRegistryError(String(error).includes("lock") ? "WORKSPACE_REGISTRY_BUSY" : "WORKSPACE_REGISTRY_INVALID", String(error));
  }
}
export class LegacyWorkspaceRegistry extends WorkspaceRegistry {
  static forWorkspace(owner: Workspace): WorkspaceRegistry {
    const hub = resolveHub(owner, (hub) => copyRegistry(hub.hubId, owner.id));
    return new WorkspaceRegistry(hub.hubId);
  }
}
export function adoptLegacyTunnel(hubId: string) {
  return withHubResource(hubId, "tunnel", tunnelSchema, legacyTunnelSchema, { version: 1 as const, hubId, preference: "unset" as const }, current => current);
}
export function adoptLegacyEndpoint(hubId: string) {
  return withHubResource(hubId, "endpoint", endpointStateSchema, legacyEndpointSchema, { version: 1 as const, hubId, empty: true as const }, current => "empty" in current ? null : current);
}
export function adoptLegacyWorkspace(root: string) {
  const owner = new Workspace(root), registry = LegacyWorkspaceRegistry.forWorkspace(owner), hub = resolveHub(owner);
  adoptLegacyAuth(hub.hubId);
  adoptLegacyTunnel(hub.hubId);
  adoptLegacyEndpoint(hub.hubId);
  return { hub, registry };
}
export function hasLegacyInstall(): boolean {
  return ["auth", "runtime", "tunnels", "endpoints", "workspace-registries"].some(directory => {
    const folder = path.dirname(stateFile(directory, ".lock"));
    try {
      return fs.readdirSync(folder).some(name => /^[a-f0-9]{12}\.json$/.test(name));
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return false;
      throw error;
    }
  });
}
/** Explicit process handoff preserves the verified shutdown record across retries. */
export async function handoffLegacyWorkspace(root: string): Promise<string> {
  const { hub } = adoptLegacyWorkspace(root), owner = new Workspace(root);
  const finalized = withHubControlPlane(hub.hubId, ({ authHandoffFinalized }) => authHandoffFinalized);
  if (finalized)
    return hub.hubId;
  const { acquireHubLock } = await import("../lifecycle/hub.js");
  const release = acquireHubLock(hub.hubId);
  try {
    const { findBridgeObservation, probeBridge } = await import("./runtime.js");
    const { adminFetch } = await import("../process/daemon.js");
    const proofFile = stateFile("migrations", `${owner.id}.runtime.json`);
    const runtimeFile = stateFile("runtime", `${owner.id}.json`);
    if (!fs.existsSync(runtimeFile) && fs.existsSync(proofFile)) {
      const proof = z.object({ hubId: z.literal(hub.hubId), owner: z.literal(owner.id), contents: z.string() }).strict().parse(parseMigrationJson(fs.readFileSync(proofFile, "utf8")));
      const old = z.object({ workspaceId: z.literal(owner.id), workspaceRoot: z.literal(owner.root), pid: z.number().int().positive() }).passthrough().parse(parseMigrationJson(proof.contents));
      try {
        process.kill(old.pid, 0);
        throw new Error("AUTH_HANDOFF_BUSY: The recorded writer may still be active.");
      }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH")
          throw error;
      }
      fs.writeFileSync(runtimeFile, proof.contents, { mode: 0o600, flag: "wx" });
    }
    const observed = await findBridgeObservation(hub.hubId);
    if (observed.state === "unknown" || observed.state === "healthy" && observed.runtime.hubId)
      throw new Error("AUTH_HANDOFF_BUSY: Refusing an uncertain or Hub-owned writer.");
    if (observed.state === "healthy") {
      const health = await probeBridge(observed.runtime.port);
      if (!health || health.hubId || health.workspaceId !== owner.id)
        throw new Error("AUTH_HANDOFF_BUSY: Shutdown requires verified legacy health, never a native Hub.");
      const contents = fs.readFileSync(runtimeFile, "utf8");
      writeSecureJson(proofFile, { hubId: hub.hubId, owner: owner.id, contents });
      await adminFetch(observed.runtime, "POST", "/admin/shutdown", 5000);
      let stopped = false;
      for (let n = 0; n < 100; n++) {
        try {
          process.kill(observed.runtime.pid, 0);
        }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH")
            throw error;
          stopped = true;
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      if (!stopped)
        throw new Error("AUTH_HANDOFF_BUSY: Legacy shutdown was not confirmed.");
      if (!fs.existsSync(runtimeFile))
        fs.writeFileSync(runtimeFile, contents, { mode: 0o600, flag: "wx" });
      if (fs.readFileSync(runtimeFile, "utf8") !== contents)
        throw new Error("AUTH_STATE_CONFLICT: Shutdown record changed.");
    }
    finalizeAuthHandoff(hub.hubId, owner);
    return hub.hubId;
  }
  finally {
    release();
  }
}
