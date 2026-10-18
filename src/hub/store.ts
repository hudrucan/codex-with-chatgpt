import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ensureDir, getStateDir, writeSecureJson } from "../config/paths.js";
import type { Workspace } from "../workspace/manager.js";

export const hubIdSchema = z.string().regex(/^hub-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
const workspaceIdSchema = z.string().regex(/^[a-f0-9]{12}$/);
const hubSchema = z.object({
  version: z.literal(1),
  hubId: hubIdSchema,
  displayName: z.string().trim().min(1).refine((name) => !/[\x00-\x1f\x7f]/.test(name)),
  createdAt: z.string().datetime(),
  legacyOwnerWorkspaceId: workspaceIdSchema.optional(),
}).strict();
const mappingSchema = z.object({
  version: z.literal(1),
  legacyOwnerWorkspaceId: workspaceIdSchema,
  hubId: hubIdSchema,
  registryInitialized: z.boolean(),
  authInitialized: z.boolean().optional(),
  authHandoffFinalized: z.boolean().optional(),
  tunnelInitialized: z.boolean().optional(),
  endpointInitialized: z.boolean().optional(),
}).strict();

export type Hub = z.infer<typeof hubSchema>;

export class HubError extends Error {
  constructor(public code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "HubError";
  }
}

export function hubFile(hubId: string): string {
  if (!hubIdSchema.safeParse(hubId).success) throw new HubError("HUB_STATE_INVALID", "Invalid Hub ID.");
  return path.join(getStateDir(), "hubs", `${hubId}.json`);
}

export function hubMappingFile(ownerWorkspaceId: string): string {
  if (!workspaceIdSchema.safeParse(ownerWorkspaceId).success) throw new HubError("HUB_MAPPING_INVALID", "Invalid legacy owner ID.");
  return path.join(getStateDir(), "hub-mappings", `${ownerWorkspaceId}.json`);
}

function records<T>(directory: string, schema: z.ZodType<T>): { key: string; value: T }[] {
  const dir = path.join(getStateDir(), directory);
  let names: string[];
  try { names = fs.readdirSync(dir); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new HubError("HUB_STATE_INVALID", "Cannot read Hub state.");
  }
  return names.filter((name) => name.endsWith(".json")).sort().map((name) => {
    try {
      return { key: name.slice(0, -5), value: schema.parse(JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"))) };
    } catch {
      throw new HubError("HUB_STATE_INVALID", "Hub state or mapping is malformed or unreadable.");
    }
  });
}

function validatedState() {
  const hubs = records("hubs", hubSchema);
  const mappings = records("hub-mappings", mappingSchema);
  const claims = new Map<string, Hub>();
  for (const { key, value: hub } of hubs) {
    if (key !== hub.hubId) throw new HubError("HUB_MAPPING_CONFLICT", "Hub filename and identity do not match.");
    if (hub.legacyOwnerWorkspaceId) {
      if (claims.has(hub.legacyOwnerWorkspaceId)) throw new HubError("HUB_MAPPING_CONFLICT", "Multiple Hubs claim the same legacy owner.");
      claims.set(hub.legacyOwnerWorkspaceId, hub);
    }
  }
  const mappedHubs = new Set<string>();
  for (const { key, value: mapping } of mappings) {
    if (mapping.authHandoffFinalized && !mapping.authInitialized) {
      throw new HubError("HUB_MAPPING_CONFLICT", "Finalized auth handoff requires an initialized Hub auth store.");
    }
    if (key !== mapping.legacyOwnerWorkspaceId || claims.get(key)?.hubId !== mapping.hubId || mappedHubs.has(mapping.hubId)) {
      throw new HubError("HUB_MAPPING_CONFLICT", "Hub mappings must uniquely match their persisted legacy owners.");
    }
    mappedHubs.add(mapping.hubId);
  }
  return { hubs, mappings, claims };
}

function withHubLock<T>(operation: () => T): T {
  const lock = path.join(ensureDir(path.join(getStateDir(), "hub-mappings")), ".lock");
  let fd: number;
  try { fd = fs.openSync(lock, "wx", 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    throw new HubError("HUB_STATE_BUSY", "Another local Hub operation holds the mapping lock.");
  }
  try { return operation(); }
  finally { fs.closeSync(fd); fs.unlinkSync(lock); }
}

/** Existing identities only: never creates or recovers a Hub mapping. */
export function withHubControlPlane<T>(hubId: string, operation: (state: {
  hub: Hub; authInitialized: boolean; completeAuthAdoption: () => void;
  authHandoffFinalized: boolean; completeAuthHandoff: () => void;
  tunnelInitialized: boolean; endpointInitialized: boolean;
  completeResourceAdoption: (resource: "tunnel" | "endpoint") => void;
}) => T): T {
  hubFile(hubId);
  return withHubLock(() => {
    const { hubs, mappings } = validatedState();
    const hub = hubs.find(({ value }) => value.hubId === hubId)?.value;
    if (!hub) throw new HubError("HUB_MAPPING_CONFLICT", "Hub identity is missing.");
    const mapping = mappings.find(({ value }) => value.hubId === hubId)?.value;
    if (hub.legacyOwnerWorkspaceId && !mapping) throw new HubError("HUB_MAPPING_CONFLICT", "Resolve the configured Hub before using its state.");
    return operation({
      hub,
      authInitialized: mapping?.authInitialized ?? !hub.legacyOwnerWorkspaceId,
      authHandoffFinalized: mapping?.authHandoffFinalized ?? !hub.legacyOwnerWorkspaceId,
      completeAuthHandoff: () => {
        if (mapping && !mapping.authHandoffFinalized) {
          const finalized = { ...mapping, authInitialized: true, authHandoffFinalized: true };
          writeSecureJson(hubMappingFile(mapping.legacyOwnerWorkspaceId), finalized);
          Object.assign(mapping, finalized);
        }
      },
      tunnelInitialized: mapping?.tunnelInitialized ?? !hub.legacyOwnerWorkspaceId,
      endpointInitialized: mapping?.endpointInitialized ?? !hub.legacyOwnerWorkspaceId,
      completeResourceAdoption: (resource) => {
        const key = resource === "tunnel" ? "tunnelInitialized" : "endpointInitialized";
        if (mapping && !mapping[key]) {
          mapping[key] = true;
          writeSecureJson(hubMappingFile(mapping.legacyOwnerWorkspaceId), mapping);
        }
      },
      completeAuthAdoption: () => {
        if (mapping && !mapping.authInitialized) writeSecureJson(hubMappingFile(mapping.legacyOwnerWorkspaceId), { ...mapping, authInitialized: true });
      },
    });
  });
}

export function readConfiguredHub(hubId: string): Hub {
  return withHubControlPlane(hubId, ({ hub }) => hub);
}

/** Serialize identity claims and registry adoption across all local owners. */
export function resolveHub(workspace: Pick<Workspace, "id" | "name">, initializeRegistry?: (hub: Hub) => void): Hub {
  hubMappingFile(workspace.id);
  return withHubLock(() => {
    const { mappings, claims } = validatedState();
    let hub = claims.get(workspace.id);
    if (!hub) {
      hub = hubSchema.parse({ version: 1, hubId: `hub-${randomUUID()}`, displayName: workspace.name,
        createdAt: new Date().toISOString(), legacyOwnerWorkspaceId: workspace.id });
      writeSecureJson(hubFile(hub.hubId), hub);
    }
    let mapping = mappings.find(({ key }) => key === workspace.id)?.value;
    if (!mapping) {
      // A sole persisted Hub claim also recovers a crash before the mapping write.
      mapping = { version: 1, legacyOwnerWorkspaceId: workspace.id, hubId: hub.hubId, registryInitialized: false };
      writeSecureJson(hubMappingFile(workspace.id), mapping);
    }
    if (!mapping.registryInitialized && initializeRegistry) {
      initializeRegistry(hub);
      writeSecureJson(hubMappingFile(workspace.id), { ...mapping, registryInitialized: true });
    }
    return hub;
  });
}
