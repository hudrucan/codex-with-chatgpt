import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { hubIdSchema } from "../hub/store.js";
import { stateFile } from "../config/state-files.js";

export const workspaceIdSchema = z.string().regex(/^[a-f0-9]{12}$/);
const projectIdSchema = z.string().regex(/^g-p-[a-f0-9]{32}$/);

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
  version: z.literal(2), hubId: hubIdSchema, projectId: projectIdSchema,
  workspaceIds: z.array(workspaceIdSchema).refine(ids => new Set(ids).size === ids.length),
  projectUrl: z.string().refine(isProjectUrl),
  instructionVersion: z.number().int().positive(),
  appliedInstructionHash: z.string().regex(/^[a-f0-9]{64}$/), updatedAt: z.string().datetime(),
}).strict().refine(binding => projectIdentity(binding.projectUrl) === binding.projectId);
export type ProjectBinding = z.infer<typeof bindingSchema>;

export function bindingFile(hubId: string, projectId: string): string {
  hubIdSchema.parse(hubId);
  projectIdSchema.parse(projectId);
  const directory = stateFile("project-bindings", hubId);
  const file = path.join(directory, `${projectId}.json`);
  try {
    const info = fs.lstatSync(file);
    if (info.isSymbolicLink()) throw new Error("PROJECT_BINDING_INVALID: Refusing a binding symlink.");
    if (!info.isFile()) throw new Error("PROJECT_BINDING_INVALID: Project binding must be a regular file.");
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return file;
}

export function readBinding(hubId: string, projectId: string): ProjectBinding | null {
  const file = bindingFile(hubId, projectId);
  let raw: string;
  try { raw = fs.readFileSync(file, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error("PROJECT_BINDING_INVALID: Cannot read Project binding.");
  }
  try {
    const binding = bindingSchema.parse(JSON.parse(raw));
    if (binding.hubId !== hubId || binding.projectId !== projectId) throw new Error();
    return binding;
  } catch { throw new Error("PROJECT_BINDING_INVALID: Malformed or foreign Project binding; access denied."); }
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
    if (!/^g-p-[a-f0-9]{32}\.json$/.test(name))
      throw new Error("PROJECT_BINDING_INVALID: Unexpected file in Hub Project state.");
    const projectId = name.slice(0, -5), file = bindingFile(hubId, projectId);
    const binding = readBinding(hubId, projectId);
    if (!binding) throw new Error("PROJECT_BINDING_INVALID: Project binding changed during inspection.");
    return { file, binding };
  });
  return { directory, exists: names !== null, files };
}

export function projectIdentity(projectUrl: string): string {
  if (!isProjectUrl(projectUrl)) throw new Error("INVALID_PROJECT_URL");
  return new URL(projectUrl).pathname.match(/^\/g\/(g-p-[a-f0-9]{32})/)![1];
}

/** Caller holds this Hub's lifecycle lock. Never contacts or deletes ChatGPT Projects/instructions. */
export function removeProjectBindings(hubId: string): void {
  const inspected = inspectProjectBindings(hubId);
  for (const { file, binding } of inspected.files) {
    // Recheck ownership/containment immediately before each exact-file deletion.
    const current = readBinding(hubId, binding.projectId);
    if (!current || JSON.stringify(current) !== JSON.stringify(binding))
      throw new Error("PROJECT_BINDING_INVALID: Project binding changed during cleanup.");
    fs.unlinkSync(file);
  }
  if (inspected.exists) {
    stateFile("project-bindings", hubId);
    fs.rmdirSync(inspected.directory);
  }
}

