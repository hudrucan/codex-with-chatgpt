import fs from "node:fs";
import { createHash } from "node:crypto";
import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import { hubFile, hubIdSchema, readConfiguredHub, withHubLock } from "../hub/store.js";
import { stateFile } from "../config/state-files.js";
import { writeSecureJson } from "../config/paths.js";
import { authSchema, parseHubAuth, requireUniqueRecords } from "../auth/store.js";
import { tunnelSchema } from "../tunnel/state.js";
import { boundConnector, endpointStateSchema } from "../config/endpoint.js";
import { registrySchema } from "../workspace/registry.js";
import { findBridgeObservation } from "../bridge/runtime.js";
import { acquireHubLock } from "../lifecycle/hub.js";
import { readConfiguredHub as readMigrationHub, hubMappingFile, mappingSchema } from "./store.js";
import { legacyAuthSchema, legacyEndpointSchema, legacyRegistrySchema, legacyTunnelSchema } from "./adoption.js";
const ownerSchema = z.string().regex(/^[a-f0-9]{12}$/);
const archiveSchema = z.object({ version: z.literal(1), hubId: hubIdSchema, legacyOwnerWorkspaceId: ownerSchema,
  mapping: mappingSchema, detached: z.boolean() }).strict();
const keys = ["registryInitialized", "authInitialized", "authHandoffFinalized", "tunnelInitialized", "endpointInitialized"] as const;
function json(file: string): unknown {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { throw new Error("MIGRATION_STATE_INVALID: Local migration state is unreadable or malformed."); }
}
function digest(file: string): string { return createHash("sha256").update(fs.readFileSync(file)).digest("hex"); }
function fingerprint(file: string): string | null {
  try { return digest(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
function archiveFile(hubId: string) { hubIdSchema.parse(hubId); return stateFile("migrations", `${hubId}.json`); }
function archive(hubId: string) {
  const file = archiveFile(hubId);
  if (!fs.existsSync(file)) return null;
  const record = archiveSchema.parse(json(file));
  if (record.hubId !== hubId || record.mapping.hubId !== hubId || record.mapping.legacyOwnerWorkspaceId !== record.legacyOwnerWorkspaceId) {
    throw new Error("HUB_MAPPING_CONFLICT: Invalid migration archive.");
  }
  return record;
}
function assertStopped(pid: number): void {
  try { process.kill(pid, 0); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
    throw new Error("HUB_MIGRATION_BUSY: Legacy process state is uncertain.");
  }
  throw new Error("HUB_MIGRATION_BUSY: Legacy runtime is still active.");
}
function validateNative(hubId: string) {
  const files = Object.fromEntries(["auth", "tunnels", "endpoints", "workspace-registries"].map(dir => [dir, stateFile(dir, `${hubId}.json`)]));
  const auth = authSchema.parse(json(files.auth));
  parseHubAuth(hubId, auth);
  requireUniqueRecords(auth);
  const tunnel = tunnelSchema.parse(json(files.tunnels));
  if (tunnel.hubId !== hubId || tunnel.pending)
    throw new Error("TUNNEL_ROLLBACK_PENDING: Detach requires an owned tunnel without rollback.");
  const endpoint = endpointStateSchema.parse(json(files.endpoints)), registry = registrySchema.parse(json(files["workspace-registries"]));
  if (endpoint.hubId !== hubId || registry.hubId !== hubId)
    throw new Error("OWNERSHIP_CONFLICT: Native state belongs to another Hub.");
  if (new Set(registry.workspaces.map(w => w.workspaceId)).size !== registry.workspaces.length || new Set(registry.workspaces.map(w => w.alias)).size !== registry.workspaces.length)
    throw new Error("WORKSPACE_REGISTRY_INVALID: Duplicate grants.");
  return { files, auth, tunnel, endpoint };
}
export async function planDetach(hubId: string) {
  const hub = readConfiguredHub(hubId), saved = archive(hubId), owner = hub.legacyOwnerWorkspaceId ?? saved?.legacyOwnerWorkspaceId;
  if (!owner)
    throw new Error("HUB_MIGRATION_REQUIRED: This native Hub has no legacy owner to detach.");
  const inputs = [hubFile(hubId), archiveFile(hubId), hubMappingFile(owner),
    ...["auth", "tunnels", "endpoints", "workspace-registries", "runtime"].map(dir => stateFile(dir, `${hubId}.json`)),
    stateFile("runtime", `${owner}.json`)];
  const fingerprints = Object.fromEntries(inputs.map(file => [file, fingerprint(file)]));
  if (hub.legacyOwnerWorkspaceId)
    readMigrationHub(hubId);
  const mapping = saved?.mapping ?? mappingSchema.parse(json(hubMappingFile(owner)));
  if (mapping.hubId !== hubId || mapping.legacyOwnerWorkspaceId !== owner || !keys.every(key => mapping[key] === true))
    throw new Error("HUB_MIGRATION_INCOMPLETE: Every adoption and auth handoff checkpoint must be complete.");
  const native = validateNative(hubId), runtime = await findBridgeObservation(hubId);
  if (runtime.state === "unknown")
    throw new Error("HUB_MIGRATION_BUSY: Hub runtime state is uncertain.");
  const legacyFile = stateFile("runtime", `${owner}.json`);
  if (fs.existsSync(legacyFile)) {
    const old = z.object({ workspaceId: ownerSchema, pid: z.number().int().positive(), hubId: z.never().optional() }).passthrough().parse(json(legacyFile));
    if (old.workspaceId !== owner)
      throw new Error("OWNERSHIP_CONFLICT: Foreign legacy runtime.");
    assertStopped(old.pid);
  }
  for (const [file, hash] of Object.entries(fingerprints)) {
    if (fingerprint(file) !== hash) throw new Error("HUB_MIGRATION_BUSY: State changed during detach validation.");
  }
  return { hubId, legacyOwnerWorkspaceId: owner, eligible: true, detached: !hub.legacyOwnerWorkspaceId && saved?.detached === true,
    checkpoints: Object.fromEntries(keys.map(key => [key, true])), runtime: runtime.state,
    fingerprints, mapping };
}
export async function detachHub(hubId: string, confirm = false) {
  const release = acquireHubLock(hubId);
  try {
    const plan = await planDetach(hubId);
    if (!confirm || plan.detached)
      return plan;
    return withHubLock(() => {
      for (const [file, hash] of Object.entries(plan.fingerprints))
        if (fingerprint(file) !== hash)
          throw new Error("HUB_MIGRATION_BUSY: State changed after detach planning.");
      const hub = readConfiguredHub(hubId), saved = archive(hubId);
      const record = { version: 1 as const, hubId, legacyOwnerWorkspaceId: plan.legacyOwnerWorkspaceId, mapping: plan.mapping, detached: false };
      if (!saved)
        writeSecureJson(archiveFile(hubId), record);
      const { legacyOwnerWorkspaceId: _owner, ...native } = hub;
      writeSecureJson(hubFile(hubId), native);
      writeSecureJson(archiveFile(hubId), { ...record, detached: true });
      return { ...plan, detached: true };
    });
  }
  finally {
    release();
  }
}
/** Only exact owner files with validated native authority can enter the delete list. */
export async function legacyCleanup(hubId: string, confirm = false) {
  const release = acquireHubLock(hubId);
  try {
    const detach = await planDetach(hubId), owner = detach.legacyOwnerWorkspaceId, native = validateNative(hubId);
    const files: {
      file: string;
      sha256: string;
      bytes: number;
    }[] = [];
    const add = (file: string) => files.push({ file, sha256: digest(file), bytes: fs.statSync(file).size });
    for (const dir of ["auth", "endpoints", "tunnels", "workspace-registries", "runtime"]) {
      const file = stateFile(dir, `${owner}.json`);
      if (!fs.existsSync(file))
        continue;
      const raw = json(file);
      if (dir === "auth") {
        const old = legacyAuthSchema.parse(raw);
        requireUniqueRecords(old);
        if (old.tokens.some(token => token.workspaceId !== owner) || old.clients.some(client => !native.auth.clients.some(current => JSON.stringify(current) === JSON.stringify(client))))
          throw new Error("OWNERSHIP_CONFLICT: Legacy auth owner or client registrations cannot be verified.");
      }
      else if (dir === "workspace-registries") {
        const old = legacyRegistrySchema.parse(raw);
        if (old.ownerWorkspaceId !== owner)
          throw new Error("OWNERSHIP_CONFLICT: Foreign legacy registry.");
      }
      else if (dir === "endpoints" || dir === "tunnels") {
        if (dir === "endpoints") {
          const old = legacyEndpointSchema.parse(raw);
          const authoritative = "empty" in native.endpoint ? null : native.endpoint;
          if (old.workspaceId !== owner || !isDeepStrictEqual(boundConnector(old), boundConnector(authoritative))) {
            throw new Error("OWNERSHIP_CONFLICT: Legacy connector binding does not match Hub authority.");
          }
        } else {
          const old = legacyTunnelSchema.parse(raw);
          if (old.workspaceId !== owner || old.tunnelId !== native.tunnel.tunnelId || old.tunnelName !== native.tunnel.tunnelName || old.hostname !== native.tunnel.hostname || old.zone !== native.tunnel.zone || old.pending) {
            throw new Error("OWNERSHIP_CONFLICT: Legacy tunnel binding does not match Hub authority.");
          }
        }
      }
      else {
        const old = z.object({ workspaceId: ownerSchema, pid: z.number().int().positive(), hubId: z.never().optional() }).passthrough().parse(raw);
        if (old.workspaceId !== owner)
          throw new Error("OWNERSHIP_CONFLICT: Foreign legacy runtime.");
        assertStopped(old.pid);
      }
      add(file);
    }
    const mappingFile = hubMappingFile(owner);
    if (fs.existsSync(mappingFile)) {
      const current = mappingSchema.parse(json(mappingFile));
      if (JSON.stringify(current) !== JSON.stringify(detach.mapping))
        throw new Error("HUB_MAPPING_CONFLICT: Legacy mapping changed.");
      add(mappingFile);
    }
    const proofFile = stateFile("migrations", `${owner}.runtime.json`);
    if (fs.existsSync(proofFile)) {
      const proof = z.object({ hubId: z.literal(hubId), owner: z.literal(owner), contents: z.string() }).strict().parse(json(proofFile));
      const old = z.object({ workspaceId: z.literal(owner), pid: z.number().int().positive() }).passthrough().parse(JSON.parse(proof.contents));
      assertStopped(old.pid);
      add(proofFile);
    }
    const retained: {
      file: string;
      reason: string;
    }[] = [];
    const log = stateFile("logs", `bridge-${owner}.out.log`);
    if (fs.existsSync(log)) {
      if (fs.readFileSync(log, "utf8").includes(`(${owner})`))
        add(log);
      else
        retained.push({ file: log, reason: "No verifiable owner marker" });
    }
    for (const [dir, name] of [["sessions", `${owner}.json`], ["executions", `${owner}.jsonl`], ["execution-outputs", owner]]) {
      const file = stateFile(dir, name);
      if (fs.existsSync(file))
        retained.push({ file, reason: "Retired data has no verified per-file ownership contract" });
    }
    const plan = { hubId, legacyOwnerWorkspaceId: owner, eligible: detach.detached, requiresDetach: !detach.detached, files, retained, remoteMutations: 0 };
    if (!confirm)
      return { ...plan, cleaned: false };
    if (!detach.detached)
      throw new Error("HUB_MIGRATION_REQUIRED: Confirm detach before legacy cleanup.");
    return withHubLock(() => {
      // Revalidate the complete plan before the first deletion, including containment.
      for (const item of files) {
        const parts = item.file.split(/[\\/]/);
        stateFile(parts.at(-2)!, parts.at(-1)!);
        if (digest(item.file) !== item.sha256)
          throw new Error("OWNERSHIP_CONFLICT: Cleanup source changed after planning.");
      }
      validateNative(hubId);
      for (const item of files) {
        const parts = item.file.split(/[\\/]/);
        stateFile(parts.at(-2)!, parts.at(-1)!);
        if (digest(item.file) !== item.sha256)
          throw new Error("OWNERSHIP_CONFLICT: Cleanup source changed before deletion.");
        validateNative(hubId);
        if (readConfiguredHub(hubId).legacyOwnerWorkspaceId) throw new Error("HUB_MIGRATION_REQUIRED: Cleanup requires a detached Hub.");
        const legacyRuntime = stateFile("runtime", `${owner}.json`);
        if (fs.existsSync(legacyRuntime))
          assertStopped(z.object({ pid: z.number().int().positive() }).passthrough().parse(json(legacyRuntime)).pid);
        fs.rmSync(item.file, { force: true });
      }
      return { ...plan, cleaned: true };
    });
  }
  finally {
    release();
  }
}
