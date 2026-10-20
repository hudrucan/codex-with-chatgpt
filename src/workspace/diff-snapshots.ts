import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ensureDir } from "../config/paths.js";
import { stateFile } from "../config/state-files.js";
import { Workspace } from "./manager.js";
import { IgnoreRules } from "./ignore.js";
import { diffPage, GitDiffError, streamGitDiff, type DiffMode, type GitDiffResult } from "./git.js";

const TTL_MS = 10 * 60_000;
const PREPARATION_TIMEOUT_MS = 120_000;
const RESPONSE_WAIT_MS = 500;
const MAX_SNAPSHOTS = 4;
const MAX_PREPARING = 2;

interface Snapshot {
  id: string;
  workspaceId: string;
  owner: string;
  mode: DiffMode;
  path?: string;
  policy: string;
  expiresAt: number;
  controller: AbortController;
  expiry: NodeJS.Timeout;
  done: Promise<void>;
  totalBytes?: number;
  error?: GitDiffError;
}

export interface SnapshotPageOptions {
  mode: DiffMode;
  path?: string;
  snapshotId?: string;
  offset: number;
  maxBytes: number;
}

type SnapshotIdentity = { snapshotId: string; expiresAt: string };
export type DiffSnapshotPage = SnapshotIdentity & (
  | ({ status: "ready" } & GitDiffResult)
  | { status: "preparing"; retryAfterMs: number }
);

/** One store per running Hub, shared by its stateless HTTP transports. */
export class DiffSnapshots {
  private snapshots = new Map<string, Snapshot>();
  private directory?: string;
  private closed = false;

  constructor(private hubId: string) {}

  private file(id: string): string {
    // Recheck state containment on reads as well as initial creation.
    const directory = stateFile("diff-snapshots", path.basename(this.directory!));
    return path.join(directory, id);
  }

  private async remove(snapshot: Snapshot): Promise<void> {
    clearTimeout(snapshot.expiry);
    snapshot.controller.abort();
    await snapshot.done;
    fs.rmSync(this.file(snapshot.id), { force: true });
    this.snapshots.delete(snapshot.id);
  }

  private async create(workspace: Workspace, owner: string, opts: SnapshotPageOptions): Promise<Snapshot> {
    while (this.snapshots.size >= MAX_SNAPSHOTS) {
      const oldest = [...this.snapshots.values()].find(s => s.totalBytes !== undefined || s.error);
      if (!oldest) break;
      await this.remove(oldest);
    }
    if (this.snapshots.size >= MAX_SNAPSHOTS ||
        [...this.snapshots.values()].filter(s => s.totalBytes === undefined && !s.error).length >= MAX_PREPARING)
      throw new GitDiffError("DIFF_SNAPSHOT_BUSY", "Two diffs are already preparing; retry shortly.");
    if (!this.directory) {
      const prefix = stateFile("diff-snapshots", `${this.hubId}-`);
      ensureDir(path.dirname(prefix));
      // Reclaim only expired cache directories left by this Hub after a crash.
      for (const name of fs.readdirSync(path.dirname(prefix))) {
        if (!name.startsWith(`${this.hubId}-`) || !/^[A-Za-z0-9]{6}$/.test(name.slice(this.hubId.length + 1))) continue;
        const stale = stateFile("diff-snapshots", name);
        const stat = fs.lstatSync(stale);
        if (stat.isDirectory() && Date.now() - stat.mtimeMs >= TTL_MS) fs.rmSync(stale, { recursive: true });
      }
      this.directory = fs.mkdtempSync(prefix);
    }
    const id = randomUUID();
    const file = this.file(id);
    const fd = fs.openSync(file, "wx", 0o600);
    const controller = new AbortController();
    const snapshot: Snapshot = {
      id, workspaceId: workspace.id, owner, mode: opts.mode, path: opts.path,
      policy: workspace.ignoreRules.fingerprint, expiresAt: Date.now() + TTL_MS,
      controller, done: Promise.resolve(),
      expiry: setTimeout(() => { void this.remove(snapshot).catch(() => undefined); }, TTL_MS).unref(),
    };
    this.snapshots.set(id, snapshot);
    const deadline = setTimeout(() => controller.abort(), PREPARATION_TIMEOUT_MS).unref();
    snapshot.done = streamGitDiff(workspace, opts.mode, chunk => {
      let written = 0;
      while (written < chunk.length) {
        const count = fs.writeSync(fd, chunk, written, chunk.length - written);
        if (!count) throw new GitDiffError("DIFF_SNAPSHOT_IO_ERROR", "Cannot write the diff snapshot.");
        written += count;
      }
    }, opts.path, controller.signal).then(totalBytes => {
      snapshot.totalBytes = totalBytes;
    }).catch(error => {
      snapshot.error = controller.signal.aborted
        ? new GitDiffError("GIT_TIMEOUT", "Diff preparation exceeded its two-minute deadline.")
        : error instanceof GitDiffError ? error : new GitDiffError("DIFF_SNAPSHOT_IO_ERROR", "Cannot store the diff snapshot.");
    }).finally(() => {
      clearTimeout(deadline);
      fs.closeSync(fd);
      if (snapshot.error) fs.rmSync(file, { force: true });
    }).catch(() => {
      // Finalization can fail after an HTTP call has already returned preparing.
      snapshot.error = new GitDiffError("DIFF_SNAPSHOT_IO_ERROR", "Cannot finalize the diff snapshot.");
    });
    return snapshot;
  }

  async read(workspace: Workspace, owner: string, opts: SnapshotPageOptions): Promise<DiffSnapshotPage> {
    try {
      return await this.readPage(workspace, owner, opts);
    } catch (error) {
      if (error instanceof GitDiffError) throw error;
      throw new GitDiffError("DIFF_SNAPSHOT_IO_ERROR", "Cannot access the diff snapshot.");
    }
  }

  private async readPage(workspace: Workspace, owner: string, opts: SnapshotPageOptions): Promise<DiffSnapshotPage> {
    if (this.closed) throw new GitDiffError("DIFF_SNAPSHOT_UNAVAILABLE", "The snapshot store has stopped.");
    let snapshot: Snapshot;
    if (opts.snapshotId) {
      const found = this.snapshots.get(opts.snapshotId);
      if (!found || found.expiresAt <= Date.now() || found.workspaceId !== workspace.id || found.owner !== owner ||
          found.mode !== opts.mode || found.path !== opts.path) {
        throw new GitDiffError("DIFF_SNAPSHOT_UNAVAILABLE", "Snapshot expired or does not match this client, workspace, mode and path. Start a new diff at offset 0.");
      }
      snapshot = found;
    } else {
      if (opts.offset !== 0) throw new GitDiffError("DIFF_SNAPSHOT_REQUIRED", "Continue with the snapshot_id returned by the first page.");
      snapshot = await this.create(workspace, owner, opts);
    }
    // Finish small diffs in one call, but never hold a request open for a large preparation.
    let wait: NodeJS.Timeout | undefined;
    try {
      await Promise.race([snapshot.done, new Promise<void>(resolve => { wait = setTimeout(resolve, RESPONSE_WAIT_MS); })]);
    } finally { clearTimeout(wait); }
    if (!this.snapshots.has(snapshot.id) || snapshot.expiresAt <= Date.now())
      throw new GitDiffError("DIFF_SNAPSHOT_UNAVAILABLE", "Snapshot expired; start a new diff at offset 0.");
    if (snapshot.policy !== new IgnoreRules(workspace.root).fingerprint) {
      await this.remove(snapshot);
      throw new GitDiffError("DIFF_SNAPSHOT_POLICY_CHANGED", "Workspace ignore rules changed; start a new diff at offset 0.");
    }
    if (snapshot.error) throw snapshot.error;
    const identity = { snapshotId: snapshot.id, expiresAt: new Date(snapshot.expiresAt).toISOString() };
    if (snapshot.totalBytes === undefined) return { ...identity, status: "preparing", retryAfterMs: RESPONSE_WAIT_MS };
    if (opts.offset > snapshot.totalBytes)
      throw new GitDiffError("INVALID_DIFF_OFFSET", "Offset is beyond the end of this snapshot.");
    const fd = fs.openSync(this.file(snapshot.id), fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      const page = Buffer.allocUnsafe(Math.min(opts.maxBytes, snapshot.totalBytes - opts.offset));
      let read = 0;
      while (read < page.length) {
        const count = fs.readSync(fd, page, read, page.length - read, opts.offset + read);
        if (!count) throw new GitDiffError("DIFF_SNAPSHOT_IO_ERROR", "Snapshot ended before its recorded size.");
        read += count;
      }
      if (page.length && (page[0] & 0xc0) === 0x80)
        throw new GitDiffError("INVALID_DIFF_OFFSET", "Offset must be a UTF-8 character boundary; use nextOffset.");
      return { ...identity, status: "ready", ...diffPage(page, opts.mode, opts.offset, snapshot.totalBytes) };
    } finally { fs.closeSync(fd); }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await Promise.all([...this.snapshots.values()].map(snapshot => this.remove(snapshot)));
    if (this.directory) fs.rmdirSync(this.directory);
  }
}
