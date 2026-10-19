import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import fs from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { gitDiff, gitInfo, gitStatus } from "../../src/workspace/git.js";
import { makeTmpDir, cleanup, write, makeGitRepo, git } from "../helpers.js";

vi.mock("node:child_process", async importOriginal => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

const testChildren: { child: ChildProcess; closed: boolean }[] = [];

let repo: string;
let plain: string;

beforeAll(() => {
  repo = makeTmpDir("git-repo");
  makeGitRepo(repo);
  plain = makeTmpDir("not-a-repo");
  // The test-tmp dir lives inside this project's own git repo; stop git from
  // walking up so `plain` is genuinely outside any repository.
  process.env.GIT_CEILING_DIRECTORIES = path.dirname(plain);
});

afterAll(() => {
  delete process.env.GIT_CEILING_DIRECTORIES;
  cleanup(repo);
  cleanup(plain);
});
afterEach(async () => {
  for (const record of testChildren.splice(0)) {
    if (!record.closed) await new Promise<void>(resolve => {
      record.child.once("close", resolve);
      record.child.kill("SIGKILL");
    });
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.mocked(spawn).mockReset();
  vi.unstubAllEnvs();
});

describe("read-only git execution", () => {
  it("never executes repo-configured fsmonitor, textconv or external diff helpers", async () => {
    const isolated = makeTmpDir("git-helpers");
    try {
      makeGitRepo(isolated);
      write(isolated, ".gitattributes", "hello.txt diff=unsafe\n");
      git(isolated, "add", ".gitattributes"); git(isolated, "commit", "-m", "configure diff driver");
      write(isolated, "hello.txt", "staged content\n"); git(isolated, "add", "hello.txt");
      write(isolated, "hello.txt", "working content\n");
      const marker = path.join(isolated, "helper-executed");
      const helper = write(isolated, "helper.cjs", `require('node:fs').appendFileSync(${JSON.stringify(marker)}, process.argv[2]); process.stdout.write('HELPER_OUTPUT\\n');`);
      const command = `"${process.execPath.replace(/\\/g, "/")}" "${helper.replace(/\\/g, "/")}"`;
      git(isolated, "config", "diff.unsafe.textconv", `${command} textconv`);
      git(isolated, "config", "diff.external", `${command} external`);
      git(isolated, "config", "core.fsmonitor", `${command} fsmonitor`);
      expect(gitInfo(isolated)).toMatchObject({ isRepo: true, dirty: true });
      expect(gitStatus(isolated)).toMatchObject({ isRepo: true, unstaged: expect.arrayContaining([{ path: "hello.txt", change: "M" }]) });
      for (const mode of ["unstaged", "staged", "head"] as const) {
        const result = await gitDiff(isolated, { mode });
        expect(result.isRepo).toBe(true); expect(result.diff).toContain("content");
        expect(result.diff).not.toContain("HELPER_OUTPUT");
      }
      expect(fs.existsSync(marker)).toBe(false);
    } finally { cleanup(isolated); }
  });

  it("does not refresh or rewrite the index when status or workspace info reads changed file timestamps", () => {
    const isolated = makeTmpDir("git-index-read");
    try {
      makeGitRepo(isolated);
      vi.stubEnv("GIT_OPTIONAL_LOCKS", "1");
      const changedTime = new Date(Date.now() + 10_000);
      fs.utimesSync(path.join(isolated, "hello.txt"), changedTime, changedTime);
      const index = path.join(isolated, ".git", "index"), bytes = fs.readFileSync(index);
      const modifiedAt = fs.statSync(index, { bigint: true }).mtimeNs;
      expect(gitStatus(isolated)).toMatchObject({ isRepo: true, staged: [], unstaged: [] });
      expect(gitInfo(isolated).dirty).toBe(false);
      expect(fs.readFileSync(index)).toEqual(bytes);
      expect(fs.statSync(index, { bigint: true }).mtimeNs).toBe(modifiedAt);
      expect(fs.existsSync(`${index}.lock`)).toBe(false);
    } finally { cleanup(isolated); }
  });
});

describe("gitInfo", () => {
  it("reports branch, commit and dirty state", () => {
    const clean = gitInfo(repo);
    expect(clean.isRepo).toBe(true);
    expect(clean.branch).toBe("main");
    expect(clean.commit).toMatch(/^[a-f0-9]{7,}$/);
    expect(clean.dirty).toBe(false);

    write(repo, "hello.txt", "changed\n");
    expect(gitInfo(repo).dirty).toBe(true);
    git(repo, "checkout", "--", "hello.txt");
  });

  it("handles non-repos gracefully", () => {
    expect(gitInfo(plain).isRepo).toBe(false);
  });
});

describe("gitStatus", () => {
  it("categorizes staged, unstaged and untracked files", () => {
    write(repo, "hello.txt", "modified content\n");
    write(repo, "staged.txt", "new staged file\n");
    write(repo, "untracked.txt", "new file\n");
    git(repo, "add", "staged.txt");

    const status = gitStatus(repo);
    expect(status.isRepo).toBe(true);
    expect(status.branch).toBe("main");
    expect(status.unstaged.map((entry) => entry.path)).toContain("hello.txt");
    expect(status.staged.map((entry) => entry.path)).toContain("staged.txt");
    expect(status.untracked).toContain("untracked.txt");

    git(repo, "reset", "staged.txt");
    git(repo, "checkout", "--", "hello.txt");
  });

  it("omits sensitive and .c2cignore'd paths from the names ChatGPT sees", () => {
    write(repo, ".c2cignore", "private-notes/\n");
    write(repo, ".env", "SECRET_KEY=leaked-env\n");
    write(repo, "private-notes/secret.md", "CONFIDENTIAL DATA\n");
    write(repo, "public.txt", "PUBLIC CONTENT\n");

    const status = gitStatus(repo);
    expect(status.untracked).toContain("public.txt");
    expect(status.untracked).not.toContain(".env");
    expect(status.untracked).not.toContain("private-notes/secret.md");
    expect(status.hidden.changes).toBeGreaterThan(0);

    fs.rmSync(path.join(repo, ".c2cignore"), { force: true });
    fs.rmSync(path.join(repo, ".env"), { force: true });
    fs.rmSync(path.join(repo, "public.txt"), { force: true });
    fs.rmSync(path.join(repo, "private-notes"), { recursive: true, force: true });
  });
});

describe("gitDiff pagination", () => {
  it.each(["unstaged", "staged", "head"] as const)("matches Git's complete safe output in %s mode", async mode => {
    const isolated = makeTmpDir("diff-mode");
    try {
      makeGitRepo(isolated);
      write(isolated, "hello.txt", "staged change\n"); git(isolated, "add", "hello.txt");
      write(isolated, "hello.txt", "working change\n");
      const expected = git(isolated, "--no-optional-locks", "-c", "core.fsmonitor=false", "diff", "--no-ext-diff", "--no-textconv",
        "--no-color", "--find-renames=1%", ...(mode === "staged" ? ["--cached"] : mode === "head" ? ["HEAD"] : []), "--", ":(literal)hello.txt");
      expect(await gitDiff(isolated, { mode })).toEqual({ isRepo: true, mode, diff: expected,
        totalBytes: Buffer.byteLength(expected), offset: 0, returnedBytes: Buffer.byteLength(expected), hasMore: false, nextOffset: null });
    } finally { cleanup(isolated); }
  });

  it("preserves an exact scoped path as a literal pathspec", async () => {
    const isolated = makeTmpDir("diff-literal-scope");
    try {
      makeGitRepo(isolated);
      write(isolated, "scope/[literal].txt", "selected content\n");
      write(isolated, "scope/l.txt", "must not match a pathspec pattern\n");
      git(isolated, "add", "scope");
      const result = await gitDiff(isolated, { mode: "staged" }, "scope/[literal].txt");
      expect(result.diff).toContain("selected content");
      expect(result.diff).not.toContain("must not match");
      expect(result.isRepo).toBe(true);
    } finally { cleanup(isolated); }
  });

  it("paginates on byte offsets and never splits lines", async () => {
    const lines = Array.from({ length: 5000 }, (_, i) => `line-${i}-${"x".repeat(40)}`).join("\n");
    write(repo, "hello.txt", lines);
    const first = await gitDiff(repo, { mode: "unstaged", maxBytes: 8192 });
    expect(first.hasMore).toBe(true);
    expect(first.diff.endsWith("\n")).toBe(true);
    expect(first.nextOffset).toBe(first.returnedBytes);

    const second = await gitDiff(repo, { mode: "unstaged", offset: first.nextOffset!, maxBytes: 8192 });
    expect(second.offset).toBe(first.nextOffset);
    expect(second.diff.length).toBeGreaterThan(0);

    // walk to the end
    let offset = 0;
    let assembled = "";
    for (let hop = 0; hop < 1000; hop++) {
      const page = await gitDiff(repo, { mode: "unstaged", offset, maxBytes: 65536 });
      assembled += page.diff;
      if (!page.hasMore) break;
      offset = page.nextOffset!;
    }
    expect(Buffer.byteLength(assembled)).toBe(first.totalBytes);
    expect(assembled).toBe(git(repo, "diff", "--no-ext-diff", "--no-textconv", "--no-color", "--find-renames=1%", "--", ":(literal)hello.txt"));
    git(repo, "checkout", "--", "hello.txt");
  });

  it("reconstructs multibyte UTF-8 including a line longer than a page using exact byte offsets", async () => {
    const isolated = makeTmpDir("diff-utf8");
    try {
      makeGitRepo(isolated);
      write(isolated, "hello.txt", "€文🙂".repeat(1400) + "\nlast line\n");
      const expected = git(isolated, "diff", "--no-ext-diff", "--no-textconv", "--no-color", "--find-renames=1%", "--", ":(literal)hello.txt");
      const pages: string[] = [];
      let offset = 0;
      do {
        const page = await gitDiff(isolated, { offset, maxBytes: 1024 });
        expect(page.totalBytes).toBe(Buffer.byteLength(expected));
        expect(page.offset).toBe(offset);
        expect(page.returnedBytes).toBe(Buffer.byteLength(page.diff));
        expect(page.returnedBytes).toBeLessThanOrEqual(1024);
        expect(page.diff).not.toContain("\ufffd");
        pages.push(page.diff);
        if (!page.hasMore) break;
        expect(page.nextOffset).toBe(offset + page.returnedBytes);
        expect(page.nextOffset!).toBeGreaterThan(offset);
        offset = page.nextOffset!;
      } while (offset <= Buffer.byteLength(expected));
      expect(pages.join("")).toBe(expected);
    } finally { cleanup(isolated); }
  });

  it("excludes sensitive files from full-repo diffs", async () => {
    write(repo, ".env", "SECRET=1\n");
    git(repo, "add", "-f", ".env");
    write(repo, ".env", "SECRET=leaked-value\n");
    const diff = await gitDiff(repo, { mode: "unstaged" });
    expect(diff.diff).not.toContain("leaked-value");
    git(repo, "rm", "-f", "--cached", ".env");
  });

  it("excludes sensitive files from directory-scoped diffs", async () => {
    write(repo, "private/.env", "SECRET=1\n");
    git(repo, "add", "-f", "private/.env");
    const diff = await gitDiff(repo, { mode: "staged" }, "private");
    expect(diff.diff).not.toContain("SECRET=1");
    git(repo, "rm", "-f", "--cached", "private/.env");
  });

  it("handles non-repos gracefully", async () => {
    const diff = await gitDiff(plain, { mode: "unstaged" });
    expect(diff.isRepo).toBe(false);
  });

  it("excludes all IgnoreRules sensitive patterns across unstaged, staged, and head modes", async () => {
    const sensitiveFiles = [
      { path: ".env", content: "SECRET_KEY=leaked-env\n", sentinel: "leaked-env" },
      { path: ".npmrc", content: "//registry.npmjs.org/:_authToken=leaked-npm\n", sentinel: "leaked-npm" },
      { path: ".netrc", content: "machine github.com password leaked-netrc\n", sentinel: "leaked-netrc" },
      { path: ".aws/credentials", content: "aws_secret_access_key=leaked-aws\n", sentinel: "leaked-aws" },
      { path: "nested/.ssh/config", content: "IdentityFile leaked-ssh\n", sentinel: "leaked-ssh" },
      { path: "credentials.json", content: '{"client_secret": "leaked-creds"}\n', sentinel: "leaked-creds" },
      { path: "service-account-prod.json", content: '{"private_key": "leaked-sa"}\n', sentinel: "leaked-sa" },
      { path: "secrets.json", content: '{"db_pass": "leaked-secrets"}\n', sentinel: "leaked-secrets" },
      { path: "id_ed25519", content: "-----BEGIN OPENSSH PRIVATE KEY-----\nleaked-key\n", sentinel: "leaked-key" },
    ];

    // Also include a safe file to confirm normal diffs are returned alongside excluded secrets
    write(repo, "src/safe.ts", "export const safe = 1;\n");
    git(repo, "add", "src/safe.ts");
    git(repo, "commit", "-m", "add safe file");

    for (const item of sensitiveFiles) {
      write(repo, item.path, item.content);
      git(repo, "add", "-f", item.path);
    }

    // 1. Staged mode
    const stagedDiff = await gitDiff(repo, { mode: "staged" });
    for (const item of sensitiveFiles) {
      expect(stagedDiff.diff).not.toContain(item.sentinel);
    }

    // Commit them so we can test unstaged changes and HEAD diffs
    git(repo, "commit", "-m", "tracked sensitive files");

    // 2. Unstaged modifications to tracked sensitive files + normal file
    for (const item of sensitiveFiles) {
      write(repo, item.path, item.content + "# modified-unstaged\n");
    }
    write(repo, "src/safe.ts", "export const safe = 2; // modified-safe\n");

    const unstagedDiff = await gitDiff(repo, { mode: "unstaged" });
    expect(unstagedDiff.diff).toContain("modified-safe");
    for (const item of sensitiveFiles) {
      expect(unstagedDiff.diff).not.toContain(item.sentinel);
      expect(unstagedDiff.diff).not.toContain("modified-unstaged");
    }

    // 3. Head mode
    const headDiff = await gitDiff(repo, { mode: "head" });
    expect(headDiff.diff).toContain("modified-safe");
    for (const item of sensitiveFiles) {
      expect(headDiff.diff).not.toContain(item.sentinel);
    }

    // Clean up
    git(repo, "checkout", "--", "src/safe.ts", ...sensitiveFiles.map((s) => s.path));
  });

  it("allows .env.example while blocking .env", async () => {
    write(repo, ".env.example", "API_URL=https://example.com\n");
    write(repo, ".env", "API_KEY=supersecret-123\n");
    git(repo, "add", "-f", ".env.example", ".env");

    const diff = await gitDiff(repo, { mode: "staged" });
    expect(diff.diff).toContain(".env.example");
    expect(diff.diff).toContain("https://example.com");
    expect(diff.diff).not.toContain("supersecret-123");

    git(repo, "rm", "-f", "--cached", ".env.example", ".env");
  });

  it("respects custom rules in .c2cignore for git diff", async () => {
    write(repo, ".c2cignore", "private-notes/\ncustom-secret.txt\n");
    write(repo, "private-notes/secret.md", "CONFIDENTIAL DATA\n");
    write(repo, "custom-secret.txt", "TOP_SECRET_FLAG=1\n");
    write(repo, "public.txt", "PUBLIC CONTENT\n");
    git(repo, "add", "-f", ".c2cignore", "private-notes/secret.md", "custom-secret.txt", "public.txt");

    const diff = await gitDiff(repo, { mode: "staged" });
    expect(diff.diff).toContain("public.txt");
    expect(diff.diff).toContain("PUBLIC CONTENT");
    expect(diff.diff).not.toContain("CONFIDENTIAL DATA");
    expect(diff.diff).not.toContain("TOP_SECRET_FLAG");

    git(repo, "rm", "-f", "--cached", ".c2cignore", "private-notes/secret.md", "custom-secret.txt", "public.txt");
  });

  it("handles rename provenance: sensitive->safe, safe->sensitive, safe->safe", async () => {
    // 1. Commit baseline files
    write(repo, "old_safe.ts", "export const value = 'old-safe-data';\n");
    write(repo, ".npmrc", "//registry.npmjs.org/:_authToken=npm-secret-token\n");
    write(repo, "public_to_secret.txt", "harmless text\n");
    git(repo, "add", "-f", "old_safe.ts", ".npmrc", "public_to_secret.txt");
    git(repo, "commit", "-m", "init rename baseline");

    // Case A: Safe -> Safe rename
    git(repo, "mv", "old_safe.ts", "new_safe.ts");
    // Case B: Sensitive -> Safe rename (Must be excluded!)
    git(repo, "mv", ".npmrc", "renamed_public.txt");
    // Case C: Safe -> Sensitive rename (Must be excluded!)
    git(repo, "mv", "public_to_secret.txt", ".env.secret");

    const stagedDiff = await gitDiff(repo, { mode: "staged" });

    // Safe->safe rename should appear
    expect(stagedDiff.diff).toContain("old_safe.ts");
    expect(stagedDiff.diff).toContain("new_safe.ts");

    // Sensitive->safe must NOT leak
    expect(stagedDiff.diff).not.toContain("npm-secret-token");
    expect(stagedDiff.diff).not.toContain(".npmrc");
    expect(stagedDiff.diff).not.toContain("renamed_public.txt");

    // Safe->sensitive must NOT appear as sensitive patch
    expect(stagedDiff.diff).not.toContain(".env.secret");

    // Reset repo
    git(repo, "reset", "--hard", "HEAD");
  });

  it("prevents cross-boundary scoped rename provenance leaks with path= scoping", async () => {
    // Baseline files
    write(repo, ".npmrc", "//registry.npmjs.org/:_authToken=cross-scope-secret\n");
    write(repo, "src/.npmrc", "//registry.npmjs.org/:_authToken=src-secret\n");
    write(repo, "root_safe.ts", "export const rootSafe = 1;\n");
    write(repo, "public.txt", "public content\n");
    git(repo, "add", "-f", ".npmrc", "src/.npmrc", "root_safe.ts", "public.txt");
    git(repo, "commit", "-m", "baseline for cross-scope rename");

    // 1. Root .npmrc renamed to src/public.txt -> scoped git_diff(path="src")
    git(repo, "mv", ".npmrc", "src/public.txt");

    // 2. public.txt renamed to src/.env -> scoped git_diff(path="src")
    git(repo, "mv", "public.txt", "src/.env");

    // 3. Safe root_safe.ts renamed to src/new_safe.ts -> scoped git_diff(path="src")
    git(repo, "mv", "root_safe.ts", "src/new_safe.ts");

    // 4. src/.npmrc renamed to root_secret_leak.txt -> scoped git_diff(path="src")
    git(repo, "mv", "src/.npmrc", "root_secret_leak.txt");

    const srcDiff = await gitDiff(repo, { mode: "staged" }, "src");

    // Safe cross-scope rename is visible
    expect(srcDiff.diff).toContain("root_safe.ts");
    expect(srcDiff.diff).toContain("src/new_safe.ts");

    // Sensitive->safe cross-scope rename MUST NOT leak
    expect(srcDiff.diff).not.toContain("cross-scope-secret");
    expect(srcDiff.diff).not.toContain("src/public.txt");

    // Safe->sensitive cross-scope rename MUST NOT appear
    expect(srcDiff.diff).not.toContain("src/.env");

    // Sensitive deletion from src MUST NOT appear
    expect(srcDiff.diff).not.toContain("src-secret");
    expect(srcDiff.diff).not.toContain("root_secret_leak.txt");

    git(repo, "reset", "--hard", "HEAD");
  });
});

// Real child streams exercise counting, deadlines and close ordering without huge repo fixtures.
describe("async gitDiff process boundaries", () => {
  const cap = 64 * 1024 * 1024;
  const failure = { isRepo: false, mode: "unstaged", totalBytes: 0, offset: 0, returnedBytes: 0, hasMore: false, nextOffset: null, diff: "" };
  const inventory = (count = 1) => Array.from({ length: count }, (_, index) => `M\0safe-${index}.txt\0`).join("");
  const emit = (text: string) => `process.stdout.write(${JSON.stringify(text)});`;
  const emitBytes = (bytes: number, byte = 0x78, stream = "stdout") => `
    (async () => {
      const { once } = require("node:events");
      const block = Buffer.alloc(65536, ${byte});
      let remaining = ${bytes};
      while (remaining > 0) {
        const chunk = block.subarray(0, Math.min(block.length, remaining));
        remaining -= chunk.length;
        if (!process.${stream}.write(chunk)) await once(process.${stream}, "drain");
      }
    })();`;

  async function useProcesses(list: string, batches: string[], readyPhase: "inventory" | "batch" = "batch") {
    const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    let notify!: () => void;
    const ready = new Promise<void>(resolve => { notify = resolve; });
    let nextBatch = 0;
    const records: typeof testChildren = [];
    vi.mocked(spawn).mockImplementation((_, args, options) => {
      const isInventory = args?.includes("--name-status");
      const script = isInventory ? list : batches[nextBatch++];
      if (script === undefined) throw new Error("Unexpected Git batch");
      const child = actual.spawn(process.execPath, ["-e", script], options);
      const record = { child, closed: false };
      child.once("close", () => { record.closed = true; });
      if ((isInventory ? "inventory" : "batch") === readyPhase) child.stdout!.once("data", notify);
      testChildren.push(record); records.push(record);
      return child;
    });
    return { ready, records };
  }

  it("counts a 64 MiB diff across batches while returning only a bounded page spanning their boundary", async () => {
    const processes = await useProcesses(emit(inventory(51)), [emitBytes(cap / 2, 0x61), emitBytes(cap / 2, 0x62)]);
    const result = await gitDiff(repo, { offset: cap / 2 - 2048, maxBytes: 4096 });
    expect(result).toEqual({ isRepo: true, mode: "unstaged", totalBytes: cap, offset: cap / 2 - 2048,
      returnedBytes: 4096, hasMore: true, nextOffset: cap / 2 + 2048, diff: "a".repeat(2048) + "b".repeat(2048) });
    expect(processes.records).toHaveLength(3);
    expect(processes.records.every(record => record.closed)).toBe(true);
  });

  it("fails closed on aggregate overflow and does not run remaining batches", async () => {
    const processes = await useProcesses(emit(inventory(101)), [emitBytes(cap / 2), emitBytes(cap / 2 + 1)]);
    expect(await gitDiff(repo, { maxBytes: 1024 })).toEqual(failure);
    expect(processes.records).toHaveLength(3);
    expect(processes.records.every(record => record.closed)).toBe(true);
  });

  it.each([
    ["inventory overflow", () => emitBytes(cap + 1), () => []],
    ["incomplete inventory", () => emit("M\0safe.txt"), () => []],
    ["inventory failure", () => emit(inventory()) + "process.exitCode = 7;", () => []],
    ["later batch failure", () => emit(inventory(51)), () => [emit("discard earlier batch\n"), emit("discard failed batch\n") + "process.exitCode = 7;"]],
    ["stderr overflow", () => emit(inventory()), () => [emitBytes(65537, 0x78, "stderr")]],
  ] as const)("returns no partial output after %s", async (_, list, batches) => {
    const processes = await useProcesses(list(), batches());
    expect(await gitDiff(repo)).toEqual(failure);
    expect(processes.records.every(record => record.closed)).toBe(true);
  });

  it.each(["throw", "error"])("handles a spawn %s without an unhandled error", async kind => {
    const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    vi.mocked(spawn).mockImplementationOnce((_, args, options) => {
      if (kind === "throw") throw new Error("Cannot spawn Git");
      return actual.spawn(path.join(repo, "missing-git-binary"), args, options);
    });
    expect(await gitDiff(repo)).toEqual(failure);
  });

  it.each(["inventory", "batch"] as const)("keeps the event loop responsive and closes a timed-out %s child before returning failure", async phase => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const hold = "setInterval(() => {}, 1000);";
    const processes = await useProcesses(emit(inventory()) + (phase === "inventory" ? hold : ""), [emit("partial diff\n") + hold], phase);
    let settled = false;
    const result = gitDiff(repo).then(value => { settled = true; return value; });
    await processes.ready;
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(settled).toBe(false);
    const active = processes.records.at(-1)!;
    expect(active.closed).toBe(false);
    const kill = vi.spyOn(active.child, "kill");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await result).toEqual(failure);
    expect(kill).toHaveBeenCalledWith("SIGKILL");
    expect(processes.records.every(record => record.closed)).toBe(true);
  });
});
