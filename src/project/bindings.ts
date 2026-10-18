import fs from "node:fs";
import { createHash } from "node:crypto";
import { resolveHub } from "../hub/store.js";
import { writeSecureJson } from "../config/paths.js";
import { boundConnector, connectorReconciliation, normalizePublicUrl, readLastEndpoint } from "../config/endpoint.js";
import { acquireHubLock, assertNoPendingDestroy } from "../lifecycle/hub.js";
import { WorkspaceRegistry, WorkspaceRegistryError, type WorkspaceRegistration } from "../workspace/registry.js";
import { bindingFile, bindingSchema, readBinding, workspaceIdSchema, isProjectUrl, assertProjectAvailable, withProjectStateLock, type ProjectBinding } from "./state.js";
export type { ProjectBinding } from "./state.js";

export const PROJECT_INSTRUCTION_VERSION = 1;

function lookup(hubId: string, selector: string) {
  resolveHub(hubId);
  const registry = new WorkspaceRegistry(hubId);
  const registration = registry.list().find(entry => entry.workspaceId === selector || entry.alias === selector);
  // A removed grant can only be inspected/unbound by its exact persisted ID.
  const workspaceId = registration?.workspaceId ?? (workspaceIdSchema.safeParse(selector).success ? selector : undefined);
  if (!workspaceId) throw new Error("WORKSPACE_NOT_FOUND: Select a registered alias or workspace ID.");
  const binding = readBinding(hubId, workspaceId);
  if (!registration && !binding) throw new Error("WORKSPACE_NOT_FOUND: Workspace is not registered to this Hub.");
  return { registry, registration, workspaceId, binding };
}

function intended(hubId: string, registration: WorkspaceRegistration, registry: WorkspaceRegistry) {
  const workspace = registry.resolve(registration.workspaceId);
  const endpoint = readLastEndpoint(hubId), connector = boundConnector(endpoint);
  if (!endpoint || endpoint.bindingVersion !== 1 || !endpoint.connectorName || !endpoint.mcpUrl ||
      !connector?.id || !/^[a-zA-Z0-9_-]+$/.test(connector.id) ||
      connectorReconciliation(endpoint).needed) {
    throw new Error("PROJECT_CONNECTOR_UNVERIFIED: Verify this Hub's exact connector binding before applying Project instructions.");
  }
  const verifiedConnector = { ...connector, mcpUrl: normalizePublicUrl(connector.mcpUrl) };
  const text = [
    "--- BEGIN DESK C2C HUB WORKSPACE BINDING ---",
    "This ChatGPT Project is bound to Desk C2C Hub workspace:",
    `- Workspace: ${registration.alias}`,
    `- Display name: ${JSON.stringify(workspace.name)}`,
    `- Workspace ID: ${workspace.id}`,
    `- Connector: ${JSON.stringify(connector.name)}`,
    `- Connector ID: ${connector.id}`,
    `- MCP URL: ${verifiedConnector.mcpUrl}`,
    "",
    "Use this Desk C2C Hub connector for repository access.",
    `For every workspace-scoped MCP tool, use workspace="${workspace.id}".`,
    `Verify with workspace_info(workspace="${workspace.id}") before relying on repository context.`,
    "If it does not resolve to this workspace or the connector differs, stop.",
    "",
    `Instruction version: ${PROJECT_INSTRUCTION_VERSION}`,
    "--- END DESK C2C HUB WORKSPACE BINDING ---",
  ].join("\n");
  return { hubId, workspaceId: workspace.id, alias: registration.alias, connector: verifiedConnector,
    instructionVersion: PROJECT_INSTRUCTION_VERSION, instructions: text,
    instructionHash: createHash("sha256").update(text, "utf8").digest("hex") };
}

export function projectInstructions(hubId: string, selector: string) {
  const current = lookup(hubId, selector);
  if (!current.registration) throw new Error("PROJECT_BINDING_STALE: Workspace is no longer registered; re-register or explicitly unbind by workspace ID.");
  return intended(hubId, current.registration, current.registry);
}

/** Local instruction freshness only. Project availability and MCP evidence require visible UI. */
export function projectStatus(hubId: string, selector: string) {
  const current = lookup(hubId, selector);
  const base = { hubId, workspaceId: current.workspaceId, alias: current.registration?.alias ?? null,
    binding: current.binding, projectVerification: "not_checked" as const };
  if (!current.registration) return { ...base, status: "stale" as const, reason: "WORKSPACE_NOT_REGISTERED" };
  if (!current.binding) return { ...base, status: "unbound" as const };
  let expected: ReturnType<typeof intended>;
  try { expected = intended(hubId, current.registration, current.registry); }
  catch (error) {
    if (error instanceof WorkspaceRegistryError && error.code === "WORKSPACE_UNAVAILABLE")
      return { ...base, status: "stale" as const, reason: error.code };
    if (error instanceof Error && error.message.startsWith("PROJECT_CONNECTOR_UNVERIFIED:"))
      return { ...base, status: "stale" as const, reason: "PROJECT_CONNECTOR_UNVERIFIED" };
    throw error;
  }
  const synced = current.binding.instructionVersion === expected.instructionVersion &&
    current.binding.appliedInstructionHash === expected.instructionHash;
  return { ...base, status: synced ? "current" as const : "sync_required" as const,
    expectedInstructionHash: expected.instructionHash };
}

/** Acknowledges completed visible Project instructions + MCP verification; no ChatGPT mutation. */
export function bindProject(hubId: string, selector: string, projectUrl: string, instructionHash: string): ProjectBinding {
  const release = acquireHubLock(hubId);
  try {
    assertNoPendingDestroy(hubId);
    return withProjectStateLock(() => {
      if (!isProjectUrl(projectUrl)) throw new Error("INVALID_PROJECT_URL: Use the exact HTTPS ChatGPT Project landing URL, without chat paths, queries or fragments.");
      const expected = projectInstructions(hubId, selector);
      if (instructionHash !== expected.instructionHash)
        throw new Error("PROJECT_INSTRUCTIONS_CHANGED: Reapply and verify the current generated instructions before acknowledging binding.");
      const binding = bindingSchema.parse({ version: 1, hubId, workspaceId: expected.workspaceId, projectUrl,
        instructionVersion: expected.instructionVersion, appliedInstructionHash: instructionHash, updatedAt: new Date().toISOString() });
      assertProjectAvailable(binding);
      writeSecureJson(bindingFile(hubId, binding.workspaceId), binding);
      return binding;
    });
  } finally { release(); }
}

/** Removes local acknowledgement only, including a stale binding; never deletes a Project. */
export function unbindProject(hubId: string, selector: string) {
  const release = acquireHubLock(hubId);
  try {
    assertNoPendingDestroy(hubId);
    return withProjectStateLock(() => {
      const current = lookup(hubId, selector);
      fs.rmSync(bindingFile(hubId, current.workspaceId), { force: true });
      return { hubId, workspaceId: current.workspaceId, unbound: true };
    });
  } finally { release(); }
}
