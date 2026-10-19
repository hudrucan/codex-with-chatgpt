import fs from "node:fs";
import { stateFile } from "../config/state-files.js";
import { z } from "zod";
import { writeSecureJson } from "../config/paths.js";
import { hubIdSchema, readConfiguredHub } from "../hub/store.js";
import { SERVICE_NAME, VERSION } from "../version.js";

const runtimeFields = {
  service: z.literal(SERVICE_NAME), version: z.string(),
  pid: z.number().int().positive(), port: z.number().int().min(1).max(65535),
  adminToken: z.string().min(1), publicUrl: z.string().nullable(), startedAt: z.string().datetime(),
};
export const hubRuntimeSchema = z.object({ ...runtimeFields, stateVersion: z.literal(1), hubId: hubIdSchema }).strict();
// Accept deployed v1 metadata during rollout, but never expose or persist it again.
const runtimeReadSchema = hubRuntimeSchema.extend({
  workspaceId: z.string().regex(/^[a-f0-9]{12}$/).optional(),
  workspaceRoot: z.string().optional(),
}).transform(({ workspaceId, workspaceRoot, ...state }) => state);
export type HubRuntimeState = z.infer<typeof hubRuntimeSchema>;
export type RuntimeState = HubRuntimeState;

export function runtimeFile(hubId: string): string {
  if (!hubIdSchema.safeParse(hubId).success) throw new Error("RUNTIME_OWNERSHIP_CONFLICT: Runtime owner must be a Hub ID.");
  return stateFile("runtime", `${hubId}.json`);
}

export function writeRuntimeState(state: HubRuntimeState): void {
  const parsed = runtimeReadSchema.parse(state);
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
    const value = runtimeReadSchema.parse(JSON.parse(raw));
    if (hubId && value.hubId !== hubId) throw new Error("Wrong owner");
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
  | { state: "unknown"; runtime: RuntimeState | null; reason: "probe_failed" | "pid_unknown" | "hub_mismatch" | "runtime_invalid" };

function observePid(pid: number): "present" | "missing" | "unknown" {
  try { process.kill(pid, 0); return "present"; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH" ? "missing" : "unknown"; }
}

async function observe(file: string, hubId: string): Promise<BridgeObservation> {
  let runtime: RuntimeState | null;
  try { runtime = readRuntime(file, hubId); }
  catch { return { state: "unknown", runtime: null, reason: "runtime_invalid" }; }
  if (!runtime) return { state: "stopped", runtime: null, reason: "runtime_missing" };
  const pid = observePid(runtime.pid);
  if (pid === "missing") return { state: "stopped", runtime, reason: "pid_missing" };
  const health = await probeBridge(runtime.port);
  const matches = health && health.hubId === hubId;
  if (matches) return { state: "healthy", runtime };
  if (health) return { state: "unknown", runtime, reason: "hub_mismatch" };
  return { state: "unknown", runtime, reason: pid === "unknown" ? "pid_unknown" : "probe_failed" };
}

/** Native discovery never reads workspace-owned runtime files. */
export async function findBridgeObservation(hubId: string): Promise<BridgeObservation> {
  readConfiguredHub(hubId);
  return observe(runtimeFile(hubId), hubId);
}

export async function findLiveBridge(hubId: string): Promise<RuntimeState | null> {
  const observation = await findBridgeObservation(hubId);
  return observation.state === "healthy" ? observation.runtime : null;
}

export { SERVICE_NAME, VERSION };
