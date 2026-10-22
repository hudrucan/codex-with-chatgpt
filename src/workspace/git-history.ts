import { TextDecoder } from "node:util";
import ignore from "ignore";
import { chunkSafePaths, GitDiffError, streamGit, utf8PageEnd } from "./git.js";
import type { Workspace } from "./manager.js";

const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const MAX_INVENTORY_BYTES = 16 * 1024 * 1024;
const MAX_COMMITS = 10_000;
const DIFF_FLAGS = ["--no-ext-diff", "--no-textconv", "--no-color", "--no-relative"];
let activeReads = 0;
type HistoryRead = (args: string[], maxBytes?: number) => Promise<Buffer>;

interface Change { paths: string[]; blobs: string[]; status: string }

function invalidHistory(): never {
  throw new GitDiffError("GIT_HISTORY_UNAVAILABLE", "Git history is incomplete or cannot be safely read.");
}

function tooLarge(): never {
  throw new GitDiffError("GIT_HISTORY_TOO_LARGE", "Git history exceeds the bounded read budget.");
}

/** One request deadline covers inventory, policy checks and all patch batches. */
async function withHistoryReader<T>(root: string, signal: AbortSignal | undefined, consume: (read: HistoryRead) => Promise<T>): Promise<T> {
  if (activeReads >= 2) throw new GitDiffError("GIT_HISTORY_BUSY", "Two history reads are already running; retry later.");
  activeReads++;
  const timeout = AbortSignal.timeout(30_000);
  const deadline = AbortSignal.any([timeout, ...(signal ? [signal] : [])]);
  const read: HistoryRead = async (args, maxBytes = MAX_INVENTORY_BYTES) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    await streamGit(root, args, chunk => {
      bytes += chunk.length;
      if (bytes > maxBytes) tooLarge();
      chunks.push(chunk);
    }, deadline, true);
    return Buffer.concat(chunks, bytes);
  };
  try { return await consume(read); }
  catch (error) {
    if (error instanceof GitDiffError && error.code === "GIT_ABORTED" &&
        timeout.aborted && deadline.reason === timeout.reason)
      throw new GitDiffError("GIT_TIMEOUT", "Git history exceeded its 30-second request deadline.");
    throw error;
  }
  finally { activeReads--; }
}

function decode(bytes: Buffer): string {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { return invalidHistory(); }
}

/** Git paths are lexical tree entries, never paths resolved through today's symlinks. */
function validPath(file: string): boolean {
  return !!file && !file.includes("\\") && !file.startsWith("/") &&
    file.split("/").every(part => part !== "" && part !== "." && part !== "..");
}

async function readHistory(workspace: Workspace, read: HistoryRead, commit?: string) {
  if (decode(await read(["rev-parse", "--is-shallow-repository"], 1024)).trim() !== "false") invalidHistory();
  const prefix = decode(await read(["rev-parse", "--show-prefix"], 4096)).replace(/\n$/, "");
  if (prefix && (!prefix.endsWith("/") || !validPath(prefix.slice(0, -1)))) invalidHistory();
  const raw = decode(await read([
    "log", "--all", "HEAD", ...(commit ? [commit] : []), `--max-count=${MAX_COMMITS + 1}`,
    "--full-history", "--root", "--diff-merges=separate", "--raw", "-z", "--no-abbrev",
    "--format=%H", "--no-show-signature", "--no-notes", "--no-decorate", "--find-renames=1%", ...DIFF_FLAGS,
    "--",
  ]));
  const tokens = raw.split("\0");
  if (tokens.pop() !== "") invalidHistory();
  const commits = new Map<string, Change[]>();
  const graph = new Map<string, Set<string>>();
  const denied = new Set<string>();
  const policyBlobs = new Set<string>();
  const link = (a: string, b: string): void => {
    if (!graph.has(a)) graph.set(a, new Set());
    if (!graph.has(b)) graph.set(b, new Set());
    graph.get(a)!.add(b); graph.get(b)!.add(a);
  };
  const relative = (file: string): string | undefined => {
    if (!file.startsWith(prefix)) return undefined;
    const rel = file.slice(prefix.length);
    return validPath(rel) ? rel : undefined;
  };
  let changes: Change[] | undefined;
  let changeCount = 0;
  for (let i = 0; i < tokens.length;) {
    const token = tokens[i++].replace(/^\n/, "");
    if (SHA.test(token)) {
      changes = commits.get(token) ?? [];
      commits.set(token, changes);
      if (commits.size > MAX_COMMITS) tooLarge();
      continue;
    }
    const match = /^:([0-7]{6}) ([0-7]{6}) ([a-f0-9]{40}|[a-f0-9]{64}) ([a-f0-9]{40}|[a-f0-9]{64}) ([AMDT]|[RC][0-9]+)$/.exec(token);
    if (!match || !changes) invalidHistory();
    if (++changeCount > 50_000) tooLarge();
    const paths = [tokens[i++]];
    if (/^[RC]/.test(match[5])) paths.push(tokens[i++]);
    if (paths.some(file => typeof file !== "string" || !validPath(file))) invalidHistory();
    const blobs = [match[3], match[4]].filter(id => !/^0+$/.test(id));
    changes.push({ paths, blobs, status: match[5] });
    // Taint paths across revisions, rename chains and identical blob copies. This
    // deliberately withholds later edits too, even after a secret was removed.
    for (const file of paths) {
      const node = `p:${file}`;
      link(node, `p:${paths[0]}`);
      for (const blob of blobs) link(node, `b:${blob}`);
      const rel = relative(file);
      if (rel === ".c2cignore") for (const blob of blobs) policyBlobs.add(blob);
      if (rel === undefined || rel === ".c2cignore" || workspace.ignoreRules.isSensitive(rel)) denied.add(node);
      if (!["100644", "100755", "000000"].includes(match[1]) ||
          !["100644", "100755", "000000"].includes(match[2])) denied.add(node);
    }
  }
  // Policy files may have been deleted or relaxed since the commit. Apply every
  // recorded version independently so a later negation cannot unhide old data.
  if (policyBlobs.size > 100) tooLarge();
  for (const blob of policyBlobs) {
    const policy = ignore().add(decode(await read(["cat-file", "blob", blob], 64 * 1024)));
    for (const node of graph.keys()) {
      if (!node.startsWith("p:")) continue;
      const rel = relative(node.slice(2));
      if (rel !== undefined && policy.ignores(rel)) denied.add(node);
    }
  }
  // Rename detection is heuristic. Connect deletions to additions in the same
  // commit as well, so a completely rewritten rename cannot bypass the policy.
  for (const [id, entries] of commits) {
    if (entries.some(entry => entry.status === "D") && entries.some(entry => entry.status === "A")) {
      for (const entry of entries) {
        if (entry.status === "A" || entry.status === "D") link(`p:${entry.paths[0]}`, `transfer:${id}`);
      }
    }
  }
  const queue = [...denied];
  for (let i = 0; i < queue.length; i++) {
    for (const next of graph.get(queue[i]) ?? []) {
      if (!denied.has(next)) { denied.add(next); queue.push(next); }
    }
  }
  const safePaths = (changes: Change[], scope?: string): string[] => [...new Set(changes.flatMap(change => {
    if (change.paths.some(file => denied.has(`p:${file}`))) return [];
    return change.paths.filter(file => {
      const rel = relative(file)!;
      return !scope || rel === scope || rel.startsWith(scope + "/");
    });
  }))];
  return { commits, safePaths, prefix };
}

export async function gitLog(workspace: Workspace, opts: { limit?: number; path?: string; signal?: AbortSignal } = {}) {
  const scope = opts.path === undefined ? undefined : workspace.resolve(opts.path).rel;
  const limit = opts.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new GitDiffError("INVALID_LIMIT", "limit must be between 1 and 100.");
  return withHistoryReader(workspace.root, opts.signal, async read => {
    const { commits, safePaths, prefix } = await readHistory(workspace, read);
    const ids = decode(await read(["rev-list", "--topo-order", `--max-count=${MAX_COMMITS + 1}`, "HEAD", "--"])).trim().split("\n");
    if (ids.length > MAX_COMMITS || ids.some(id => !SHA.test(id) || !commits.has(id))) invalidHistory();
    const visible = ids.filter(id => safePaths(commits.get(id)!, scope).length > 0);
    const selected = visible.slice(0, limit);
    const summaries = new Map<string, { subject: string; subjectTruncated: boolean; date: string }>();
    if (selected.length > 0) {
      // Fetch metadata only for visible commits. A subject is untrusted text;
      // normalization and truncation do not redact arbitrary secrets in it.
      const tokens = decode(await read([
        "log", "--no-walk=unsorted", "--format=%H%x00%cI%x00%s", "-z",
        "--no-show-signature", "--no-notes", "--no-decorate", ...selected, "--",
      ])).split("\0");
      if (tokens.pop() !== "" || tokens.length !== selected.length * 3) invalidHistory();
      for (let i = 0; i < tokens.length; i += 3) {
        const [sha, rawDate, rawSubject] = tokens.slice(i, i + 3);
        const date = new Date(rawDate);
        if (!selected.includes(sha) || summaries.has(sha) || !Number.isFinite(date.getTime())) invalidHistory();
        const subject = Buffer.from(rawSubject.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ").trim());
        const page = subject.subarray(0, 256);
        summaries.set(sha, { date: date.toISOString(), subject: decode(page.subarray(0, utf8PageEnd(page))), subjectTruncated: subject.length > 256 });
      }
    }
    return {
      commits: selected.map(sha => {
        const paths = safePaths(commits.get(sha)!, scope).map(file => file.slice(prefix.length));
        // Omit overlong paths instead of returning unusable path fragments.
        const returned = paths.filter(file => Buffer.byteLength(file) <= 512).slice(0, 20);
        return { sha, ...summaries.get(sha)!, paths: returned, pathsTruncated: returned.length < paths.length };
      }),
      hasMore: visible.length > limit,
    };
  });
}

export async function gitShow(workspace: Workspace, opts: { commit: string; path?: string; maxBytes?: number; signal?: AbortSignal }) {
  if (!SHA.test(opts.commit)) throw new GitDiffError("INVALID_COMMIT", "commit must be a full lowercase commit SHA (40 or 64 hex characters).");
  const scope = opts.path === undefined ? undefined : workspace.resolve(opts.path).rel;
  const maxBytes = opts.maxBytes ?? 65536;
  if (!Number.isInteger(maxBytes) || maxBytes < 1024 || maxBytes > 262144) throw new GitDiffError("INVALID_LIMIT", "max_bytes must be between 1024 and 262144.");
  return withHistoryReader(workspace.root, opts.signal, async read => {
    const verified = decode(await read(["rev-parse", "--verify", `${opts.commit}^{commit}`], 1024)).trim();
    if (verified !== opts.commit) invalidHistory();
    // Object existence also includes alternates; only HEAD ancestry grants access.
    await read(["merge-base", "--is-ancestor", opts.commit, "HEAD"], 1024);
    const { commits, safePaths, prefix } = await readHistory(workspace, read, opts.commit);
    if (!commits.has(opts.commit)) invalidHistory();
    const parents = decode(await read(["rev-list", "--parents", "-n", "1", opts.commit, "--"], 8192)).trim().split(" ");
    if (parents.some(id => !SHA.test(id))) invalidHistory();
    // A merge is explicitly compared with its first parent, never a combined diff.
    const revisions = parents.length > 1 ? [parents[1], opts.commit] : [opts.commit];
    const page = Buffer.alloc(maxBytes);
    let bytes = 0;
    let totalBytes = 0;
    for (const batch of chunkSafePaths(safePaths(commits.get(opts.commit)!, scope))) {
      const patch = await read([
        "diff-tree", "--root", "--no-commit-id", "-r", "-p", ...DIFF_FLAGS,
        "--no-renames", "--submodule=short", "--src-prefix=a/", "--dst-prefix=b/",
        `--relative=${prefix}`,
        "--diff-algorithm=myers", "--unified=3", ...revisions, "--", ...batch.map(file => `:(top,literal)${file}`),
      ], MAX_INVENTORY_BYTES - totalBytes);
      decode(patch);
      totalBytes += patch.length;
      const count = Math.min(patch.length, maxBytes - bytes);
      patch.copy(page, bytes, 0, count);
      bytes += count;
    }
    // A trailing partial UTF-8 character is withheld, never replaced in the patch.
    bytes = bytes > 0 ? utf8PageEnd(page.subarray(0, bytes)) : 0;
    const diff = decode(page.subarray(0, bytes));
    return { commit: opts.commit, comparison: parents.length > 1 ? "first-parent" as const : "root" as const,
      totalBytes, returnedBytes: bytes, truncated: bytes < totalBytes, diff };
  });
}
