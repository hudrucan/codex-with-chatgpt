import fs from "node:fs";
import path from "node:path";
import type { z } from "zod";
import { ensureDir, getStateDir, writeSecureJson } from "../config/paths.js";
import { hubIdSchema, withHubControlPlane } from "./store.js";
export function resourceFile(resource: "tunnel" | "endpoint", hubId: string): string {
  if (!hubIdSchema.safeParse(hubId).success)
    throw new Error("HUB_STATE_INVALID: Invalid Hub ID.");
  return path.join(getStateDir(), `${resource}s`, `${hubId}.json`);
}
/** Serialize adoption and local updates; remote operations never run here. */
export function withHubResource<T extends {
  hubId: string;
}, L extends {
  workspaceId: string;
}, R>(hubId: string, resource: "tunnel" | "endpoint", schema: z.ZodType<T>, legacySchema: z.ZodType<L>, empty: T, operation: (current: T, save: (value: T) => T) => R): R {
  const file = resourceFile(resource, hubId);
  const conflict = () => new Error(`${resource.toUpperCase()}_STATE_CONFLICT: Invalid ownership, format or conflicting adoption state.`);
  const read = (target: string): string | null => {
    try {
      return fs.readFileSync(target, "utf8");
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return null;
      throw conflict();
    }
  };
  const parse = <V>(raw: string, validator: z.ZodType<V>): V => {
    try {
      return validator.parse(JSON.parse(raw));
    }
    catch {
      throw conflict();
    }
  };
  return withHubControlPlane(hubId, (control) => {
    const locks: {
      file: string;
      fd: number;
    }[] = [];
    const lock = (target: string) => {
      ensureDir(path.dirname(target));
      try {
        locks.push({ file: `${target}.lock`, fd: fs.openSync(`${target}.lock`, "wx", 0o600) });
      }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST")
          throw error;
        throw new Error(`${resource.toUpperCase()}_STATE_BUSY: Another local operation holds the state lock.`);
      }
    };
    try {
      lock(file);
      const save = (value: T): T => {
        const parsed = parse(JSON.stringify(value), schema);
        if (parsed.hubId !== hubId)
          throw conflict();
        writeSecureJson(file, parsed);
        return parsed;
      };
      const raw = read(file);
      let current = raw === null ? null : parse(raw, schema);
      if (current && current.hubId !== hubId)
        throw conflict();
      if (!control[resource === "tunnel" ? "tunnelInitialized" : "endpointInitialized"]) {
        const owner = control.hub.legacyOwnerWorkspaceId;
        if (!owner)
          throw conflict();
        const source = path.join(getStateDir(), `${resource}s`, `${owner}.json`);
        lock(source);
        const legacyRaw = read(source);
        let expected = empty;
        if (legacyRaw !== null) {
          const legacy = parse(legacyRaw, legacySchema);
          if (legacy.workspaceId !== owner)
            throw conflict();
          const { workspaceId: _owner, ...fields } = legacy;
          expected = parse(JSON.stringify({ ...fields, version: 1, hubId }), schema);
        }
        if (current && JSON.stringify(current) !== JSON.stringify(expected))
          throw conflict();
        if (!current)
          current = save(expected);
        if (read(source) !== legacyRaw)
          throw conflict();
        control.completeResourceAdoption(resource);
      }
      if (!current) {
        if (control.hub.legacyOwnerWorkspaceId)
          throw conflict();
        current = save(empty);
      }
      return operation(current, save);
    }
    finally {
      for (const lock of locks.reverse()) {
        fs.closeSync(lock.fd);
        fs.unlinkSync(lock.file);
      }
    }
  });
}
