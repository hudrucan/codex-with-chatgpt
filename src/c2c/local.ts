import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { ensureDir } from "../config/paths.js";
import { stateFile } from "../config/state-files.js";
import { sourceFingerprint } from "./source.js";

export const localAccess = {
  claimTask(taskId: string): void {
    // Exclusive zero-byte claims remain valid across process/module restarts.
    const claim = stateFile("async-tasks", createHash("sha256").update(taskId).digest("hex"));
    ensureDir(path.dirname(claim));
    stateFile("async-tasks", path.basename(claim));
    try { fs.closeSync(fs.openSync(claim, "wx", 0o600)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("ASYNC_RESUME_UNSUPPORTED: This task is already claimed; stop async and use the manual workflow.");
      throw error;
    }
  },
  sourceFingerprint,
  async resolveProject(workspaceId: string, hubId?: string): Promise<string> {
    const { resolveAuditProject } = await import("./project.js");
    return resolveAuditProject(workspaceId, hubId);
  },
};
