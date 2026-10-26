import fs from "node:fs";
import path from "node:path";
import type { z } from "zod";
import { ensureDir, writeSecureJson } from "../config/paths.js";
import { stateFile } from "../config/state-files.js";
import { hubIdSchema, withHubControlPlane } from "./store.js";
export function resourceFile(resource: "tunnel" | "endpoint", hubId: string): string {
  if (!hubIdSchema.safeParse(hubId).success)
    throw new Error("HUB_STATE_INVALID: Invalid Hub ID.");
  return stateFile(`${resource}s`, `${hubId}.json`);
}
/** Hub-owned state only. Missing authoritative files require explicit recovery. */
export function withHubResource<T extends {
  hubId: string;
}, R>(hubId: string, resource: "tunnel" | "endpoint", schema: z.ZodType<T>, operation: (current: T, save: (value: T) => T) => R): R {
  const file = resourceFile(resource, hubId);
  const parse = (raw: unknown) => {
    const parsed = schema.safeParse(raw);
    if (!parsed.success || parsed.data.hubId !== hubId)
      throw new Error(`${resource.toUpperCase()}_STATE_CONFLICT: Invalid ownership or format.`);
    return parsed.data;
  };
  return withHubControlPlane(hubId, () => {
    ensureDir(path.dirname(file));
    const lock = stateFile(`${resource}s`, `${hubId}.json.lock`);
    let fd: number;
    try {
      fd = fs.openSync(lock, "wx", 0o600);
    }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST")
        throw new Error(`${resource.toUpperCase()}_STATE_BUSY: Another local operation holds the lock.`, { cause: error });
      if (code === "EPERM" || code === "EACCES")
        throw new Error(`${resource.toUpperCase()}_STATE_ACCESS_DENIED: Cannot create the local state lock (${code}); state-directory write access is required.`, { cause: error });
      throw error;
    }
    try {
      let raw: unknown;
      try {
        raw = JSON.parse(fs.readFileSync(file, "utf8"));
      }
      catch {
        throw new Error(`${resource.toUpperCase()}_STATE_CONFLICT: Authoritative Hub state is missing or unreadable.`);
      }
      return operation(parse(raw), (value) => { const parsed = parse(value); writeSecureJson(file, parsed); return parsed; });
    }
    finally {
      fs.closeSync(fd);
      fs.unlinkSync(lock);
    }
  });
}
