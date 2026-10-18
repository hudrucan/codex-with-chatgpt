import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { getStateDir, writeSecureJson } from "../config/paths.js";
import { hubIdSchema, readConfiguredHub, type Hub } from "../hub/store.js";
import { Workspace } from "../workspace/manager.js";
import { SERVICE_NAME, VERSION } from "../version.js";

const runtimeFields = {
  service: z.literal(SERVICE_NAME), version: z.string(),
  workspaceId: z.string().regex(/^[a-f0-9]{12}$/),
  workspaceRoot: z.string().refine((root) => path.isAbsolute(root)),
  pid: z.number().int().positive(), port: z.number().int().min(1).max(65535),
  adminToken: z.string().min(1), publicUrl: z.string().nullable(), startedAt: z.string().datetime(),
};
const legacyRuntimeSchema = z.object(runtimeFields).strict();
const hubRuntimeSchema = z.object({ ...runtimeFields, stateVersion: z.literal(1), hubId: hubIdSchema }).strict();
export type HubRuntimeState = z.infer<typeof hubRuntimeSchema>;
/** Startup workspace fields are compatibility metadata, not the runtime identity. */
export type RuntimeState = z.infer<typeof legacyRuntimeSchema> & { hubId?: string; stateVersion?: 1 };

export function runtimeFile(hubId: string): string {
  if (!hubIdSchema.safeParse(hubId).success) throw new Error("RUNTIME_OWNERSHIP_CONFLICT: Runtime owner must be a Hub ID.");
  return path.join(getStateDir(), "runtime", `${hubId}.json`);
}

export function writeRuntimeState(state: HubRuntimeState): void {
  const parsed = hubRuntimeSchema.parse(state);
  writeSecureJson(runtimeFile(parsed.hubId), parsed);
}

function readRuntime(file: string, hubId?: string): RuntimeState | null {
  let raw: string;
  try { raw = fs.readFileSync(file, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error("RUNTIME_STATE_INVALID: Cannot read runtime state.");
  }
  try {
    const value = hubId ? hubRuntimeSchema.parse(JSON.parse(raw)) : legacyRuntimeSchema.parse(JSON.parse(raw));
    if (hubId && (!('hubId' in value) || value.hubId !== hubId)) throw new Error("Wrong owner");
    return value;
  } catch { throw new Error("RUNTIME_STATE_INVALID: Runtime ownership or format is invalid."); }
}

export function readRuntimeState(hubId: string): HubRuntimeState | null {
  return readRuntime(runtimeFile(hubId), hubId) as HubRuntimeState | null;
}

export function clearRuntimeState(hubId: string): void {
  fs.rmSync(runtimeFile(hubId), { force: true });
}

export interface HealthPayload {
  service: string;
  version: string;
  hubId?: string;
  workspaceId?: string;
  status: string;
}

export async function probeBridge(port: number, timeoutMs = 2000): Promise<HealthPayload | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: controller.signal });
    if (!response.ok) return null;
    const body = await response.json() as HealthPayload;
    return body.service === SERVICE_NAME && body.status === "ok" ? body : null;
  } catch { return null; }
  finally { clearTimeout(timer); }
}

export type BridgeObservation =
  | { state: "healthy"; runtime: RuntimeState }
  | { state: "stopped"; runtime: RuntimeState | null; reason: "runtime_missing" | "pid_missing" }
  | { state: "unknown"; runtime: RuntimeState | null; reason: "probe_failed" | "pid_unknown" | "workspace_mismatch" | "runtime_invalid" };

function observePid(pid: number): "present" | "missing" | "unknown" {
  try { process.kill(pid, 0); return "present"; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH" ? "missing" : "unknown"; }
}

/** Called under the Hub control-plane lock, before copying authoritative auth. */
export function assertAuthHandoffQuiescent(hub: Hub, owner: Workspace, hasLegacyAuth: boolean): void {
  if (hub.legacyOwnerWorkspaceId !== owner.id) throw new Error("AUTH_HANDOFF_CONFLICT: Legacy owner does not match this Hub.");
  const current = readRuntimeState(hub.hubId);
  if (current && observePid(current.pid) !== "missing") {
    throw new Error("AUTH_HANDOFF_BUSY: A Hub runtime may still be writing auth.");
  }
  const legacy = readRuntime(path.join(getStateDir(), "runtime", `${owner.id}.json`));
  if (!legacy) {
    if (hasLegacyAuth) throw new Error("AUTH_HANDOFF_REQUIRED: Retain the verified legacy runtime record until its process exit is confirmed.");
    return;
  }
  if (legacy.workspaceId !== owner.id || legacy.workspaceRoot !== owner.root) {
    throw new Error("AUTH_HANDOFF_CONFLICT: Legacy runtime belongs to another owner.");
  }
  if (observePid(legacy.pid) !== "missing") {
    throw new Error("AUTH_HANDOFF_BUSY: Stop the legacy bridge and confirm its process has exited before finalizing auth.");
  }
}

async function observe(file: string, hubId: string, legacyOwner?: string): Promise<BridgeObservation> {
  let runtime: RuntimeState | null;
  try { runtime = readRuntime(file, legacyOwner ? undefined : hubId); }
  catch { return { state: "unknown", runtime: null, reason: "runtime_invalid" }; }
  if (!runtime) return { state: "stopped", runtime: null, reason: "runtime_missing" };
  const pid = observePid(runtime.pid);
  if (pid === "missing") return { state: "stopped", runtime, reason: "pid_missing" };
  if (legacyOwner) {
    try {
      const workspace = new Workspace(runtime.workspaceRoot);
      if (runtime.workspaceId !== legacyOwner || workspace.id !== legacyOwner || workspace.root !== runtime.workspaceRoot) throw new Error("Wrong legacy owner");
    } catch { return { state: "unknown", runtime, reason: "workspace_mismatch" }; }
  }
  const health = await probeBridge(runtime.port);
  const matches = health && (legacyOwner
    ? health.workspaceId === legacyOwner && (health.hubId === undefined || health.hubId === hubId)
    : health.hubId === hubId);
  if (matches) return { state: "healthy", runtime };
  if (health) return { state: "unknown", runtime, reason: "workspace_mismatch" };
  return { state: "unknown", runtime, reason: pid === "unknown" ? "pid_unknown" : "probe_failed" };
}

/** Read-only discovery. Live legacy runtime stays in its own file until its process exits. */
export async function findBridgeObservation(hubId: string): Promise<BridgeObservation> {
  const hub = readConfiguredHub(hubId);
  const current = await observe(runtimeFile(hubId), hubId);
  if (current.state !== "stopped" || !hub.legacyOwnerWorkspaceId) return current;
  const legacy = await observe(path.join(getStateDir(), "runtime", `${hub.legacyOwnerWorkspaceId}.json`), hubId, hub.legacyOwnerWorkspaceId);
  return legacy.state !== "stopped" ? legacy : current.runtime ? current : legacy;
}

export async function findLiveBridge(hubId: string): Promise<RuntimeState | null> {
  const observation = await findBridgeObservation(hubId);
  return observation.state === "healthy" ? observation.runtime : null;
}

export { SERVICE_NAME, VERSION };
