import { afterEach, beforeEach, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AUDIT_END, AUDIT_START, startAsyncC2C, type AuditTab, type AuditUI } from "../../src/c2c/async.js";
import { resolveAuditProject } from "../../src/c2c/project.js";
import { Workspace } from "../../src/workspace/manager.js";
import { cleanup, git, makeGitRepo } from "../helpers.js";

vi.mock("../../src/c2c/project.js", () => ({ resolveAuditProject: vi.fn() }));
const project = "https://chatgpt.com/g/g-p-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-demo/project";
const threadUrl = project.replace("/project", "/c/6ada4b34-9a0c-83ec-a2c9-fef01eabdf42");
const options = { async: true, taskId: "task-1", workspaceId: "0123456789ab", workspaceRoot: "" };
const handoff = "[C2C Handoff]\nRepo: demo; uncommitted; Validation: focused tests passed.";
const finding = { file: "src/demo.ts", line: 1, evidence: "Wrong workspace was accepted", fix: "Reject mismatched workspace" };

let directory: string;
beforeEach(() => {
  directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "c2c-async-")));
  vi.stubEnv("C2C_STATE_DIR", path.join(directory, "state"));
  options.workspaceRoot = path.join(directory, "repo"); fs.mkdirSync(options.workspaceRoot); makeGitRepo(options.workspaceRoot);
  options.workspaceId = new Workspace(options.workspaceRoot).id;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  vi.mocked(resolveAuditProject).mockReturnValue(project);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); cleanup(directory); });

/** Small upstream UI fixture: evaluate runs the production transcript reader. */
function browserFixture(selectorDeadlineMs?: number) {
  const turns: { user: boolean; text: string }[] = [];
  let draft = "", url = threadUrl, hungWait = false;
  let wake: (() => void) | undefined;
  const response = (patch: Record<string, unknown> = {}) => {
    const message = turns.filter(turn => turn.user).at(-1)!.text;
    const request = JSON.parse(message.split("\n").find(line => line.startsWith("C2C_REQUEST "))!.slice("C2C_REQUEST ".length));
    return { ...request, status: "PASS", complete: true, summary: "MCP audit complete", findings: [], ...patch };
  };
  const emit = (text: string, user = false) => { turns.push({ user, text }); wake?.(); };
  const reply = (patch: Record<string, unknown> = {}) => emit(`${AUDIT_START}\n${JSON.stringify(response(patch))}\n${AUDIT_END}`);
  const press = vi.fn(async () => { emit(draft, true); draft = ""; });
  const waitFor = vi.fn();
  function locator(filters: string[] = []) {
    const value = {
      fill: vi.fn(async (text: string) => { draft = text; }), press,
      innerText: vi.fn(async () => draft),
      filter: (filter: { hasText?: string }) => locator(filter.hasText ? [...filters, filter.hasText] : filters),
      last: () => value,
      waitFor: (wait: { timeoutMs: number }) => {
        waitFor(wait);
        if (hungWait) return new Promise<void>(() => {});
        const ready = () => turns.some(turn => !turn.user && filters.every(filter => turn.text.includes(filter)));
        if (ready()) return Promise.resolve();
        return new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            wake = undefined;
            // Match the actual REPL selector error, including its foreign realm.
            reject(selectorDeadlineMs === undefined
              ? Object.assign(new Error(`locator.waitFor: Timeout ${wait.timeoutMs}ms exceeded.`), { name: "TimeoutError" })
              : { name: "Error", message: 'Playwright selector deadline exceeded\nlocator.waitFor(visible) timed out for selector div:has(> h4)\nLocator diagnostics: {"kind":"no_matches"}' });
          }, Math.min(wait.timeoutMs, selectorDeadlineMs ?? wait.timeoutMs));
          wake = () => { if (ready()) { clearTimeout(timer); wake = undefined; resolve(); } };
        });
      },
    };
    return value;
  }
  const tab: AuditTab = { id: "existing", url: vi.fn(async () => url), playwright: {
    getByRole: vi.fn(() => locator()), locator: vi.fn(() => locator()),
    evaluate: vi.fn(async (fn, arg) => {
      vi.stubGlobal("document", { querySelectorAll: () => turns.map(turn => ({
        textContent: turn.user ? "You said:" : "ChatGPT said:", nextElementSibling: { innerText: turn.text },
      })) });
      return fn(arg);
    }),
  } };
  const browser = { tabs: { selected: vi.fn(async (): Promise<AuditTab | undefined> => tab) } };
  const ui: AuditUI = { composerName: "Ask ChatGPT", userHeading: "You said:", assistantHeading: "ChatGPT said:", openProjectThread: vi.fn(async () => tab) };
  return { tab, browser, ui, turns, emit, reply, response, press, waitFor,
    draft: (text: string) => { draft = text; }, navigate: (value: string) => { url = value; }, hang: () => { hungWait = true; } };
}

it("defaults to manual without touching browser or local bindings", async () => {
  const f = browserFixture();
  expect(await startAsyncC2C({ ...options, async: undefined }, f.browser, f.ui)).toBeUndefined();
  expect(await startAsyncC2C({ ...options, async: false }, f.browser, f.ui)).toBeUndefined();
  expect(f.browser.tabs.selected).not.toHaveBeenCalled();
  expect(resolveAuditProject).not.toHaveBeenCalled();
  expect(fs.existsSync(path.join(directory, "state"))).toBe(false);
});

it("trusts the active thread and accepts only its newly sent correlated audit", async () => {
  const f = browserFixture(), session = (await startAsyncC2C(options, f.browser, f.ui))!;
  await session.submit(handoff); f.reply();
  expect(await session.wait()).toMatchObject({ status: "PASS", origin: "web", canAutoFix: false });
  expect(resolveAuditProject).not.toHaveBeenCalled();
  expect(f.ui.openProjectThread).not.toHaveBeenCalled();
  expect(f.press).toHaveBeenCalledOnce();
});

it("keeps the task workspace fixed even if the caller changes its options object", async () => {
  const f = browserFixture(), mutable = { ...options };
  const session = (await startAsyncC2C(mutable, f.browser, f.ui))!;
  mutable.workspaceId = "abcdef012345";
  await session.submit(handoff);
  expect(f.response().workspaceId).toBe(options.workspaceId);
  f.reply(); expect(await session.wait()).toMatchObject({ status: "PASS", workspaceId: options.workspaceId });
});

it("ignores stale ACKs before and after the new handoff, then returns early for the matching response", async () => {
  const f = browserFixture();
  f.emit("[C2C Smoke ACK] old success");
  const session = (await startAsyncC2C(options, f.browser, f.ui))!;
  await session.submit(handoff);
  f.emit(`${AUDIT_START}\n${JSON.stringify(f.response({ attemptId: "old-attempt" }))}\n${AUDIT_END}`);
  f.emit("ACK PASS");
  const waiting = session.wait();
  await vi.advanceTimersByTimeAsync(10);
  f.reply();
  expect(await waiting).toMatchObject({ status: "PASS", origin: "web" });
  expect(performance.now()).toBe(10);
  expect(f.waitFor).toHaveBeenCalledOnce();
});

it.each([
  { workspaceId: "abcdef012345" }, { taskId: "another-task" }, { handoffId: "f".repeat(64) },
  { complete: false }, { status: "ACK" }, { summary: "" }, { status: "FIX", findings: [] },
])("rejects a completed response with invalid correlation or payload: %j", async patch => {
  const f = browserFixture(), session = (await startAsyncC2C(options, f.browser, f.ui))!;
  await session.submit(handoff); f.reply(patch);
  expect(await session.wait()).toMatchObject({ status: "ERROR", origin: "local", canAutoFix: false });
  await expect(session.submit(handoff, true)).rejects.toThrow("ASYNC_AUDIT_LIMIT");
});

it("stops immediately on a correlated MCP error without retrying or sending again", async () => {
  const f = browserFixture(), session = (await startAsyncC2C(options, f.browser, f.ui))!;
  await session.submit(handoff);
  const waiting = session.wait();
  await vi.advanceTimersByTimeAsync(1);
  f.reply({ status: "ERROR", summary: "workspace_info: TimeoutError" });
  expect(await waiting).toMatchObject({ status: "ERROR", origin: "web", summary: "workspace_info: TimeoutError" });
  await expect(session.submit(handoff, true)).rejects.toThrow("ASYNC_AUDIT_LIMIT");
  expect(f.press).toHaveBeenCalledOnce();
  expect(f.waitFor).toHaveBeenCalledOnce();
  expect(performance.now()).toBe(1);
});

it("does not treat a partial frame as complete and keeps the original hard deadline across wait slices", async () => {
  const f = browserFixture(), session = (await startAsyncC2C({ ...options, timeoutMs: 2500 }, f.browser, f.ui))!;
  await session.submit(handoff);
  f.emit(`${AUDIT_START}\n${JSON.stringify(f.response())}`);
  const first = session.wait(1000);
  await vi.advanceTimersByTimeAsync(1000);
  expect(await first).toMatchObject({ status: "WAITING", remainingMs: 1500 });
  const last = session.wait(2000);
  await vi.advanceTimersByTimeAsync(1500);
  expect(await last).toMatchObject({ status: "ERROR", summary: "ASYNC_TIMEOUT" });
  f.reply();
  expect(await session.wait()).toMatchObject({ status: "ERROR", summary: "ASYNC_TIMEOUT" });
});

it("bounds a hung upstream locator independently of its own timeout implementation", async () => {
  const f = browserFixture(), session = (await startAsyncC2C({ ...options, timeoutMs: 50 }, f.browser, f.ui))!;
  await session.submit(handoff); f.hang();
  const waiting = session.wait();
  await vi.advanceTimersByTimeAsync(50);
  expect(await waiting).toMatchObject({ status: "ERROR", summary: expect.stringContaining("ASYNC_WAIT_UNAVAILABLE") });
  expect(f.waitFor).toHaveBeenCalledOnce();
});

it("rejects replies arriving after the hard deadline even when the browser has not been polled", async () => {
  const f = browserFixture(), session = (await startAsyncC2C({ ...options, timeoutMs: 50 }, f.browser, f.ui))!;
  await session.submit(handoff);
  await vi.advanceTimersByTimeAsync(51); f.reply();
  expect(await session.wait()).toMatchObject({ status: "ERROR", summary: "ASYNC_TIMEOUT" });
  expect(f.waitFor).not.toHaveBeenCalled();
});

it("does not start a send when filling the composer consumes the remaining deadline", async () => {
  const f = browserFixture(), session = (await startAsyncC2C({ ...options, timeoutMs: 50 }, f.browser, f.ui))!;
  const composer = f.tab.playwright.getByRole("textbox", { name: f.ui.composerName, exact: true });
  const fill = composer.fill;
  composer.fill = async value => { await fill(value); await new Promise(resolve => setTimeout(resolve, 50)); };
  vi.mocked(f.tab.playwright.getByRole).mockReturnValue(composer);
  const submitted = expect(session.submit(handoff)).rejects.toThrow("ASYNC_WATCHDOG_EXPIRED");
  await vi.advanceTimersByTimeAsync(50); await submitted;
  expect(f.press).not.toHaveBeenCalled();
});

it("fails closed if a user message intervenes or the thread navigates", async () => {
  const f = browserFixture(), session = (await startAsyncC2C(options, f.browser, f.ui))!;
  await session.submit(handoff);
  const response = f.response(); f.emit("another task", true);
  // The reply still carries the pending attempt, but belongs after another user turn.
  f.emit(`${AUDIT_START}\n${JSON.stringify(response)}\n${AUDIT_END}`);
  expect(await session.wait()).toMatchObject({ status: "ERROR", summary: "ASYNC_TURN_MISMATCH" });
  const g = browserFixture(), other = (await startAsyncC2C({ ...options, taskId: "navigated-task" }, g.browser, g.ui))!;
  await other.submit(handoff); g.reply(); g.navigate(threadUrl.replace("6ada4b34", "aaaaaaaa"));
  expect(await other.wait()).toMatchObject({ status: "ERROR", summary: "ASYNC_THREAD_CHANGED" });
});

it("opens one new thread from existing bindings only when no active thread exists, then retains it", async () => {
  const f = browserFixture(); f.browser.tabs.selected.mockResolvedValue(undefined);
  const session = (await startAsyncC2C(options, f.browser, f.ui))!;
  await session.submit(handoff); f.reply({ status: "FIX", findings: [finding] });
  expect(await session.wait()).toMatchObject({ status: "FIX", canAutoFix: false });
  expect(session.verifySourceForFix()).toMatchObject({ status: "FIX", canAutoFix: true });
  await session.submit(handoff + "\nFix validated.", true); f.reply(); await session.wait();
  expect(resolveAuditProject).toHaveBeenCalledExactlyOnceWith(options.workspaceId, undefined);
  expect(f.ui.openProjectThread).toHaveBeenCalledExactlyOnceWith(project);
  expect(f.browser.tabs.selected).toHaveBeenCalledOnce();
});

it("binds a new Project draft to the conversation URL created by its first send", async () => {
  const f = browserFixture(); f.browser.tabs.selected.mockResolvedValue(undefined); f.navigate(project);
  const session = (await startAsyncC2C(options, f.browser, f.ui))!;
  await session.submit(handoff); f.navigate(threadUrl); f.reply();
  expect(await session.wait()).toMatchObject({ status: "PASS", origin: "web" });
});

it("does not use cold fallback to hide browser failures or a redirected Project", async () => {
  const f = browserFixture(); f.browser.tabs.selected.mockRejectedValue(new Error("Browser unavailable"));
  await expect(startAsyncC2C(options, f.browser, f.ui)).rejects.toThrow("Browser unavailable");
  expect(resolveAuditProject).not.toHaveBeenCalled();
  f.browser.tabs.selected.mockResolvedValue(undefined); f.navigate("https://chatgpt.com/c/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
  await expect(startAsyncC2C({ ...options, taskId: "redirected-task" }, f.browser, f.ui)).rejects.toThrow("ASYNC_PROJECT_MISMATCH");
});

it("stops cold fallback before opening a thread when Project bindings are ambiguous", async () => {
  const f = browserFixture(); f.browser.tabs.selected.mockResolvedValue(undefined);
  vi.mocked(resolveAuditProject).mockImplementation(() => { throw new Error("ASYNC_PROJECT_REQUIRED"); });
  await expect(startAsyncC2C(options, f.browser, f.ui)).rejects.toThrow("ASYNC_PROJECT_REQUIRED");
  expect(f.ui.openProjectThread).not.toHaveBeenCalled();
});

it("stops on browser errors without blind retry and preserves a user's draft", async () => {
  const f = browserFixture(), session = (await startAsyncC2C(options, f.browser, f.ui))!;
  f.draft("Unsaved user message");
  await expect(session.submit(handoff)).rejects.toThrow("ASYNC_DRAFT_PRESENT");
  expect(f.press).not.toHaveBeenCalled();
  const g = browserFixture(), other = (await startAsyncC2C({ ...options, taskId: "disconnected-task" }, g.browser, g.ui))!;
  await other.submit(handoff);
  vi.mocked(g.tab.playwright.locator).mockImplementation(() => { throw new Error("Browser disconnected"); });
  expect(await other.wait()).toMatchObject({ status: "ERROR", summary: "Browser disconnected" });
  expect(g.ui.openProjectThread).not.toHaveBeenCalled();
});

it("allows at most three audits and two validated fixes, with fresh attempt IDs and handoff hashes", async () => {
  const f = browserFixture(), session = (await startAsyncC2C(options, f.browser, f.ui))!;
  const attempts: string[] = [], hashes: string[] = [];
  for (let index = 0; index < 3; index++) {
    if (index > 0) await expect(session.submit(handoff)).rejects.toThrow("ASYNC_AUDIT_LIMIT");
    await session.submit(handoff + `\nValidated revision ${index}`, index > 0);
    const request = f.response(); attempts.push(request.attemptId); hashes.push(request.handoffId);
    f.reply({ status: "FIX", findings: [finding] });
    expect(await session.wait()).toMatchObject({ status: "FIX", canAutoFix: false });
    expect(session.verifySourceForFix()).toMatchObject({ status: "FIX", canAutoFix: index < 2 });
  }
  await expect(session.submit(handoff, true)).rejects.toThrow("ASYNC_AUDIT_LIMIT");
  expect(f.press).toHaveBeenCalledTimes(3);
  expect(new Set(attempts).size).toBe(3); expect(new Set(hashes).size).toBe(3);
  await expect(startAsyncC2C(options, f.browser, f.ui)).rejects.toThrow("ASYNC_RESUME_UNSUPPORTED");
});

it("treats BLOCKED as terminal and disallows overlapping submissions", async () => {
  const f = browserFixture(), session = (await startAsyncC2C(options, f.browser, f.ui))!;
  await session.submit(handoff);
  await expect(session.submit(handoff)).rejects.toThrow("ASYNC_AUDIT_LIMIT");
  f.reply({ status: "BLOCKED", summary: "Connector not available" });
  expect(await session.wait()).toMatchObject({ status: "BLOCKED", canAutoFix: false });
  await expect(session.submit(handoff, true)).rejects.toThrow("ASYNC_AUDIT_LIMIT");
});

it.each([undefined, 5_000])("waits sequentially below the browser deadline (%s) before WAITING, then accepts a completed response", async deadline => {
  const f = browserFixture(deadline), session = (await startAsyncC2C(options, f.browser, f.ui))!;
  await session.submit(handoff);
  const waiting = session.wait();
  await vi.advanceTimersByTimeAsync(2_000);
  await expect(session.wait()).rejects.toThrow("ASYNC_BUSY");
  expect(f.waitFor).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(43_000);
  expect(await waiting).toEqual({ status: "WAITING", remainingMs: 135_000 });
  expect(f.waitFor).toHaveBeenCalledTimes(23);
  expect(f.waitFor.mock.calls.every(([wait]) => wait.timeoutMs > 0 && wait.timeoutMs <= 2_000)).toBe(true);
  const completed = session.wait();
  await vi.advanceTimersByTimeAsync(100); f.reply();
  expect(await completed).toMatchObject({ status: "PASS", origin: "web" });
  expect(performance.now()).toBe(45_100);
  expect(f.waitFor).toHaveBeenCalledTimes(24);
  expect(f.press).toHaveBeenCalledOnce();
});

it.each([0, 1_999, 2_000])("fails closed on an RPC TimeoutError after %i ms", async elapsed => {
  const f = browserFixture(), session = (await startAsyncC2C(options, f.browser, f.ui))!;
  await session.submit(handoff);
  const candidate = f.tab.playwright.locator("div:has(> h4)");
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const premature = vi.fn(() => new Promise<void>((_, reject) => {
    setTimeout(() => reject(Object.assign(new Error("RPC deadline exceeded"), { name: "TimeoutError" })), elapsed);
    started();
  }));
  candidate.waitFor = premature;
  candidate.filter = () => candidate;
  candidate.last = () => candidate;
  vi.mocked(f.tab.playwright.locator).mockReturnValue(candidate);
  const waiting = session.wait(); await ready; await vi.advanceTimersByTimeAsync(elapsed);
  expect(await waiting).toMatchObject({ status: "ERROR", summary: elapsed < 2_000 ? "ASYNC_PREMATURE_BROWSER_TIMEOUT" : expect.stringContaining("ASYNC_WAIT_UNAVAILABLE") });
  f.reply(); expect(await session.wait()).toMatchObject({ status: "ERROR" });
  await expect(session.submit(handoff, true)).rejects.toThrow("ASYNC_AUDIT_LIMIT");
  expect(premature).toHaveBeenCalledOnce();
});

it.each([0, 1_000, 1_999])("makes a premature selector deadline terminal after %i ms without retrying", async elapsed => {
  const f = browserFixture(elapsed), session = (await startAsyncC2C(options, f.browser, f.ui))!;
  await session.submit(handoff);
  const waiting = session.wait();
  await vi.advanceTimersByTimeAsync(elapsed);
  expect(await waiting).toMatchObject({ status: "ERROR", summary: "ASYNC_PREMATURE_BROWSER_TIMEOUT" });
  f.reply();
  expect(await session.wait()).toMatchObject({ status: "ERROR", summary: "ASYNC_PREMATURE_BROWSER_TIMEOUT" });
  await expect(session.submit(handoff, true)).rejects.toThrow("ASYNC_AUDIT_LIMIT");
  expect(f.waitFor).toHaveBeenCalledOnce();
  expect(f.press).toHaveBeenCalledOnce();
});

it("keeps an unresolved wait exclusive, then makes watchdog expiration terminal", async () => {
  const f = browserFixture(), session = (await startAsyncC2C(options, f.browser, f.ui))!;
  await session.submit(handoff); f.hang();
  const waiting = session.wait();
  await vi.advanceTimersByTimeAsync(2_000);
  await expect(session.wait()).rejects.toThrow("ASYNC_BUSY");
  await vi.advanceTimersByTimeAsync(1000);
  expect(await waiting).toMatchObject({ status: "ERROR", summary: expect.stringContaining("ASYNC_WAIT_UNAVAILABLE") });
  f.reply(); expect(await session.wait()).toMatchObject({ status: "ERROR" });
  await expect(session.submit(handoff, true)).rejects.toThrow("ASYNC_AUDIT_LIMIT");
  expect(f.waitFor).toHaveBeenCalledOnce();
});

it("rejects tiny caller-controlled slices instead of enabling rapid WAITING loops", async () => {
  const f = browserFixture(), session = (await startAsyncC2C(options, f.browser, f.ui))!;
  await session.submit(handoff);
  await expect(session.wait(1)).rejects.toThrow();
  expect(f.waitFor).not.toHaveBeenCalled();
  f.reply(); expect(await session.wait()).toMatchObject({ status: "PASS" });
});

it("requires source verification before a FIX can authorize edits or another audit", async () => {
  const f = browserFixture(), session = (await startAsyncC2C(options, f.browser, f.ui))!;
  await session.submit(handoff); f.reply({ status: "FIX", findings: [finding] });
  expect(await session.wait()).toMatchObject({ status: "FIX", canAutoFix: false });
  await expect(session.submit(handoff, true)).rejects.toThrow("ASYNC_AUDIT_LIMIT");
  expect(session.verifySourceForFix()).toMatchObject({ status: "FIX", canAutoFix: true });
  fs.writeFileSync(path.join(options.workspaceRoot, "hello.txt"), "Authorized in-scope fix\n");
  await session.submit(handoff + "\nUpdated source validated locally.", true); f.reply();
  expect(await session.wait()).toMatchObject({ status: "PASS" });
});

it.each(["tracked bytes", "index", "untracked bytes", "new untracked file", "deletion", "HEAD"])(
  "stops before applying FIX on local source drift in %s even with unchanged handoff text", async change => {
    const tracked = path.join(options.workspaceRoot, "hello.txt"), untracked = path.join(options.workspaceRoot, "new.txt");
    fs.writeFileSync(tracked, "dirty one\n");
    fs.writeFileSync(untracked, "untracked one\n");
    const f = browserFixture(), session = (await startAsyncC2C(options, f.browser, f.ui))!;
    await session.submit(handoff); f.reply({ status: "FIX", findings: [finding] }); await session.wait();
    if (change === "tracked bytes") fs.writeFileSync(tracked, "dirty two\n");
    if (change === "index") git(options.workspaceRoot, "add", "hello.txt");
    if (change === "untracked bytes") fs.writeFileSync(untracked, "untracked two\n");
    if (change === "new untracked file") fs.writeFileSync(path.join(options.workspaceRoot, "extra.ts"), "export const extra = 1;\n");
    if (change === "deletion") fs.unlinkSync(tracked);
    if (change === "HEAD") git(options.workspaceRoot, "commit", "--allow-empty", "-m", "fixture revision");
    expect(session.verifySourceForFix()).toMatchObject({ status: "ERROR", summary: expect.stringContaining("ASYNC_SOURCE_DRIFT"), canAutoFix: false });
    await expect(session.submit(handoff, true)).rejects.toThrow("ASYNC_AUDIT_LIMIT");
    expect(f.press).toHaveBeenCalledOnce();
  });

it("stops on unavailable local source rather than allowing an unverified fix", async () => {
  const f = browserFixture(), session = (await startAsyncC2C(options, f.browser, f.ui))!;
  await session.submit(handoff); f.reply({ status: "FIX", findings: [finding] }); await session.wait();
  cleanup(options.workspaceRoot);
  expect(session.verifySourceForFix()).toMatchObject({ status: "ERROR", canAutoFix: false });
});

it("ignores generated files excluded by Git while verifying the relevant source tree", async () => {
  fs.writeFileSync(path.join(options.workspaceRoot, ".gitignore"), "generated/\n");
  const generated = path.join(options.workspaceRoot, "generated"); fs.mkdirSync(generated);
  fs.writeFileSync(path.join(generated, "output.js"), "old build\n");
  const f = browserFixture(), session = (await startAsyncC2C(options, f.browser, f.ui))!;
  await session.submit(handoff); f.reply({ status: "FIX", findings: [finding] }); await session.wait();
  fs.writeFileSync(path.join(generated, "output.js"), "new build\n");
  expect(session.verifySourceForFix()).toMatchObject({ status: "FIX", canAutoFix: true });
});

it("detects sensitive file drift using metadata without reading credential content", async () => {
  const sensitive = path.join(options.workspaceRoot, ".npmrc");
  fs.writeFileSync(sensitive, "engine-strict=true\n");
  const before = fs.statSync(sensitive);
  const read = fs.readFileSync;
  vi.spyOn(fs, "readFileSync").mockImplementation((file, ...args) => {
    if (String(file) === sensitive) throw new Error("Sensitive content must not be read");
    return read(file, ...args);
  });
  const f = browserFixture(), session = (await startAsyncC2C(options, f.browser, f.ui))!;
  await session.submit(handoff); f.reply({ status: "FIX", findings: [finding] }); await session.wait();
  expect(session.verifySourceForFix()).toMatchObject({ status: "FIX", canAutoFix: true });
  fs.writeFileSync(sensitive, "engine-strict=nope\n");
  fs.utimesSync(sensitive, before.atime, before.mtime);
  expect(session.verifySourceForFix()).toMatchObject({ status: "ERROR", summary: expect.stringContaining("ASYNC_SOURCE_DRIFT") });
});

it("rejects a mismatched local workspace before sending any handoff", async () => {
  const f = browserFixture(), session = (await startAsyncC2C({ ...options, workspaceId: "abcdef012345" }, f.browser, f.ui))!;
  await expect(session.submit(handoff)).rejects.toThrow("ASYNC_SOURCE_WORKSPACE_MISMATCH");
  expect(f.press).not.toHaveBeenCalled();
});

it("rejects recreated handles, including after module reload, without resetting the task budget", async () => {
  const f = browserFixture(), session = (await startAsyncC2C(options, f.browser, f.ui))!;
  await session.submit(handoff);
  await expect(startAsyncC2C(options, f.browser, f.ui)).rejects.toThrow("ASYNC_RESUME_UNSUPPORTED");
  vi.resetModules();
  const reloaded = await import("../../src/c2c/async.js");
  await expect(reloaded.startAsyncC2C(options, f.browser, f.ui)).rejects.toThrow("ASYNC_RESUME_UNSUPPORTED");
  await expect(reloaded.startAsyncC2C({ ...options, workspaceId: "abcdef012345" }, f.browser, f.ui)).rejects.toThrow("ASYNC_RESUME_UNSUPPORTED");
  expect(f.browser.tabs.selected).toHaveBeenCalledOnce();
  expect(f.press).toHaveBeenCalledOnce();
});

it("retains the one-time task claim even when startup is interrupted by a browser error", async () => {
  const f = browserFixture(); f.browser.tabs.selected.mockRejectedValue(new Error("Browser stopped"));
  await expect(startAsyncC2C(options, f.browser, f.ui)).rejects.toThrow("Browser stopped");
  await expect(startAsyncC2C(options, f.browser, f.ui)).rejects.toThrow("ASYNC_RESUME_UNSUPPORTED");
  expect(f.browser.tabs.selected).toHaveBeenCalledOnce();
});

it("allows only one concurrent handle to claim a task's audit budget", async () => {
  const f = browserFixture();
  const attempts = await Promise.allSettled([
    startAsyncC2C(options, f.browser, f.ui), startAsyncC2C(options, f.browser, f.ui),
  ]);
  expect(attempts.filter(attempt => attempt.status === "fulfilled")).toHaveLength(1);
  expect(attempts.filter(attempt => attempt.status === "rejected")).toMatchObject([{ reason: { message: expect.stringContaining("ASYNC_RESUME_UNSUPPORTED") } }]);
  expect(f.browser.tabs.selected).toHaveBeenCalledOnce();
});
