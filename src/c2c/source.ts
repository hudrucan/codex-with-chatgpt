import fs from "node:fs";
import path from "node:path";
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
  const sourcePaths = new Set(files);
  let budget = 64 * 1024 * 1024;
  for (const file of files) {
    const sensitive = workspace.ignoreRules.isSensitive(file);
    // Sensitive content is never read, including for local hashing. Only its
    // filesystem metadata participates in drift detection.
    const parent = path.posix.dirname(file);
    const resolvedParent = workspace.resolve(parent, { allowSensitive: true });
    // Only leaf links are supported; never traverse a symlinked source directory.
    if (resolvedParent.rel !== (parent === "." ? "" : parent))
      throw new Error("ASYNC_SOURCE_UNAVAILABLE: Unsupported source path.");
    const absolute = path.join(resolvedParent.abs, path.posix.basename(file));
    add(file);
    let stat: fs.BigIntStats;
    try { stat = fs.lstatSync(absolute, { bigint: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      add("deleted"); continue;
    }
    if (stat.isSymbolicLink()) {
      if (sensitive || stat.size > BigInt(budget))
        throw new Error("ASYNC_SOURCE_UNAVAILABLE: Unsupported source link.");
      const link = fs.readlinkSync(absolute, { encoding: "buffer" });
      const targetPath = path.relative(workspace.root, path.resolve(resolvedParent.abs, link.toString("utf8"))).split(path.sep).join("/");
      const target = workspace.resolve(targetPath);
      // Target bytes are covered by their own Git-visible entry, never read via the alias.
      if (target.rel !== targetPath || !sourcePaths.has(target.rel) || !fs.lstatSync(target.abs).isFile())
        throw new Error("ASYNC_SOURCE_UNAVAILABLE: Unsupported source link.");
      budget -= link.length;
      if (budget < 0) throw new Error("ASYNC_SOURCE_UNAVAILABLE: Source budget exceeded.");
      add("symlink"); add(String(stat.mode)); add(link);
      continue;
    }
    if (!stat.isFile()) throw new Error("ASYNC_SOURCE_UNAVAILABLE: Expected regular source files.");
    const resolved = workspace.resolve(file, { allowSensitive: sensitive });
    if (resolved.rel !== file) throw new Error("ASYNC_SOURCE_UNAVAILABLE: Unsupported source path.");
    add(String(stat.mode));
    if (sensitive) {
      add([stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String).join(":"));
      continue;
    }
    const fd = fs.openSync(resolved.abs, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const opened = fs.fstatSync(fd, { bigint: true });
      if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino)
        throw new Error("ASYNC_SOURCE_UNAVAILABLE: Source changed while opening.");
      if (opened.size > BigInt(budget))
        throw new Error("ASYNC_SOURCE_UNAVAILABLE: Expected regular source files within a 64 MiB budget.");
      const bytes = fs.readFileSync(fd);
      budget -= bytes.length;
      if (budget < 0) throw new Error("ASYNC_SOURCE_UNAVAILABLE: Source budget exceeded.");
      add(bytes);
    } finally { fs.closeSync(fd); }
  }
  return hash.digest("hex");
}
