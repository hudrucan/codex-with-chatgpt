import fs from "node:fs";
import { createHash } from "node:crypto";
import { Workspace } from "../workspace/manager.js";
import { runGit } from "../workspace/git.js";

/** Local only: HEAD, index and Git-visible file bytes, never a handoff-text hash. */
export function sourceFingerprint(root: string, workspaceId: string): string {
  const workspace = new Workspace(root);
  if (workspace.id !== workspaceId) throw new Error("ASYNC_SOURCE_WORKSPACE_MISMATCH");
  const git = (args: string[]) => {
    const result = runGit(workspace.root, args);
    if (!result.ok) throw new Error("ASYNC_SOURCE_UNAVAILABLE: Cannot read local Git state.");
    return result.stdout;
  };
  const hash = createHash("sha256");
  // Length framing keeps path, metadata and arbitrary file bytes unambiguous.
  const add = (value: string | Buffer) => { hash.update(`${Buffer.byteLength(value)}:`); hash.update(value); };
  add(git(["rev-parse", "--verify", "HEAD"]));
  add(git(["ls-files", "--stage", "-z", "--", "."]));
  const files = [...new Set(git(["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", "."])
    .split("\0").filter(Boolean))].sort();
  let budget = 64 * 1024 * 1024;
  for (const file of files) {
    const sensitive = workspace.ignoreRules.isSensitive(file);
    // Sensitive content is never read, including for local hashing. Only its
    // filesystem metadata participates in drift detection.
    const resolved = workspace.resolve(file, { allowSensitive: sensitive });
    // Do not silently fingerprint another canonical path or follow a link.
    if (resolved.rel !== file) throw new Error("ASYNC_SOURCE_UNAVAILABLE: Unsupported source path.");
    add(file);
    let stat: fs.BigIntStats;
    try { stat = fs.lstatSync(resolved.abs, { bigint: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      add("deleted"); continue;
    }
    if (!stat.isFile()) throw new Error("ASYNC_SOURCE_UNAVAILABLE: Expected regular source files.");
    add(String(stat.mode));
    if (sensitive) {
      add([stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String).join(":"));
      continue;
    }
    if (stat.size > BigInt(budget))
      throw new Error("ASYNC_SOURCE_UNAVAILABLE: Expected regular source files within a 64 MiB budget.");
    const bytes = fs.readFileSync(resolved.abs);
    budget -= bytes.length;
    if (budget < 0) throw new Error("ASYNC_SOURCE_UNAVAILABLE: Source budget exceeded.");
    add(bytes);
  }
  return hash.digest("hex");
}
