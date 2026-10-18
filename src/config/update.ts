import { spawnSync } from "node:child_process";

export const FORK_REPOSITORY = "hudrucan/desk-c2c-hub";
export function isForkOrigin(url: string): boolean {
  return /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)hudrucan\/desk-c2c-hub(?:\.git)?\/?$/.test(url.trim());
}

export function verifyForkOrigin(run: (args: string[]) => { ok: boolean; stdout: string }): void {
  const result = run(["remote", "get-url", "--all", "origin"]);
  const urls = result.stdout.split(/\r?\n/).filter(Boolean);
  if (!result.ok || urls.length !== 1 || !isForkOrigin(urls[0])) {
    throw new Error(`UPDATE_ORIGIN_CONFLICT: origin must resolve to github.com/${FORK_REPOSITORY}; no fetch or pull performed.`);
  }
}

/** Called only by the explicit update command. Never stashes user changes. */
export function pullFork(root: string): void {
  const run = (args: string[]) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8", timeout: 60_000,
      windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
    return { ok: result.status === 0, stdout: (result.stdout ?? "").trim() };
  };
  verifyForkOrigin(run);
  const dirty = run(["status", "--porcelain"]);
  if (!dirty.ok || dirty.stdout) throw new Error("UPDATE_DIRTY_CHECKOUT: Commit or stash your changes explicitly before updating.");
  const branch = run(["symbolic-ref", "--short", "HEAD"]);
  if (!branch.ok || !branch.stdout || branch.stdout.startsWith("-")) throw new Error("UPDATE_BRANCH_REQUIRED: Check out a branch before updating.");
  if (!run(["pull", "--ff-only", "origin", branch.stdout]).ok) throw new Error("UPDATE_FAILED: Fast-forward pull failed; inspect the checkout before retrying.");
}
