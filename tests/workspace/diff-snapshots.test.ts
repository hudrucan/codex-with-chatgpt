import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DiffSnapshots, type DiffSnapshotPage, type SnapshotPageOptions } from "../../src/workspace/diff-snapshots.js";
import { Workspace } from "../../src/workspace/manager.js";
import { cleanup, git, isolateStateDir, makeGitRepo, makeTmpDir, write } from "../helpers.js";

vi.mock("node:child_process", async importOriginal => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

let state: string;
let root: string;
let hubId: string;
let store: DiffSnapshots;
const opts: SnapshotPageOptions = { mode: "unstaged", offset: 0, maxBytes: 1024 };

beforeEach(async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  vi.mocked(spawn).mockReset().mockImplementation(actual.spawn);
  state = isolateStateDir();
  root = makeTmpDir("diff-snapshot");
  makeGitRepo(root);
  hubId = `hub-${randomUUID()}`;
  store = new DiffSnapshots(hubId);
});
afterEach(async () => {
  await store.close();
  vi.useRealTimers();
  vi.restoreAllMocks();
  cleanup(root); cleanup(state);
  delete process.env.C2C_STATE_DIR;
});

async function ready(options: SnapshotPageOptions = opts): Promise<Extract<DiffSnapshotPage, { status: "ready" }>> {
  const deadline = performance.now() + 5000;
  let page = await store.read(new Workspace(root), "client", options);
  while (page.status === "preparing") {
    if (performance.now() >= deadline) throw new Error("Diff snapshot did not become ready within 5000 ms");
    await new Promise(resolve => setTimeout(resolve, 10));
    page = await store.read(new Workspace(root), "client", { ...options, snapshotId: page.snapshotId });
  }
  return page;
}

function files(): string[] {
  return fs.readdirSync(path.join(state, "diff-snapshots"), { recursive: true }) as string[];
}

describe("immutable, bounded diff snapshots", () => {
  it("reads hundreds of exact UTF-8 pages without rerunning Git, even after the worktree changes", async () => {
    const text = Array.from({ length: 12000 }, (_, n) => `€🙂 line ${n} ${"x".repeat(40)}\n`).join("");
    write(root, "hello.txt", text);
    const expected = git(root, "diff", "--no-ext-diff", "--no-textconv", "--no-color", "--find-renames=1%", "--", ":(literal)hello.txt");
    let page = await ready();
    const calls = vi.mocked(spawn).mock.calls.length;
    expect(calls).toBeGreaterThan(0);
    write(root, "hello.txt", "changed after capture\n");
    const parts = [page.diff];
    let pages = 1;
    while (page.hasMore) {
      const offset = page.nextOffset!;
      page = await ready({ ...opts, offset, snapshotId: page.snapshotId });
      expect(page.offset).toBe(offset);
      expect(page.returnedBytes).toBe(Buffer.byteLength(page.diff));
      expect(page.returnedBytes).toBeGreaterThan(0);
      expect(page.diff).not.toContain("\ufffd");
      parts.push(page.diff); pages++;
    }
    expect(pages).toBeGreaterThan(500);
    expect(parts.join("")).toBe(expected);
    expect(page.totalBytes).toBe(Buffer.byteLength(expected));
    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(calls);
    const retry = await ready({ ...opts, snapshotId: page.snapshotId });
    expect(retry.diff).toBe(parts[0]);
    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(calls);
    if (process.platform !== "win32") {
      const dir = path.join(state, "diff-snapshots", fs.readdirSync(path.join(state, "diff-snapshots"))[0]);
      expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
      expect(fs.statSync(path.join(dir, page.snapshotId)).mode & 0o777).toBe(0o600);
    }
  });

  it("binds continuations to the client, workspace, mode, path and owning store", async () => {
    write(root, "hello.txt", "snapshot content\n");
    const first = await ready();
    const continuation = { ...opts, snapshotId: first.snapshotId };
    await expect(store.read(new Workspace(root), "other-client", continuation)).rejects.toMatchObject({ code: "DIFF_SNAPSHOT_UNAVAILABLE" });
    for (const changed of [{ mode: "head" as const }, { path: "hello.txt" }]) {
      await expect(store.read(new Workspace(root), "client", { ...continuation, ...changed })).rejects.toMatchObject({ code: "DIFF_SNAPSHOT_UNAVAILABLE" });
    }
    const other = makeTmpDir("other-snapshot-workspace");
    const otherStore = new DiffSnapshots(`hub-${randomUUID()}`);
    try {
      await expect(store.read(new Workspace(other), "client", continuation)).rejects.toMatchObject({ code: "DIFF_SNAPSHOT_UNAVAILABLE" });
      await expect(otherStore.read(new Workspace(root), "client", continuation)).rejects.toMatchObject({ code: "DIFF_SNAPSHOT_UNAVAILABLE" });
    } finally { await otherStore.close(); cleanup(other); }
    await expect(store.read(new Workspace(root), "client", { ...opts, offset: 10 })).rejects.toMatchObject({ code: "DIFF_SNAPSHOT_REQUIRED" });
    await expect(store.read(new Workspace(root), "client", { ...continuation, offset: first.totalBytes + 1 })).rejects.toMatchObject({ code: "INVALID_DIFF_OFFSET" });
  });

  it("invalidates saved content when ignore rules change and filters a new capture", async () => {
    write(root, "hello.txt", "now-private-content\n");
    write(root, ".env", "never-capture-secret\n"); git(root, "add", "-f", ".env");
    const first = await ready({ ...opts, mode: "head" });
    expect(first.diff).not.toContain("never-capture-secret");
    write(root, ".c2cignore", "hello.txt\n");
    await expect(store.read(new Workspace(root), "client", { ...opts, mode: "head", snapshotId: first.snapshotId }))
      .rejects.toMatchObject({ code: "DIFF_SNAPSHOT_POLICY_CHANGED" });
    expect(files().some(file => file.endsWith(first.snapshotId))).toBe(false);
    expect((await ready({ ...opts, mode: "head" })).diff).not.toContain("now-private-content");
  });

  it("expires snapshots, deletes their bytes and does not silently restart Git", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    write(root, "hello.txt", "expires\n");
    const first = await ready();
    const calls = vi.mocked(spawn).mock.calls.length;
    await vi.advanceTimersByTimeAsync(10 * 60_000 + 1);
    expect(files().some(file => file.endsWith(first.snapshotId))).toBe(false);
    await expect(store.read(new Workspace(root), "client", { ...opts, snapshotId: first.snapshotId }))
      .rejects.toMatchObject({ code: "DIFF_SNAPSHOT_UNAVAILABLE" });
    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(calls);
  });

  it("evicts the oldest completed snapshot at capacity, keeping the disk quota bounded", async () => {
    write(root, "hello.txt", "bounded\n");
    const first = await ready();
    for (let n = 0; n < 4; n++) await ready();
    const directory = path.join(state, "diff-snapshots", fs.readdirSync(path.join(state, "diff-snapshots"))[0]);
    expect(fs.readdirSync(directory)).toHaveLength(4);
    await expect(store.read(new Workspace(root), "client", { ...opts, snapshotId: first.snapshotId }))
      .rejects.toMatchObject({ code: "DIFF_SNAPSHOT_UNAVAILABLE" });
  });

  it("returns preparing for slow Git, bounds active jobs, reports a timeout and cleans up children", async () => {
    const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    vi.mocked(spawn).mockImplementation((_, __, options) => actual.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], options));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const pending = store.read(new Workspace(root), "client", opts);
    await vi.advanceTimersByTimeAsync(500);
    const first = await pending;
    expect(first).toMatchObject({ status: "preparing", retryAfterMs: 500 });
    const pending2 = store.read(new Workspace(root), "client", opts);
    await vi.advanceTimersByTimeAsync(500);
    expect(await pending2).toMatchObject({ status: "preparing" });
    await expect(store.read(new Workspace(root), "client", opts)).rejects.toMatchObject({ code: "DIFF_SNAPSHOT_BUSY" });
    await vi.advanceTimersByTimeAsync(30_000);
    // A poll waits for the killed child to close before exposing the failure.
    await expect(store.read(new Workspace(root), "client", { ...opts, snapshotId: first.snapshotId })).rejects.toMatchObject({ code: "GIT_TIMEOUT" });
    await store.close();
    expect(fs.readdirSync(path.join(state, "diff-snapshots"))).toEqual([]);
  });

  it("reclaims only this Hub's expired crash caches when starting a new capture", async () => {
    const parent = path.join(state, "diff-snapshots");
    const stale = path.join(parent, `${hubId}-AAAAAA`);
    const recent = path.join(parent, `${hubId}-BBBBBB`);
    const foreign = path.join(parent, `hub-${randomUUID()}-CCCCCC`);
    for (const dir of [stale, recent, foreign]) fs.mkdirSync(dir, { recursive: true });
    write(stale, "orphaned-patch", "expired cache");
    const old = new Date(Date.now() - 11 * 60_000);
    for (const dir of [stale, foreign]) fs.utimesSync(dir, old, old);
    await ready();
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(recent)).toBe(true);
    expect(fs.existsSync(foreign)).toBe(true);
  });

  it.each(["creation", "read", "page close", "preparation close", "cleanup"])("sanitizes filesystem errors during %s", async phase => {
    write(root, "hello.txt", "snapshot content\n");
    const localPath = path.join(state, "diff-snapshots", "private-local-path");
    const failure = Object.assign(new Error(`EACCES: permission denied, open '${localPath}'`), { code: "EACCES", path: localPath });
    const close = fs.closeSync;
    let fault: ReturnType<typeof vi.spyOn>;
    let operation: Promise<DiffSnapshotPage>;
    if (phase === "creation" || phase === "preparation close") {
      fault = phase === "creation"
        ? vi.spyOn(fs, "mkdtempSync").mockImplementationOnce(() => { throw failure; })
        : vi.spyOn(fs, "closeSync").mockImplementationOnce(fd => { close(fd); throw failure; });
      operation = store.read(new Workspace(root), "client", opts);
    } else {
      const first = await ready();
      const workspace = new Workspace(root);
      if (phase === "cleanup") {
        write(root, ".c2cignore", "hello.txt\n");
        fault = vi.spyOn(fs, "rmSync").mockImplementationOnce(() => { throw failure; });
      } else if (phase === "read") {
        fault = vi.spyOn(fs, "readSync").mockImplementationOnce(() => { throw failure; });
      } else {
        fault = vi.spyOn(fs, "closeSync").mockImplementationOnce(fd => { close(fd); throw failure; });
      }
      operation = store.read(workspace, "client", { ...opts, snapshotId: first.snapshotId });
    }
    try {
      const error = await operation.catch(error => error);
      expect(error).toMatchObject({ code: "DIFF_SNAPSHOT_IO_ERROR" });
      expect(error.message).not.toContain(localPath);
      expect(error.message).not.toContain(state);
      expect(error.message).not.toContain(root);
    } finally { fault.mockRestore(); }
  });

  it("reports a failed batch instead of exposing partial output, and removes the partial file", async () => {
    const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    vi.mocked(spawn).mockImplementation((_, args, options) => actual.spawn(process.execPath, ["-e", args?.includes("--name-status")
      ? 'process.stdout.write("M\\0hello.txt\\0")'
      : 'process.stdout.write("partial patch\\n"); process.exitCode = 7'], options));
    await expect(store.read(new Workspace(root), "client", opts)).rejects.toMatchObject({ code: "GIT_FAILED" });
    const dir = path.join(state, "diff-snapshots", fs.readdirSync(path.join(state, "diff-snapshots"))[0]);
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});
