import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { IgnoreRules } from "./ignore.js";

export interface GitCommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
}

export function runGit(root: string, args: string[]): GitCommandResult {
  const result = spawnSync("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", ...args], {
    cwd: root,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat" },
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 30_000,
    windowsHide: true,
  });
  return {
    ok: result.status === 0,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    code: result.status,
  };
}

export interface GitInfo {
  isRepo: boolean;
  branch: string | null;
  commit: string | null;
  dirty: boolean;
}

export function gitInfo(root: string): GitInfo {
  const check = runGit(root, ["rev-parse", "--is-inside-work-tree"]);
  if (!check.ok || check.stdout.trim() !== "true") {
    return { isRepo: false, branch: null, commit: null, dirty: false };
  }
  const branch = runGit(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const commit = runGit(root, ["rev-parse", "--short", "HEAD"]);
  // Pathspec confines the result to the workspace subtree even when the
  // workspace root sits inside a larger repository.
  const status = runGit(root, ["status", "--porcelain", "--", "."]);
  return {
    isRepo: true,
    branch: branch.ok ? branch.stdout.trim() : null,
    commit: commit.ok ? commit.stdout.trim() : null,
    dirty: status.ok ? status.stdout.trim().length > 0 : false,
  };
}

export interface WorkspaceLike {
  root: string;
  ignoreRules?: IgnoreRules;
}

export type GitTarget = string | WorkspaceLike;

export interface GitStatusResult {
  isRepo: boolean;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  staged: { path: string; change: string }[];
  unstaged: { path: string; change: string }[];
  untracked: string[];
  conflicted: string[];
  /** Sensitive entries withheld. `conflicts` stays separate so a merge is not reported as clean. */
  hidden: { changes: number; conflicts: number };
}

export function gitStatus(target: GitTarget): GitStatusResult {
  const root = typeof target === "string" ? target : target.root;
  const ignoreRules =
    typeof target === "object" && target.ignoreRules ? target.ignoreRules : new IgnoreRules(root);
  const empty: GitStatusResult = {
    isRepo: false,
    branch: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    staged: [],
    unstaged: [],
    untracked: [],
    conflicted: [],
    hidden: { changes: 0, conflicts: 0 },
  };
  const result = runGit(root, ["status", "--porcelain=v2", "--branch", "--", "."]);
  if (!result.ok) return empty;
  const out: GitStatusResult = { ...empty, hidden: { ...empty.hidden }, isRepo: true };
  const withheld = (paths: string[]): boolean => paths.some((p) => ignoreRules.isSensitive(p));

  for (const line of result.stdout.split("\n")) {
    if (line.startsWith("# branch.head ")) {
      out.branch = line.slice("# branch.head ".length).trim();
    } else if (line.startsWith("# branch.upstream ")) {
      out.upstream = line.slice("# branch.upstream ".length).trim();
    } else if (line.startsWith("# branch.ab ")) {
      const m = line.match(/\+(\d+) -(\d+)/);
      if (m) {
        out.ahead = parseInt(m[1], 10);
        out.behind = parseInt(m[2], 10);
      }
    } else if (line.startsWith("1 ") || line.startsWith("2 ")) {
      const parts = line.split(" ");
      const xy = parts[1] ?? "";
      const isRename = line.startsWith("2 ");
      const destination = isRename
        ? (line.split("\t")[0]?.split(" ").slice(9).join(" ") ?? "")
        : parts.slice(8).join(" ");
      const origin = isRename ? (line.split("\t")[1] ?? "") : null;
      const rawPaths = origin === null ? [destination] : [destination, origin];
      const filePath = origin === null ? destination : `${destination} -> ${origin}`;
      if (withheld(rawPaths)) {
        out.hidden.changes += (xy[0] !== "." ? 1 : 0) + (xy[1] !== "." ? 1 : 0);
        continue;
      }
      if (xy[0] !== ".") out.staged.push({ path: filePath, change: xy[0] });
      if (xy[1] !== ".") out.unstaged.push({ path: filePath, change: xy[1] });
    } else if (line.startsWith("? ")) {
      const filePath = line.slice(2);
      if (withheld([filePath])) out.hidden.changes += 1;
      else out.untracked.push(filePath);
    } else if (line.startsWith("u ")) {
      const filePath = line.split(" ").slice(10).join(" ");
      if (withheld([filePath])) out.hidden.conflicts += 1;
      else out.conflicted.push(filePath);
    }
  }
  return out;
}

export type DiffMode = "unstaged" | "staged" | "head";

export interface GitDiffOptions {
  mode?: DiffMode;
  path?: string;
  offset?: number;
  maxBytes?: number;
}

export interface GitDiffResult {
  isRepo: boolean;
  mode: DiffMode;
  totalBytes: number;
  offset: number;
  returnedBytes: number;
  hasMore: boolean;
  nextOffset: number | null;
  diff: string;
}

function getDiffModeArgs(mode: DiffMode): string[] {
  if (mode === "staged") return ["--cached"];
  if (mode === "head") return ["HEAD"];
  return [];
}

function chunkSafePaths(paths: string[], maxCount = 50, maxBytes = 32 * 1024): string[][] {
  const batches: string[][] = [];
  let currentBatch: string[] = [];
  let currentBytes = 0;

  for (const p of paths) {
    const pBytes = Buffer.byteLength(p, "utf8") + 12; // overhead for ":(literal)"
    if (
      currentBatch.length > 0 &&
      (currentBatch.length >= maxCount || currentBytes + pBytes > maxBytes)
    ) {
      batches.push(currentBatch);
      currentBatch = [];
      currentBytes = 0;
    }
    currentBatch.push(p);
    currentBytes += pBytes;
  }
  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }
  return batches;
}

function isPathInScope(filePath: string, scope?: string): boolean {
  if (!scope || scope === ".") return true;
  return filePath === scope || filePath.startsWith(scope + "/");
}

const MAX_GIT_INVENTORY_BYTES = 64 * 1024 * 1024;
const MAX_AGGREGATE_DIFF_BYTES = 64 * 1024 * 1024;
const MAX_GIT_STDERR_BYTES = 64 * 1024;
const GIT_PROCESS_TIMEOUT_MS = 30_000;

/** Drain each process completely; failure is reported only after its streams close. */
function streamGit(root: string, args: string[], consume: (chunk: Buffer) => boolean): Promise<boolean> {
  return new Promise(resolve => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", ...args], {
        cwd: root,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat" },
        windowsHide: true,
      });
    } catch { resolve(false); return; }
    let failed = false;
    let stderrBytes = 0;
    const fail = (): void => {
      if (failed) return;
      failed = true;
      try { child.kill("SIGKILL"); }
      catch { /* Still wait for close; never resolve with partial output. */ }
    };
    const timer = setTimeout(fail, GIT_PROCESS_TIMEOUT_MS);
    child.on("error", fail);
    child.stdin.on("error", fail);
    child.stdout.on("error", fail);
    child.stderr.on("error", fail);
    child.stdin.end();
    child.stdout.on("data", (chunk: Buffer) => {
      if (failed) return;
      try { if (!consume(chunk)) fail(); }
      catch { fail(); }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (failed) return;
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_GIT_STDERR_BYTES) fail();
    });
    child.once("close", code => {
      clearTimeout(timer);
      resolve(!failed && code === 0);
    });
  });
}

/** A page without a newline may end in the middle of a multibyte code point. */
function utf8PageEnd(page: Buffer): number {
  let start = page.length - 1;
  while (start > 0 && (page[start] & 0xc0) === 0x80) start--;
  const lead = page[start];
  const width = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  return start + width > page.length ? start : page.length;
}

export async function gitDiff(
  target: GitTarget,
  opts: GitDiffOptions = {},
  relPath?: string
): Promise<GitDiffResult> {
  const root = typeof target === "string" ? target : target.root;
  const ignoreRules =
    typeof target === "object" && target.ignoreRules
      ? target.ignoreRules
      : new IgnoreRules(root);

  const mode = opts.mode ?? "unstaged";
  const offset = Math.max(0, Math.floor(opts.offset ?? 0));
  const maxBytes = Math.min(256 * 1024, Math.max(1024, Math.floor(opts.maxBytes ?? 64 * 1024)));
  const modeArgs = getDiffModeArgs(mode);
  const failure: GitDiffResult = {
    isRepo: false, mode, totalBytes: 0, offset: 0, returnedBytes: 0,
    hasMore: false, nextOffset: null, diff: "",
  };

  // 1. Full-workspace inventory using NUL separation and global rename detection
  const listArgs = [
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--name-status",
    "-z",
    "--find-renames=1%",
    ...modeArgs,
    "--",
    ".",
  ];
  let inventory: Buffer[] = [];
  let inventoryBytes = 0;
  const listed = await streamGit(root, listArgs, chunk => {
    if (inventoryBytes + chunk.length > MAX_GIT_INVENTORY_BYTES) return false;
    inventory.push(chunk);
    inventoryBytes += chunk.length;
    return true;
  });
  if (!listed) return failure;
  const tokens = Buffer.concat(inventory, inventoryBytes).toString("utf8").split("\0");
  inventory = [];
  // Never use a partial inventory, even if a process unexpectedly exits successfully.
  if (tokens.pop() !== "") return failure;
  const safePaths: string[] = [];
  for (let i = 0; i < tokens.length; ) {
    const status = tokens[i++];
    if (!status) return failure;
    if (status.startsWith("R") || status.startsWith("C")) {
      const oldPath = tokens[i++];
      const newPath = tokens[i++];
      if (!oldPath || !newPath) return failure;
      // Layer 1: Security - EITHER side sensitive -> completely unsafe
      const isSafe = !ignoreRules.isSensitive(oldPath) && !ignoreRules.isSensitive(newPath);
      // Layer 2: Scope - EITHER side in scope -> relevant
      const isRelevant = isPathInScope(oldPath, relPath) || isPathInScope(newPath, relPath);
      if (isSafe && isRelevant) {
        safePaths.push(oldPath, newPath);
      }
    } else {
      const filePath = tokens[i++];
      if (!filePath) return failure;
      const isSafe = !ignoreRules.isSensitive(filePath);
      const isRelevant = isPathInScope(filePath, relPath);
      if (isSafe && isRelevant) {
        safePaths.push(filePath);
      }
    }
  }

  if (safePaths.length === 0) return { ...failure, isRepo: true };

  // 2. Count every safe diff byte, retaining only the requested page across batches.
  const batches = chunkSafePaths(safePaths);
  const page = Buffer.allocUnsafe(maxBytes);
  let pageBytes = 0;
  let totalBytes = 0;

  for (const batch of batches) {
    const pathspecs = batch.map((p) => `:(literal)${p}`);
    const diffArgs = [
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
      "--find-renames=1%",
      ...modeArgs,
      "--",
      ...pathspecs,
    ];
    const completed = await streamGit(root, diffArgs, chunk => {
      if (totalBytes + chunk.length > MAX_AGGREGATE_DIFF_BYTES) return false;
      const skip = Math.max(0, offset - totalBytes);
      if (skip < chunk.length && pageBytes < maxBytes) {
        const count = Math.min(chunk.length - skip, maxBytes - pageBytes);
        chunk.copy(page, pageBytes, skip, skip + count);
        pageBytes += count;
      }
      totalBytes += chunk.length;
      return true;
    });
    if (!completed) return failure;
  }

  let slice = page.subarray(0, pageBytes);
  // Keep newline trimming byte-based; sequential page offsets must not drift on UTF-8.
  if (offset + slice.length < totalBytes) {
    const lastNewline = slice.lastIndexOf(0x0a);
    slice = slice.subarray(0, lastNewline > 0 ? lastNewline + 1 : utf8PageEnd(slice));
  }
  const sliceLen = slice.length;
  const text = slice.toString("utf8");
  const hasMore = offset + sliceLen < totalBytes;
  return {
    isRepo: true,
    mode,
    totalBytes,
    offset,
    returnedBytes: sliceLen,
    hasMore,
    nextOffset: hasMore ? offset + sliceLen : null,
    diff: text,
  };
}
