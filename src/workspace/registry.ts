import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { ensureDir, writeSecureJson } from "../config/paths.js";
import { stateFile } from "../config/state-files.js";
import { Workspace } from "./manager.js";
import { hubIdSchema } from "../hub/store.js";

const workspaceIdSchema = z.string().regex(/^[a-f0-9]{12}$/);
// Reserve the ID namespace so alias and ID selectors can never be ambiguous.
const aliasSchema = z.string().min(1).max(100)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  .refine((alias) => !workspaceIdSchema.safeParse(alias).success);
const registrationSchema = z.object({
  workspaceId: workspaceIdSchema,
  alias: aliasSchema,
  root: z.string().refine((root) => path.isAbsolute(root) && !root.includes("\0")),
}).strict();
export const registrySchema = z.object({
  version: z.literal(2),
  hubId: hubIdSchema,
  workspaces: z.array(registrationSchema),
}).strict();

function sortedRegistrations(entries: WorkspaceRegistration[]): WorkspaceRegistration[] {
  if (new Set(entries.map((entry) => entry.workspaceId)).size !== entries.length ||
      new Set(entries.map((entry) => entry.alias)).size !== entries.length) throw new Error("Duplicate registrations");
  return entries.sort((a, b) => a.alias < b.alias ? -1 : a.alias > b.alias ? 1 : 0);
}

export type WorkspaceRegistration = z.infer<typeof registrationSchema>;
export type WorkspaceChoice = Pick<WorkspaceRegistration, "workspaceId" | "alias">;

export class WorkspaceRegistryError extends Error {
  constructor(
    public code: string,
    message: string,
    public workspaces?: WorkspaceChoice[]
  ) {
    super(message);
    this.name = "WorkspaceRegistryError";
  }
}

/** Explicit local grants owned by a stable Hub identity. */
export class WorkspaceRegistry {
  readonly file: string;

  constructor(readonly hubId: string) {
    if (!hubIdSchema.safeParse(hubId).success) {
      throw new WorkspaceRegistryError("INVALID_WORKSPACE_OWNER", "Registry owner must be a Hub ID.");
    }
    this.file = stateFile("workspace-registries", `${hubId}.json`);
  }

  list(): WorkspaceRegistration[] {
    stateFile("workspace-registries", `${this.hubId}.json`);
    let raw: string;
    try {
      raw = fs.readFileSync(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new WorkspaceRegistryError("WORKSPACE_REGISTRY_INVALID", "Cannot read workspace registry.");
    }
    try {
      const { hubId, workspaces } = registrySchema.parse(JSON.parse(raw));
      if (hubId !== this.hubId) throw new Error("Registry owner mismatch");
      return sortedRegistrations(workspaces);
    } catch {
      throw new WorkspaceRegistryError("WORKSPACE_REGISTRY_INVALID", "Invalid workspace registry; access is denied.");
    }
  }

  choices(): WorkspaceChoice[] {
    return this.list().map(({ workspaceId, alias }) => ({ workspaceId, alias }));
  }

  private mutate<T>(update: (entries: WorkspaceRegistration[]) => T): T {
    ensureDir(path.dirname(this.file));
    const lock = `${this.file}.lock`;
    let fd: number;
    try {
      fd = fs.openSync(lock, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      throw new WorkspaceRegistryError("WORKSPACE_REGISTRY_BUSY", "Workspace registry is locked; retry after the other local operation finishes.");
    }
    try {
      const entries = this.list();
      const result = update(entries);
      writeSecureJson(this.file, { version: 2, hubId: this.hubId, workspaces: entries });
      return result;
    } finally {
      fs.closeSync(fd);
      fs.unlinkSync(lock);
    }
  }

  add(root: string, alias?: string): WorkspaceRegistration {
    const workspace = new Workspace(root);
    if (alias !== undefined && !aliasSchema.safeParse(alias).success) {
      throw new WorkspaceRegistryError("INVALID_WORKSPACE_ALIAS", "Alias must be at most 100 lowercase letters/digits separated by hyphens, and cannot be a workspace ID.");
    }
    return this.mutate((entries) => {
      const existing = entries.find((entry) => entry.workspaceId === workspace.id);
      if (existing && existing.root !== workspace.root) {
        throw new WorkspaceRegistryError("WORKSPACE_REGISTRY_INVALID", "Workspace identity conflicts with its registered root.");
      }
      const slug = path.basename(workspace.root).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 70).replace(/-$/, "") || "workspace";
      const selectedAlias = alias ?? existing?.alias ?? `${slug}-${workspace.id}`;
      if (entries.some((entry) => entry.alias === selectedAlias && entry.workspaceId !== workspace.id)) {
        throw new WorkspaceRegistryError("WORKSPACE_ALIAS_CONFLICT", "Alias is already registered to another workspace.");
      }
      const entry = { workspaceId: workspace.id, alias: selectedAlias, root: workspace.root };
      if (existing) Object.assign(existing, entry);
      else entries.push(entry);
      return entry;
    });
  }

  remove(selector: string): WorkspaceRegistration {
    return this.mutate((entries) => {
      const index = entries.findIndex((entry) => entry.alias === selector || entry.workspaceId === selector);
      if (index === -1) throw new WorkspaceRegistryError("WORKSPACE_NOT_FOUND", "Workspace selector is not registered.");
      return entries.splice(index, 1)[0];
    });
  }

  /** Re-read grants and rebuild policies for every call; never cache selection. */
  resolve(selector?: string): Workspace {
    const entries = this.list();
    if (selector === undefined && entries.length > 1) {
      throw new WorkspaceRegistryError(
        "WORKSPACE_REQUIRED", "Select a workspace by alias or workspaceId from list_workspaces.",
        entries.map(({ workspaceId, alias }) => ({ workspaceId, alias }))
      );
    }
    const entry = selector === undefined ? entries[0] :
      entries.find((entry) => entry.alias === selector || entry.workspaceId === selector);
    if (!entry) throw new WorkspaceRegistryError("WORKSPACE_NOT_FOUND", "Workspace selector is not registered.");
    try {
      const workspace = new Workspace(entry.root);
      // A replaced symlink must not silently grant access to a different root.
      if (workspace.root !== entry.root || workspace.id !== entry.workspaceId) throw new Error("Root changed");
      return workspace;
    } catch {
      throw new WorkspaceRegistryError("WORKSPACE_UNAVAILABLE", "Registered workspace is unavailable or its canonical root has changed. Re-register it locally.");
    }
  }
}
