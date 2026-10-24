import { resolveHub } from "../hub/store.js";
import { projectStatus } from "../project/bindings.js";
import { inspectProjectBindings, workspaceIdSchema } from "../project/state.js";
import { WorkspaceRegistry } from "../workspace/registry.js";

/** Cold path only: existing memberships never select an owner across Hubs. */
export function resolveAuditProject(workspaceId: string, hubId?: string): string {
  workspaceIdSchema.parse(workspaceId);
  const hub = resolveHub(hubId);
  new WorkspaceRegistry(hub.hubId).resolve(workspaceId);
  const matches = inspectProjectBindings(hub.hubId).files
    .map(entry => entry.binding).filter(binding => binding.workspaceIds.includes(workspaceId));
  if (matches.length !== 1) throw new Error("ASYNC_PROJECT_REQUIRED: Expected exactly one existing workspace Project binding.");
  const selected = matches[0];
  if (projectStatus(hub.hubId, selected.projectUrl).status !== "current")
    throw new Error("ASYNC_PROJECT_STALE: Existing Project binding requires verification or sync.");
  return selected.projectUrl;
}
