import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gitLog, gitShow } from "../../src/workspace/git-history.js";
import { Workspace } from "../../src/workspace/manager.js";
import { cleanup, git, makeGitRepo, makeTmpDir, write } from "../helpers.js";

vi.mock("node:child_process", async importOriginal => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

let root: string;
const sha = () => git(root, "rev-parse", "HEAD").trim();
function commit(message = "test change"): string {
  git(root, "add", "-A"); git(root, "commit", "-m", message); return sha();
}
beforeEach(() => { root = makeTmpDir("git-history"); makeGitRepo(root); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); cleanup(root); });

describe("bounded read-only Git history", () => {
  it("returns bounded HEAD summaries with literal path filtering and root patches", async () => {
    const initial = sha();
    write(root, "literal[1].txt", "literal content\n");
    const added = commit("SECRET_IN_SUBJECT\n\nSECRET_IN_BODY");
    write(root, "src/index.ts", "new source\n"); const latest = commit();
    const workspace = new Workspace(root);
    expect(await gitLog(workspace, { limit: 1 })).toEqual({ commits: [{
      sha: latest, subject: "test change", subjectTruncated: false,
      date: new Date(git(root, "show", "-s", "--format=%cI", latest).trim()).toISOString(),
      paths: ["src/index.ts"], pathsTruncated: false,
    }], hasMore: true });
    expect(await gitLog(workspace, { path: "literal[1].txt" })).toEqual({ commits: [{
      sha: added, subject: "SECRET_IN_SUBJECT", subjectTruncated: false,
      date: new Date(git(root, "show", "-s", "--format=%cI", added).trim()).toISOString(),
      paths: ["literal[1].txt"], pathsTruncated: false,
    }], hasMore: false });
    expect(await gitLog(workspace, { path: "deleted-or-missing" })).toEqual({ commits: [], hasMore: false });
    const patch = await gitShow(workspace, { commit: initial });
    expect(patch).toMatchObject({ comparison: "root", truncated: false });
    expect(patch.diff).toContain("+Hello from Codex with ChatGPT!");
    expect(patch.diff).not.toContain("Author:");
    const shown = await gitShow(workspace, { commit: added });
    expect(shown.diff).toContain("+literal content");
    expect(JSON.stringify(shown)).not.toContain("SECRET_IN_");
    expect(JSON.stringify(await gitLog(workspace))).not.toMatch(/c2c-test|test@c2c.local|SECRET_IN_BODY/);
  });

  it("withholds sensitive additions, edits, deletions, rename chains and historical blob copies", async () => {
    write(root, ".env", "SECRET_HISTORICAL_TOKEN=abcdef\n");
    write(root, "public.txt", "visible public content\n"); const secret = commit();
    git(root, "mv", ".env", "renamed.txt"); const renamed = commit("HIDDEN_RENAME_SUBJECT");
    write(root, "copy.txt", "SECRET_HISTORICAL_TOKEN=abcdef\n"); const copied = commit();
    write(root, "renamed.txt", "sanitized later\n"); const cleaned = commit();
    fs.unlinkSync(path.join(root, "copy.txt")); const deleted = commit();
    const workspace = new Workspace(root);
    for (const id of [secret, renamed, copied, cleaned, deleted]) {
      const patch = await gitShow(workspace, { commit: id });
      expect(patch.diff).not.toMatch(/SECRET_HISTORICAL_TOKEN|abcdef|renamed.txt|copy.txt|\.env/);
    }
    expect((await gitShow(workspace, { commit: secret })).diff).toContain("public.txt");
    const log = await gitLog(workspace);
    expect(log.commits.find(c => c.sha === secret)?.paths).toEqual(["public.txt"]);
    expect(JSON.stringify(log)).not.toMatch(/SECRET_HISTORICAL_TOKEN|HIDDEN_RENAME_SUBJECT|renamed.txt|copy.txt|\.env/);
    expect(log.commits.map(c => c.sha)).toContain(secret);
    for (const id of [renamed, copied, cleaned, deleted]) expect(log.commits.map(c => c.sha)).not.toContain(id);
  });

  it("applies current custom rules to deleted history and prevents following historical symlinks", async () => {
    write(root, "private.txt", "PRIVATE_OLD_SECRET\n");
    fs.symlinkSync("hello.txt", path.join(root, "link.txt")); const old = commit();
    fs.unlinkSync(path.join(root, "private.txt")); commit();
    write(root, ".c2cignore", "private.txt\n");
    const workspace = new Workspace(root);
    expect((await gitShow(workspace, { commit: old })).diff).not.toMatch(/PRIVATE_OLD_SECRET|private.txt|link.txt/);
    for (const action of [() => gitLog(workspace, { path: "private.txt" }), () => gitShow(workspace, { commit: old, path: "private.txt" })])
      await expect(action()).rejects.toMatchObject({ code: "ACCESS_DENIED_SENSITIVE_FILE" });
  });

  it("retains historical ignore rules after removal and blocks rewritten renames without similarity", async () => {
    write(root, ".c2cignore", "private.txt\n");
    write(root, "private.txt", "HISTORICAL_CUSTOM_SECRET\n"); const hidden = commit();
    fs.unlinkSync(path.join(root, ".c2cignore")); commit();
    fs.unlinkSync(path.join(root, "private.txt"));
    write(root, "published.txt", "different line with HISTORICAL_CUSTOM_SECRET still present\n"); const rewritten = commit();
    // Git reports this as D+A, not a rename. Authorization must still hide it.
    expect(git(root, "diff", "--name-status", "--find-renames=1%", `${rewritten}^`, rewritten)).toMatch(/A\s+published.txt/);
    const workspace = new Workspace(root);
    for (const id of [hidden, rewritten]) {
      expect((await gitShow(workspace, { commit: id })).diff).not.toMatch(/HISTORICAL_CUSTOM_SECRET|private.txt|published.txt|\.c2cignore/);
    }
    expect((await gitLog(workspace, { path: "published.txt" })).commits).toEqual([]);
  });

  it("confines nested workspaces to their subtree, including cross-boundary renames and blob copies", async () => {
    write(root, "nested/inside.txt", "inside content\n");
    write(root, "outside.txt", "OUTSIDE_SECRET\n"); const old = commit();
    git(root, "mv", "outside.txt", "nested/moved.txt"); const moved = commit();
    const workspace = new Workspace(path.join(root, "nested"));
    expect((await gitShow(workspace, { commit: old })).diff).toContain("a/inside.txt");
    expect((await gitShow(workspace, { commit: old })).diff).not.toMatch(/OUTSIDE_SECRET|outside.txt|nested\//);
    expect((await gitShow(workspace, { commit: moved })).diff).toBe("");
    const log = await gitLog(workspace);
    expect(log.commits.map(c => c.sha)).toEqual([old]);
    expect(log.commits[0].paths).toEqual(["inside.txt"]);
    expect(JSON.stringify(log)).not.toMatch(/OUTSIDE_SECRET|outside.txt|nested\//);
    for (const action of [() => gitLog(workspace, { path: "../hello.txt" }), () => gitShow(workspace, { commit: old, path: "../hello.txt" })])
      await expect(action()).rejects.toMatchObject({ code: "PATH_OUTSIDE_WORKSPACE" });
  });

  it("shows merge changes against the first parent and handles ordinary deletions", async () => {
    git(root, "checkout", "-b", "feature");
    write(root, "feature.txt", "feature branch\n"); const feature = commit();
    git(root, "checkout", "main");
    write(root, "main.txt", "main branch\n"); commit();
    git(root, "merge", "--no-ff", "feature", "-m", "MERGE_METADATA_SECRET");
    const workspace = new Workspace(root);
    const merge = await gitShow(workspace, { commit: sha() });
    expect(merge.comparison).toBe("first-parent");
    expect(merge.diff).toContain("+feature branch");
    expect(merge.diff).not.toMatch(/main branch|MERGE_METADATA_SECRET|diff --cc/);
    expect((await gitShow(workspace, { commit: feature })).diff).toContain("+feature branch");
    fs.unlinkSync(path.join(root, "feature.txt")); const deleted = commit();
    expect((await gitShow(workspace, { commit: deleted })).diff).toContain("-feature branch");
  });

  it("caps UTF-8 patch output without reading the worktree and reports truncation", async () => {
    write(root, "large.txt", "界🙂".repeat(2000) + "\n"); const id = commit();
    write(root, "large.txt", "UNCOMMITTED_REPLACEMENT");
    const shown = await gitShow(new Workspace(root), { commit: id, maxBytes: 1024 });
    expect(shown.truncated).toBe(true);
    expect(shown.totalBytes).toBeGreaterThan(1024);
    expect(shown.returnedBytes).toBe(Buffer.byteLength(shown.diff));
    expect(shown.returnedBytes).toBeLessThanOrEqual(1024);
    expect(shown.diff).not.toMatch(/\ufffd|UNCOMMITTED_REPLACEMENT/);
  });

  it("bounds UTF-8 subjects, removes control characters and withholds commit bodies and identities", async () => {
    write(root, "hello.txt", "subject test\n");
    const id = commit("Subject\t\u001b[31m " + "界🙂".repeat(100) + "\n\nPRIVATE_BODY_CONTENT");
    const log = await gitLog(new Workspace(root), { limit: 1 });
    const summary = log.commits[0];
    expect(summary.sha).toBe(id);
    expect(summary.subjectTruncated).toBe(true);
    expect(Buffer.byteLength(summary.subject)).toBeLessThanOrEqual(256);
    expect(Buffer.byteLength(summary.subject)).toBeGreaterThan(248);
    expect(summary.subject).not.toMatch(/[\u0000-\u001f\u007f-\u009f\ufffd]/);
    expect(JSON.stringify(log)).not.toMatch(/PRIVATE_BODY_CONTENT|c2c-test|test@c2c.local/);
    write(root, "hello.txt", "empty subject test\n");
    git(root, "add", "hello.txt"); git(root, "commit", "--allow-empty-message", "-m", "");
    expect((await gitLog(new Workspace(root), { limit: 1 })).commits[0]).toMatchObject({ subject: "", subjectTruncated: false });
  });

  it("caps filtered changed paths and omits overlong paths without returning fragments", async () => {
    const paths = Array.from({ length: 22 }, (_, i) => `file-${String(i).padStart(2, "0")}.txt`);
    for (const file of paths) write(root, file, file + " content\n");
    const longPath = Array(3).fill("a".repeat(180)).join("/") + "/long.txt";
    write(root, longPath, "long path content\n");
    write(root, ".env", "HIDDEN_CHANGED_PATH_SECRET\n");
    const id = commit("bounded paths");
    const workspace = new Workspace(root);
    const log = await gitLog(workspace, { limit: 1 });
    expect(log.commits[0]).toMatchObject({ sha: id, paths: paths.slice(0, 20), pathsTruncated: true });
    expect(JSON.stringify(log)).not.toMatch(/\.env|HIDDEN_CHANGED_PATH_SECRET/);
    expect((await gitLog(workspace, { path: longPath })).commits).toEqual([
      expect.objectContaining({ sha: id, paths: [], pathsTruncated: true }),
    ]);
  });

  it.each(["oversized", "malformed", "invalid date"])("fails closed on %s log metadata without returning partial summaries", async kind => {
    const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const id = sha();
    vi.mocked(spawn).mockImplementation((command, args, options) => {
      if (!(args as string[]).includes("--no-walk=unsorted")) return actual.spawn(command, args, options);
      const script = kind === "oversized"
        ? `process.stdout.write(Buffer.alloc(${16 * 1024 * 1024 + 1}, 120));`
        : `process.stdout.write(${JSON.stringify(kind === "malformed" ? "PARTIAL_METADATA_SECRET" : `${id}\0invalid-date\0PRIVATE_SUBJECT\0`)});`;
      return actual.spawn(process.execPath, ["-e", script], options);
    });
    await expect(gitLog(new Workspace(root))).rejects.toMatchObject({
      code: kind === "oversized" ? "GIT_HISTORY_TOO_LARGE" : "GIT_HISTORY_UNAVAILABLE",
    });
  });

  it.each(["HEAD", "HEAD~1", "--all", "a".repeat(39), "a".repeat(41), "A".repeat(40)])("rejects revision syntax %s", async value => {
    await expect(gitShow(new Workspace(root), { commit: value })).rejects.toMatchObject({ code: "INVALID_COMMIT" });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("rejects unknown or non-commit objects without returning stderr or partial content", async () => {
    const workspace = new Workspace(root);
    for (const id of ["f".repeat(40), git(root, "rev-parse", "HEAD:hello.txt").trim()]) {
      await expect(gitShow(workspace, { commit: id })).rejects.toMatchObject({ code: "GIT_FAILED", message: "Git exited unsuccessfully." });
    }
    await expect(gitLog(workspace, { signal: AbortSignal.abort() })).rejects.toMatchObject({ code: "GIT_ABORTED" });
  });

  it.each(["branch", "dangling"])("rejects a local %s commit outside HEAD ancestry", async kind => {
    const initial = sha();
    git(root, "checkout", "-b", "outside-head");
    write(root, "outside-head.txt", "UNREACHABLE_CONTENT\n"); const outside = commit();
    git(root, "checkout", "main");
    if (kind === "dangling") git(root, "branch", "-D", "outside-head");
    expect(git(root, "cat-file", "-e", `${outside}^{commit}`)).toBe("");
    const workspace = new Workspace(root);
    expect((await gitLog(workspace)).commits.map(c => c.sha)).toEqual([initial]);
    await expect(gitShow(workspace, { commit: outside })).rejects.toMatchObject({ code: "GIT_FAILED", message: "Git exited unsuccessfully." });
  });

  it("rejects foreign commits available through an alternate object store", async () => {
    const foreign = makeTmpDir("git-history-alternate");
    try {
      makeGitRepo(foreign);
      write(foreign, "public.txt", "FOREIGN_ALTERNATE_CONTENT\n");
      git(foreign, "add", "public.txt"); git(foreign, "commit", "-m", "foreign commit");
      const outside = git(foreign, "rev-parse", "HEAD").trim();
      write(root, ".git/objects/info/alternates", path.join(foreign, ".git/objects") + "\n");
      expect(git(root, "show", `${outside}:public.txt`)).toBe("FOREIGN_ALTERNATE_CONTENT\n");
      const workspace = new Workspace(root);
      const log = await gitLog(workspace);
      expect(log.commits.map(c => c.sha)).toEqual([sha()]);
      expect(JSON.stringify(log)).not.toMatch(/foreign commit|FOREIGN_ALTERNATE_CONTENT|public.txt/);
      await expect(gitShow(workspace, { commit: outside })).rejects.toMatchObject({ code: "GIT_FAILED", message: "Git exited unsuccessfully." });
      expect((await gitShow(workspace, { commit: sha() })).diff).toContain("+Hello from Codex");
    } finally { cleanup(foreign); }
  });

  it("does not execute configured helpers or inherit Git repository redirects", async () => {
    const id = sha();
    const marker = path.join(root, "helper-marker");
    write(root, ".gitattributes", "*.txt diff=unsafe\n"); commit();
    const helper = write(root, "helper.cjs", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed');`);
    const command = `"${process.execPath}" "${helper}"`;
    for (const key of ["core.fsmonitor", "diff.external", "diff.unsafe.textconv", "core.pager", "gpg.program"]) git(root, "config", key, command);
    git(root, "config", "log.showSignature", "true");
    const index = fs.readFileSync(path.join(root, ".git/index"));
    vi.stubEnv("GIT_DIR", "/invalid/repository");
    vi.stubEnv("GIT_CONFIG_COUNT", "1");
    vi.stubEnv("GIT_CONFIG_KEY_0", "core.fsmonitor");
    vi.stubEnv("GIT_CONFIG_VALUE_0", command);
    const workspace = new Workspace(root);
    expect((await gitLog(workspace)).commits.length).toBeGreaterThan(0);
    expect((await gitShow(workspace, { commit: id })).diff).toContain("Hello from Codex");
    expect(fs.existsSync(marker)).toBe(false);
    expect(fs.readFileSync(path.join(root, ".git/index"))).toEqual(index);
  });

  it("rejects shallow history rather than treating missing ancestors as a safe root", async () => {
    write(root, ".git/shallow", sha() + "\n");
    await expect(gitShow(new Workspace(root), { commit: sha() })).rejects.toMatchObject({ code: "GIT_HISTORY_UNAVAILABLE" });
  });

  it.each(["inventory cap", "commit cap", "incomplete inventory", "process failure", "patch cap"])("fails closed on %s", async kind => {
    const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const id = sha();
    vi.mocked(spawn).mockImplementation((command, args, options) => {
      const phase = kind === "patch cap" ? "diff-tree" : "log";
      if (!(args as string[]).includes(phase)) return actual.spawn(command, args, options);
      const script = kind.endsWith("cap") && kind !== "commit cap"
        ? `process.stdout.write(Buffer.alloc(${16 * 1024 * 1024 + 1}, 120));`
        : kind === "commit cap"
          ? `for(let i=0;i<10001;i++) process.stdout.write(i.toString(16).padStart(40,'0')+'\\0');`
          : kind === "incomplete inventory" ? `process.stdout.write(${JSON.stringify(id)});`
            : `process.stdout.write('partial secret'); process.stderr.write('PRIVATE_STDERR'); process.exitCode=7;`;
      return actual.spawn(process.execPath, ["-e", script], options);
    });
    await expect(gitShow(new Workspace(root), { commit: id })).rejects.toMatchObject({
      code: kind.endsWith("cap") ? "GIT_HISTORY_TOO_LARGE" : kind === "incomplete inventory" ? "GIT_HISTORY_UNAVAILABLE" : "GIT_FAILED",
    });
  });

  it("cancels an active patch and waits for its child to close before returning no partial result", async () => {
    const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const controller = new AbortController();
    let closed = false;
    vi.mocked(spawn).mockImplementation((command, args, options) => {
      if (!(args as string[]).includes("diff-tree")) return actual.spawn(command, args, options);
      const child = actual.spawn(process.execPath, ["-e", "process.stdout.write('partial patch'); setInterval(() => {}, 1000);"], options);
      child.once("close", () => { closed = true; });
      child.once("spawn", () => controller.abort());
      return child;
    });
    await expect(gitShow(new Workspace(root), { commit: sha(), signal: controller.signal })).rejects.toMatchObject({ code: "GIT_ABORTED" });
    expect(closed).toBe(true);
  });

  it("reports the request deadline as GIT_TIMEOUT after closing the active subprocess", async () => {
    const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const timeout = new AbortController();
    const client = new AbortController();
    const deadline = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
    let closed = false;
    vi.mocked(spawn).mockImplementation((command, args, options) => {
      if (!(args as string[]).includes("diff-tree")) return actual.spawn(command, args, options);
      const child = actual.spawn(process.execPath, ["-e", "process.stdout.write('partial patch'); setInterval(() => {}, 1000);"], options);
      child.once("close", () => { closed = true; });
      child.once("spawn", () => timeout.abort(new DOMException("Deadline exceeded", "TimeoutError")));
      return child;
    });
    await expect(gitShow(new Workspace(root), { commit: sha(), signal: client.signal })).rejects.toMatchObject({ code: "GIT_TIMEOUT" });
    expect(deadline).toHaveBeenCalledWith(30_000);
    expect(client.signal.aborted).toBe(false);
    expect(closed).toBe(true);
  });

  it("bounds concurrent reads and releases capacity after cancellation", async () => {
    const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const id = sha();
    const controller = new AbortController();
    vi.mocked(spawn).mockImplementation((_, __, options) => actual.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], options));
    const workspace = new Workspace(root);
    const pending = Promise.allSettled([
      gitLog(workspace, { signal: controller.signal }), gitShow(workspace, { commit: id, signal: controller.signal }),
    ]);
    try {
      await expect(gitLog(workspace)).rejects.toMatchObject({ code: "GIT_HISTORY_BUSY" });
    } finally { controller.abort(); }
    const results = await pending;
    for (const result of results) expect(result).toMatchObject({ status: "rejected", reason: { code: "GIT_ABORTED" } });
    vi.mocked(spawn).mockImplementation(actual.spawn);
    expect((await gitLog(workspace)).commits.map(c => c.sha)).toEqual([id]);
  });
});
