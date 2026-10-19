import { createHash } from "node:crypto";
import { resolveHub } from "../hub/store.js";
import { writeSecureJson } from "../config/paths.js";
import { boundConnector, connectorReconciliation, normalizePublicUrl, readLastEndpoint } from "../config/endpoint.js";
import { acquireHubLock, assertNoPendingDestroy } from "../lifecycle/hub.js";
import { WorkspaceRegistry, WorkspaceRegistryError, type WorkspaceRegistration } from "../workspace/registry.js";
import { bindingFile, bindingSchema, readBinding, workspaceIdSchema, projectIdentity, type ProjectBinding } from "./state.js";
export type { ProjectBinding } from "./state.js";

export const PROJECT_INSTRUCTION_VERSION = 3;

function context(hubId: string, projectUrl: string) {
  resolveHub(hubId);
  const projectId = projectIdentity(projectUrl);
  const registry = new WorkspaceRegistry(hubId), registrations = registry.list();
  return { projectId, registry, registrations, binding: readBinding(hubId, projectId) };
}

function registeredWorkspace(registrations: WorkspaceRegistration[], selector: string) {
  const entry = registrations.find(entry => entry.workspaceId === selector || entry.alias === selector);
  if (!entry) throw new Error("WORKSPACE_NOT_FOUND: Workspace is not registered to this Hub.");
  return entry;
}

function intended(hubId: string, projectUrl: string, workspaceSelector?: string) {
  const current = context(hubId, projectUrl);
  const workspaceIds = new Set(current.binding?.workspaceIds ?? []);
  if (workspaceSelector !== undefined) workspaceIds.add(registeredWorkspace(current.registrations, workspaceSelector).workspaceId);
  const registeredIds = new Set(current.registrations.map(entry => entry.workspaceId));
  const staleWorkspaceIds = [...workspaceIds].filter(id => !registeredIds.has(id)).sort();
  const repositories = [...workspaceIds].filter(id => registeredIds.has(id)).map(id => {
    const workspace = current.registry.resolve(id);
    // Labels are display metadata; prevent them from injecting lines or block markers.
    const name = workspace.name.replace(/[\r\n\t]/g, " ").replace(/\[\/?desk-c2c\b[^\]]*\]/gi, "").trim() || workspace.id;
    return { name, workspaceId: workspace.id };
  }).sort((a, b) => {
    const compare = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
    return compare(a.name, b.name) || compare(a.workspaceId, b.workspaceId);
  });
  const endpoint = readLastEndpoint(hubId), connector = boundConnector(endpoint);
  if (!endpoint || !endpoint.connectorName || !endpoint.mcpUrl || !connector?.id ||
      !/^[a-zA-Z0-9_-]+$/.test(connector.id) || connectorReconciliation(endpoint).needed) {
    throw new Error("PROJECT_CONNECTOR_UNVERIFIED: Verify this Hub's exact connector binding before applying Project instructions.");
  }
  const text = [
    `[desk-c2c hub="${hubId}"]`,
    `Connector: ${connector.name}`,
    "",
    "Repositories:",
    ...repositories.map(repo => `- ${repo.name} -> workspace="${repo.workspaceId}"`),
    "",
    "Always use this connector for repositories in this block.",
    "Repository routing is the connector plus workspace ID.",
    "Always pass the explicit workspace ID to repository tools.",
    "Never omit workspace and never use list_workspaces() to choose a repository.",
    "Choose repositories from the user's request and conversation context.",
    "If one repository is clearly targeted, use only that workspace.",
    "For cross-repository work, inspect every relevant repository through its block's connector.",
    "If the target connector or repository is ambiguous, ask before reading.",
    "",
    "Before first use of a repository in a conversation, verify its exact workspace ID",
    'with workspace_info(workspace="<id>") through this connector. Reuse that',
    "verification unless a tool/connector error suggests the binding changed.",
    `[/desk-c2c hub="${hubId}"]`,
  ].join("\n");
  return { hubId, projectId: current.projectId, projectUrl, repositories, staleWorkspaceIds,
    connector: { ...connector, mcpUrl: normalizePublicUrl(connector.mcpUrl) },
    instructionVersion: PROJECT_INSTRUCTION_VERSION, instructions: text,
    instructionHash: createHash("sha256").update(text, "utf8").digest("hex") };
}

/** Preview this Hub's Project block, optionally including one new membership, without writing state. */
export function projectInstructions(hubId: string, projectUrl: string, workspaceSelector?: string) {
  return intended(hubId, projectUrl, workspaceSelector);
}

/** Local aggregate freshness only. Project availability and MCP evidence require visible UI. */
export function projectStatus(hubId: string, projectUrl: string) {
  const current = context(hubId, projectUrl);
  const base = { hubId, projectId: current.projectId, binding: current.binding, projectVerification: "not_checked" as const };
  if (!current.binding) return { ...base, status: "unbound" as const };
  let expected: ReturnType<typeof intended>;
  try { expected = intended(hubId, projectUrl); }
  catch (error) {
    if (error instanceof WorkspaceRegistryError && error.code === "WORKSPACE_UNAVAILABLE")
      return { ...base, status: "stale" as const, reason: error.code };
    if (error instanceof Error && error.message.startsWith("PROJECT_CONNECTOR_UNVERIFIED:"))
      return { ...base, status: "stale" as const, reason: "PROJECT_CONNECTOR_UNVERIFIED" };
    throw error;
  }
  const synced = current.binding.instructionVersion === PROJECT_INSTRUCTION_VERSION &&
    current.binding.appliedInstructionHash === expected.instructionHash;
  return { ...base, status: !synced ? "sync_required" as const : expected.staleWorkspaceIds.length ? "stale" as const : "current" as const,
    ...(expected.staleWorkspaceIds.length ? { reason: "WORKSPACE_NOT_REGISTERED" } : {}),
    repositories: expected.repositories, staleWorkspaceIds: expected.staleWorkspaceIds,
    expectedInstructionHash: expected.instructionHash };
}

/** Acknowledges this Hub's Project block; optional workspace adds only that membership. */
export function bindProject(hubId: string, projectUrl: string, instructionHash: string, workspaceSelector?: string): ProjectBinding {
  const release = acquireHubLock(hubId);
  try {
    assertNoPendingDestroy(hubId);
    const preview = intended(hubId, projectUrl, workspaceSelector);
    if (instructionHash !== preview.instructionHash)
      throw new Error("PROJECT_INSTRUCTIONS_CHANGED: Reapply and verify the current aggregate instructions before acknowledging binding.");
    const workspaceIds = [...preview.repositories.map(repo => repo.workspaceId), ...preview.staleWorkspaceIds].sort();
    const binding = bindingSchema.parse({ version: 2, hubId, projectId: preview.projectId, projectUrl,
      workspaceIds, instructionVersion: PROJECT_INSTRUCTION_VERSION,
      appliedInstructionHash: instructionHash, updatedAt: new Date().toISOString() });
    writeSecureJson(bindingFile(hubId, binding.projectId), binding);
    return binding;
  } finally { release(); }
}

/** Removes only this Project's membership. Other Projects and ChatGPT instructions stay intact. */
export function unbindProject(hubId: string, projectUrl: string, selector: string) {
  const release = acquireHubLock(hubId);
  try {
    assertNoPendingDestroy(hubId);
    const current = context(hubId, projectUrl);
    if (!current.binding) throw new Error("PROJECT_NOT_BOUND: No local membership exists for this Project.");
    const workspaceId = current.registrations.find(entry => entry.workspaceId === selector || entry.alias === selector)?.workspaceId ??
      (workspaceIdSchema.safeParse(selector).success ? selector : undefined);
    if (!workspaceId || !current.binding.workspaceIds.includes(workspaceId))
      throw new Error("PROJECT_MEMBERSHIP_NOT_FOUND: Workspace does not belong to this Project.");
    const next = { ...current.binding, workspaceIds: current.binding.workspaceIds.filter(id => id !== workspaceId), updatedAt: new Date().toISOString() };
    writeSecureJson(bindingFile(hubId, current.projectId), next);
    return { hubId, projectId: current.projectId, workspaceId, unbound: true };
  } finally { release(); }
}
