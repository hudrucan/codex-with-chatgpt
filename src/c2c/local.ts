import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { ensureDir } from "../config/paths.js";
import { stateFile } from "../config/state-files.js";
import { sourceFingerprint } from "./source.js";
import type { LocalAccess } from "./controller.js";

export const localAccess: LocalAccess = {
  claimTask(taskId) {
    // The same exclusive, zero-byte claim is used by Node and the REPL helper.
    const claim = stateFile("async-tasks", createHash("sha256").update(taskId).digest("hex"));
    ensureDir(path.dirname(claim));
    stateFile("async-tasks", path.basename(claim));
    try { fs.closeSync(fs.openSync(claim, "wx", 0o600)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("ASYNC_RESUME_UNSUPPORTED: Retain the original handle or stop async for this task.");
      throw error;
    }
  },
  sourceFingerprint,
  async resolveProject(workspaceId, hubId) {
    const { resolveAuditProject } = await import("./project.js");
    return resolveAuditProject(workspaceId, hubId);
  },
};
