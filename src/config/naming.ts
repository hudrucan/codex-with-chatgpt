import path from "node:path";
import type { Workspace } from "../workspace/manager.js";
import { getStateDir, readJsonIfExists, writeSecureJson } from "./paths.js";

export function userFacingName(value: string, label: string): string {
  const name = value.trim();
  if (!name || /[\x00-\x1f\x7f]/.test(name)) {
    throw new Error(`INVALID_NAME: ${label} must be non-empty and contain no control characters.`);
  }
  return name;
}

interface WorkspaceRegistration {
  workspaceId: string;
  workspaceRoot: string;
  displayName: string;
}

export function workspaceRegistrationFile(id: string): string {
  return path.join(getStateDir(), "workspaces", `${id}.json`);
}

export function readWorkspaceDisplayName(id: string, root: string): string | undefined {
  const saved = readJsonIfExists<WorkspaceRegistration>(workspaceRegistrationFile(id));
  if (!saved) return undefined;
  if (saved.workspaceId !== id || saved.workspaceRoot !== root) throw new Error("OWNERSHIP_CONFLICT: Workspace registration belongs to another root.");
  return userFacingName(saved.displayName, "Workspace name");
}

/** Local display choices never modify the repository or replace root identity. */
export function saveWorkspaceDisplayName(workspace: Workspace, value: string): void {
  const displayName = userFacingName(value, "Workspace name");
  writeSecureJson(workspaceRegistrationFile(workspace.id), {
    workspaceId: workspace.id, workspaceRoot: workspace.root, displayName,
  } satisfies WorkspaceRegistration);
}
