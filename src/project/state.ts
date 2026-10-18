import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { hubIdSchema } from "../hub/store.js";
import { stateFile } from "../config/state-files.js";
import { ensureDir } from "../config/paths.js";

export const workspaceIdSchema = z.string().regex(/^[a-f0-9]{12}$/);

/** Only a Project landing URL; never a chat, invite, GPT or settings URL. */
export function isProjectUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.origin === "https://chatgpt.com" && !url.username && !url.password &&
      !url.search && !url.hash && /^\/g\/g-p-[a-f0-9]{32}(?:-[a-z0-9-]+)?\/project\/?$/.test(url.pathname) &&
      value === url.href;
  } catch { return false; }
}

export const bindingSchema = z.object({
  version: z.literal(1), hubId: hubIdSchema, workspaceId: workspaceIdSchema,
  projectUrl: z.string().refine(isProjectUrl),
  instructionVersion: z.number().int().positive(),
  appliedInstructionHash: z.string().regex(/^[a-f0-9]{64}$/), updatedAt: z.string().datetime(),
}).strict();
export type ProjectBinding = z.infer<typeof bindingSchema>;

export function bindingFile(hubId: string, workspaceId: string): string {
  hubIdSchema.parse(hubId);
  workspaceIdSchema.parse(workspaceId);
  const directory = stateFile("project-bindings", hubId);
  const file = path.join(directory, `${workspaceId}.json`);
  try {
    const info = fs.lstatSync(file);
    if (info.isSymbolicLink()) throw new Error("PROJECT_BINDING_INVALID: Refusing a binding symlink.");
    if (!info.isFile()) throw new Error("PROJECT_BINDING_INVALID: Project binding must be a regular file.");
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return file;
}

export function readBinding(hubId: string, workspaceId: string): ProjectBinding | null {
  const file = bindingFile(hubId, workspaceId);
  let raw: string;
  try { raw = fs.readFileSync(file, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error("PROJECT_BINDING_INVALID: Cannot read Project binding.");
  }
  try {
    const binding = bindingSchema.parse(JSON.parse(raw));
    if (binding.hubId !== hubId || binding.workspaceId !== workspaceId) throw new Error();
    return binding;
  } catch { throw new Error("PROJECT_BINDING_INVALID: Malformed or foreign Project binding; access denied."); }
}

/** Serializes cross-Hub uniqueness checks and writes, in addition to per-Hub locks. */
export function withProjectStateLock<T>(operation: () => T): T {
  const file = stateFile("project-bindings", ".lock");
  ensureDir(path.dirname(file));
  let fd: number;
  try { fd = fs.openSync(file, "wx", 0o600); }
  catch { throw new Error("PROJECT_BINDING_BUSY: Another local Project operation holds the lock."); }
  try { return operation(); }
  finally { fs.closeSync(fd); fs.unlinkSync(file); }
}

function directoryEntries(directory: string): string[] | null {
  try {
    const info = fs.lstatSync(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error();
    return fs.readdirSync(directory).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error("PROJECT_BINDING_INVALID: Project state directory is unreadable, invalid or symlinked.");
  }
}

/** Strict local ownership preflight; registration is intentionally not required for stale records. */
export function inspectProjectBindings(hubId: string) {
  hubIdSchema.parse(hubId);
  const directory = stateFile("project-bindings", hubId);
  const names = directoryEntries(directory);
  const files = (names ?? []).map(name => {
    if (!/^[a-f0-9]{12}\.json$/.test(name))
      throw new Error("PROJECT_BINDING_INVALID: Unexpected file in Hub Project state.");
    const workspaceId = name.slice(0, -5), file = bindingFile(hubId, workspaceId);
    const binding = readBinding(hubId, workspaceId);
    if (!binding) throw new Error("PROJECT_BINDING_INVALID: Project binding changed during inspection.");
    return { file, binding };
  });
  return { directory, exists: names !== null, files };
}

function projectIdentity(projectUrl: string): string {
  if (!isProjectUrl(projectUrl)) throw new Error("INVALID_PROJECT_URL");
  return new URL(projectUrl).pathname.match(/^\/g\/(g-p-[a-f0-9]{32})/)![1];
}

/** Caller holds the global Project lock through the subsequent atomic write. */
export function assertProjectAvailable(candidate: ProjectBinding): void {
  const directory = path.dirname(stateFile("project-bindings", ".lock"));
  for (const name of directoryEntries(directory) ?? []) {
    if (name === ".lock") continue;
    if (!hubIdSchema.safeParse(name).success)
      throw new Error("PROJECT_BINDING_INVALID: Unexpected owner in Project state.");
    for (const { binding } of inspectProjectBindings(name).files) {
      if (projectIdentity(binding.projectUrl) === projectIdentity(candidate.projectUrl) &&
          (binding.hubId !== candidate.hubId || binding.workspaceId !== candidate.workspaceId)) {
        throw new Error("PROJECT_BINDING_CONFLICT: This ChatGPT Project is already bound to another Hub/workspace. Explicitly unbind it before reassignment.");
      }
    }
  }
}

/** Local acknowledgements only. Never contacts or deletes ChatGPT Projects/instructions. */
export function removeProjectBindings(hubId: string): void {
  withProjectStateLock(() => {
    const inspected = inspectProjectBindings(hubId);
    for (const { file, binding } of inspected.files) {
      // Recheck ownership/containment immediately before each exact-file deletion.
      const current = readBinding(hubId, binding.workspaceId);
      if (!current || JSON.stringify(current) !== JSON.stringify(binding))
        throw new Error("PROJECT_BINDING_INVALID: Project binding changed during cleanup.");
      fs.unlinkSync(file);
    }
    if (inspected.exists) {
      stateFile("project-bindings", hubId);
      fs.rmdirSync(inspected.directory);
    }
  });
}

