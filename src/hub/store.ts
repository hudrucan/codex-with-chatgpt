import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ensureDir, writeSecureJson } from "../config/paths.js";
import { stateFile } from "../config/state-files.js";
export const hubIdSchema = z.string().regex(/^hub-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
export const hubSchema = z.object({ version: z.literal(1), hubId: hubIdSchema,
  displayName: z.string().trim().min(1).refine((name) => !/[\x00-\x1f\x7f]/.test(name)),
  createdAt: z.string().datetime(),
}).strict();
export type Hub = z.infer<typeof hubSchema>;
export class HubError extends Error {
  constructor(public code: string, message: string) { super(`${code}: ${message}`); this.name = "HubError"; }
}
export function hubFile(hubId: string): string {
  if (!hubIdSchema.safeParse(hubId).success)
    throw new HubError("HUB_STATE_INVALID", "Invalid Hub ID.");
  return stateFile("hubs", `${hubId}.json`);
}
export function readConfiguredHub(hubId: string): Hub {
  try {
    const hub = hubSchema.parse(JSON.parse(fs.readFileSync(hubFile(hubId), "utf8")));
    if (hub.hubId !== hubId)
      throw new Error("Wrong Hub owner");
    return hub;
  }
  catch {
    throw new HubError("HUB_STATE_INVALID", "Hub identity is missing, malformed or has conflicting ownership.");
  }
}
export function listHubs(): Hub[] {
  const directory = path.dirname(stateFile("hubs", ".lock"));
  let names: string[];
  try {
    names = fs.readdirSync(directory);
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return [];
    throw error;
  }
  return names.filter((name) => name.endsWith(".json")).sort().map((name) => readConfiguredHub(name.slice(0, -5)));
}
/** Deterministic discovery only. A repo never selects or creates a connection. */
export function resolveHub(selector?: string): Hub {
  const hubs = listHubs();
  const hub = selector ? hubs.find((entry) => entry.hubId === selector) : hubs.length === 1 ? hubs[0] : undefined;
  if (!hub) {
    if (selector)
      throw new HubError("HUB_NOT_CONFIGURED", "The selected Hub is not configured.");
    if (!hubs.length)
      throw new HubError("HUB_NOT_CONFIGURED", "Run c2c setup to create a Hub.");
    throw new HubError("HUB_SELECTION_REQUIRED", `Select --hub <id>: ${hubs.map((entry) => `${entry.displayName} (${entry.hubId})`).join(", ")}`);
  }
  return hub;
}
export function withHubLock<T>(operation: () => T): T {
  const file = stateFile("hubs", ".lock");
  ensureDir(path.dirname(file));
  let fd: number;
  try {
    fd = fs.openSync(file, "wx", 0o600);
  }
  catch {
    throw new HubError("HUB_STATE_BUSY", "Another local Hub operation holds the lock.");
  }
  try {
    return operation();
  }
  finally {
    fs.closeSync(fd);
    fs.unlinkSync(file);
  }
}
export function withHubControlPlane<T>(hubId: string, operation: (state: {
  hub: Hub;
}) => T): T {
  return withHubLock(() => operation({ hub: readConfiguredHub(hubId) }));
}
/** Initialize complete native state before publishing the independent identity. */
export function createHub(displayName: string): Hub {
  return withHubLock(() => {
    const hub = hubSchema.parse({ version: 1, hubId: `hub-${randomUUID()}`, displayName, createdAt: new Date().toISOString() });
    for (const [directory, value] of [
      ["auth", { version: 1, hubId: hub.hubId, clients: [], tokens: [] }],
      ["workspace-registries", { version: 2, hubId: hub.hubId, workspaces: [] }],
      ["tunnels", { version: 1, hubId: hub.hubId, preference: "unset" }],
      ["endpoints", { version: 1, hubId: hub.hubId, empty: true }],
    ] as const)
      writeSecureJson(stateFile(directory, `${hub.hubId}.json`), value);
    writeSecureJson(hubFile(hub.hubId), hub);
    return hub;
  });
}
export function renameHub(hubId: string, displayName: string): Hub {
  return withHubControlPlane(hubId, ({ hub }) => {
    const next = hubSchema.parse({ ...hub, displayName });
    writeSecureJson(hubFile(hubId), next);
    return next;
  });
}
