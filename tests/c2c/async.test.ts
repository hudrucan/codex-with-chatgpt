import { afterEach, beforeEach, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
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
function browserFixture(delaySentTurn = false) {
  const turns: { user: boolean; text: string; bodyMissing?: boolean }[] = [];
  let draft = "", sentTurn = "", url = threadUrl, hungRead = false;
  let releaseRead: (() => void) | undefined;
  const response = (patch: Record<string, unknown> = {}) => {
    const message = turns.filter(turn => turn.user).at(-1)!.text;
    const request = JSON.parse(message.split("\n").find(line => line.startsWith("C2C_REQUEST "))!.slice("C2C_REQUEST ".length));
    return { ...request, status: "PASS", complete: true, summary: "MCP audit complete", findings: [], ...patch };
  };
  const emit = (text: string, user = false) => { turns.push({ user, text }); };
  const reply = (patch: Record<string, unknown> = {}) => emit(`${AUDIT_START}\n${JSON.stringify(response(patch))}\n${AUDIT_END}`);
  const showSentBody = () => { turns.at(-1)!.text = sentTurn; sentTurn = ""; };
  const showSentTurn = (headingOnly = false) => { emit("", true); if (!headingOnly) showSentBody(); };
  const press = vi.fn(async () => { sentTurn = draft; draft = ""; if (!delaySentTurn) showSentTurn(); });
  const waitFor = vi.fn(async () => { throw new Error("Blocking locator waits are unsupported"); });
  function locator() {
    const value = {
      fill: vi.fn(async (text: string) => { draft = text; }), press,
      innerText: vi.fn(async () => draft),
      filter: () => value,
      last: () => value,
      waitFor,
    };
    return value;
  }
  const tab: AuditTab = { id: "existing", url: vi.fn(async () => url), playwright: {
    getByRole: vi.fn(() => locator()), locator: vi.fn(() => locator()),
    evaluate: vi.fn(async (fn, arg) => {
      // Observed DOM: DIV > H4 followed by the body DIV; an unrelated H4 is
      // outside the reader's turn index space, including its submission baseline.
      vi.stubGlobal("document", { querySelectorAll: () => [...turns.map(turn => ({
        textContent: turn.user ? "You said:" : "ChatGPT said:", nextElementSibling: turn.bodyMissing ? null : { innerText: turn.text },
      })), { textContent: "Latest response", nextElementSibling: { innerText: "" } }] });
      if (hungRead) return new Promise<ReturnType<typeof fn>>(resolve => { releaseRead = () => resolve(fn(arg)); });
      return fn(arg);
    }),
  } };
  const browser = { tabs: { selected: vi.fn(async (): Promise<AuditTab | undefined> => tab) } };
  const ui: AuditUI = { composerName: "Ask ChatGPT", userHeading: "You said:", assistantHeading: "ChatGPT said:", openProjectThread: vi.fn(async () => tab) };
  return { tab, browser, ui, turns, emit, reply, response, press, waitFor, showSentTurn, showSentBody,
    draft: (text: string) => { draft = text; }, navigate: (value: string) => { url = value; },
    hang: () => { hungRead = true; }, release: () => releaseRead?.() };
}

it("defaults to manual without touching browser or local bindings", async () => {
  const f = browserFixture();
  expect(await startAsyncC2C({ ...options, async: undefined }, f.browser, f.ui)).toBeUndefined();
  expect(await startAsyncC2C({ ...options, async: false }, f.browser, f.ui)).toBeUndefined();
  expect(f.browser.tabs.selected).not.toHaveBeenCalled();
  expect(resolveAuditProject).not.toHaveBeenCalled();
  expect(fs.existsSync(path.join(directory, "state"))).toBe(false);
});

it.each([undefined, "hub-known-owner"])("trusts an active ordinary thread without resolving Hub or Project (hubId=%s)", async hubId => {
  const f = browserFixture(); f.navigate("https://chatgpt.com/c/6ada4b34-9a0c-83ec-a2c9-fef01eabdf42");
  const session = (await startAsyncC2C({ ...options, hubId }, f.browser, f.ui))!;
  await session.submit(handoff); f.reply();
  expect(await session.wait()).toMatchObject({ status: "PASS", origin: "web" });
  expect(resolveAuditProject).not.toHaveBeenCalled();
  expect(f.ui.openProjectThread).not.toHaveBeenCalled();
  expect(f.press).toHaveBeenCalledOnce();
});

it("trusts the active Project thread and accepts only its newly sent correlated audit", async () => {
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
  expect(await session.wait()).toMatchObject({ status: "WAITING" });
  await vi.advanceTimersByTimeAsync(10);
  f.reply();
  const waiting = session.wait();
  await vi.advanceTimersByTimeAsync(1990);
  expect(await waiting).toMatchObject({ status: "PASS", origin: "web" });
  expect(performance.now()).toBe(2000);
  expect(f.waitFor).not.toHaveBeenCalled();
});

it.each([
  { workspaceId: "abcdef012345" }, { taskId: "another-task" }, { handoffId: "f".repeat(64) }, { attemptId: "another-attempt" },
  { complete: false }, { status: "ACK" }, { summary: "" }, { status: "FIX", findings: [] },
])("rejects a completed response with invalid correlation or payload: %j", async patch => {
  const f = browserFixture(), session = (await startAsyncC2C(options, f.browser, f.ui))!;
  await session.submit(handoff);
  // A candidate may mention this attempt while its JSON correlation is wrong.
  f.reply({ ...patch, ...("attemptId" in patch ? { summary: `Mentions ${f.response().attemptId}` } : {}) });
  expect(await session.wait()).toMatchObject({ status: "ERROR", origin: "local", canAutoFix: false });
  await expect(session.submit(handoff, true)).rejects.toThrow("ASYNC_AUDIT_LIMIT");
});

it("stops immediately on a correlated MCP error without retrying or sending again", async () => {
  const f = browserFixture(), session = (await startAsyncC2C(options, f.browser, f.ui))!;
  await session.submit(handoff);
  f.reply({ status: "ERROR", summary: "workspace_info: TimeoutError" });
  const waiting = session.wait();
  expect(await waiting).toMatchObject({ status: "ERROR", origin: "web", summary: "workspace_info: TimeoutError" });
  await expect(session.submit(handoff, true)).rejects.toThrow("ASYNC_AUDIT_LIMIT");
  expect(f.press).toHaveBeenCalledOnce();
  expect(f.waitFor).not.toHaveBeenCalled();
  expect(performance.now()).toBe(0);
});

it("does not treat a partial frame as complete and keeps the original hard deadline across wait slices", async () => {
  const f = browserFixture(), session = (await startAsyncC2C({ ...options, timeoutMs: 2500 }, f.browser, f.ui))!;
  await session.submit(handoff);
  f.emit(`${AUDIT_START}\n${JSON.stringify(f.response())}`);
  expect(await session.wait(1000)).toMatchObject({ status: "WAITING", remainingMs: 2500 });
  const paced = session.wait(1000);
  await vi.advanceTimersByTimeAsync(1000);
  expect(await paced).toMatchObject({ status: "WAITING", remainingMs: 1500 });
  const last = session.wait(2000);
  await vi.advanceTimersByTimeAsync(1000);
  expect(await last).toMatchObject({ status: "WAITING", remainingMs: 500 });
  const expired = session.wait();
  await vi.advanceTimersByTimeAsync(500);
  expect(await expired).toMatchObject({ status: "ERROR", summary: "ASYNC_TIMEOUT" });
  f.reply();
  expect(await session.wait()).toMatchObject({ status: "ERROR", summary: "ASYNC_TIMEOUT" });
});

it("bounds a hung DOM read independently of its own timeout implementation", async () => {
  const f = browserFixture(), session = (await startAsyncC2C({ ...options, timeoutMs: 50 }, f.browser, f.ui))!;
  await session.submit(handoff); f.hang();
  const waiting = session.wait();
  await vi.advanceTimersByTimeAsync(50);
  expect(await waiting).toMatchObject({ status: "ERROR", summary: expect.stringContaining("ASYNC_WAIT_UNAVAILABLE") });
  expect(f.tab.playwright.evaluate).toHaveBeenCalledTimes(2);
  expect(f.waitFor).not.toHaveBeenCalled();
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
  expect(await session.wait()).toMatchObject({ status: "ERROR", summary: expect.stringContaining("ASYNC_TURN_MISMATCH: intervening_user") });
  const g = browserFixture(), other = (await startAsyncC2C({ ...options, taskId: "navigated-task" }, g.browser, g.ui))!;
  await other.submit(handoff); g.reply(); g.navigate(threadUrl.replace("6ada4b34", "aaaaaaaa"));
  expect(await other.wait()).toMatchObject({ status: "ERROR", summary: "ASYNC_THREAD_CHANGED" });
});

it.each([undefined, "hub-known-owner"])("passes hubId=%s to cold resolution, opens one new thread and retains it", async hubId => {
  const f = browserFixture(); f.browser.tabs.selected.mockResolvedValue(undefined);
  const session = (await startAsyncC2C({ ...options, hubId }, f.browser, f.ui))!;
  await session.submit(handoff); f.reply({ status: "FIX", findings: [finding] });
  expect(await session.wait()).toMatchObject({ status: "FIX", canAutoFix: false });
  expect(session.verifySourceForFix()).toMatchObject({ status: "FIX", canAutoFix: true });
  await session.submit(handoff + "\nFix validated.", true); f.reply(); await session.wait();
  expect(resolveAuditProject).toHaveBeenCalledExactlyOnceWith(options.workspaceId, hubId);
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
  vi.mocked(g.tab.playwright.evaluate).mockRejectedValue(new Error("Browser disconnected"));
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

it("uses one targeted DOM read per call and accepts a delayed terminal response after WAITING on the same handle", async () => {
  const f = browserFixture(), session = (await startAsyncC2C(options, f.browser, f.ui))!;
  await session.submit(handoff);
  const request = f.response();
  f.emit(`${AUDIT_START}\n${JSON.stringify(request)}`);
  expect(await session.wait()).toEqual({ status: "WAITING", remainingMs: 180_000 });
  expect(f.tab.playwright.evaluate).toHaveBeenCalledTimes(2); // Submission baseline plus one check.
  expect(vi.mocked(f.tab.playwright.evaluate).mock.calls[1][2]).toEqual({ timeoutMs: 2000 });
  const completed = session.wait();
  await vi.advanceTimersByTimeAsync(1500);
  await expect(session.wait()).rejects.toThrow("ASYNC_BUSY");
  expect(f.tab.playwright.evaluate).toHaveBeenCalledTimes(2); // Pacing holds no browser operation.
  f.reply();
  await vi.advanceTimersByTimeAsync(500);
  expect(await completed).toMatchObject({ status: "PASS", origin: "web", taskId: request.taskId, attemptId: request.attemptId, handoffId: request.handoffId });
  expect(performance.now()).toBe(2000);
  expect(f.tab.playwright.evaluate).toHaveBeenCalledTimes(3);
  expect(f.tab.playwright.locator).not.toHaveBeenCalled();
  expect(f.waitFor).not.toHaveBeenCalled();
  expect(f.press).toHaveBeenCalledOnce();
});

it.each([0, 6])("waits for a delayed sent turn at filtered baseline %s, then accepts its terminal reply on the same handle", async baseline => {
  const f = browserFixture(true);
  for (let index = 0; index < baseline / 2; index++) {
    f.emit("Earlier user message", true); f.emit("Earlier assistant reply");
  }
  const session = (await startAsyncC2C(options, f.browser, f.ui))!;
  await session.submit(handoff);
  expect(await session.wait()).toEqual({ status: "WAITING", remainingMs: 180_000 });
  await expect(vi.mocked(f.tab.playwright.evaluate).mock.results[1].value).resolves.toMatchObject({
    count: baseline, anchors: 0, anchorIndex: -1, latestUser: baseline - 2 < 0 ? -1 : baseline - 2, reply: "",
  });
  f.showSentTurn(); f.reply();
  const request = f.response(), waiting = session.wait();
  await vi.advanceTimersByTimeAsync(2000);
  expect(await waiting).toMatchObject({ status: "PASS", origin: "web", taskId: request.taskId,
    attemptId: request.attemptId, workspaceId: request.workspaceId, handoffId: request.handoffId });
  await expect(vi.mocked(f.tab.playwright.evaluate).mock.results[2].value).resolves.toMatchObject({
    anchorIndex: baseline, anchors: 1, latestUser: baseline,
  });
  expect(f.press).toHaveBeenCalledOnce();
  expect(f.waitFor).not.toHaveBeenCalled();
});

it.each([0, 6])("waits for the sent heading's body at baseline %s, then accepts its correlated reply without resending", async baseline => {
  const f = browserFixture(true);
  for (let index = 0; index < baseline / 2; index++) {
    f.emit("Earlier user message", true); f.emit("Earlier assistant reply");
  }
  const session = (await startAsyncC2C(options, f.browser, f.ui))!;
  await session.submit(handoff); f.showSentTurn(true);
  const rendering = f.turns.at(-1)!; rendering.bodyMissing = true;
  expect(await session.wait()).toEqual({ status: "WAITING", remainingMs: 180_000 });
  await expect(vi.mocked(f.tab.playwright.evaluate).mock.results[1].value).resolves.toMatchObject({
    anchors: 0, anchorIndex: -1, latestUser: baseline, previousUser: Math.max(-1, baseline - 2), reply: "",
  });
  for (const body of ["", "[C2C Handoff]\nRepo: rendering in progress"]) {
    rendering.bodyMissing = false; rendering.text = body;
    const waiting = session.wait();
    await vi.advanceTimersByTimeAsync(2000);
    expect(await waiting).toEqual({ status: "WAITING", remainingMs: 180_000 - performance.now() });
  }
  f.showSentBody(); f.reply();
  const request = f.response(), waiting = session.wait();
  await vi.advanceTimersByTimeAsync(2000);
  expect(await waiting).toMatchObject({ status: "PASS", origin: "web", taskId: request.taskId,
    attemptId: request.attemptId, workspaceId: request.workspaceId, handoffId: request.handoffId });
  expect(f.press).toHaveBeenCalledOnce();
  expect(f.waitFor).not.toHaveBeenCalled();
});

it.each([0, 6])("rejects another user while the sent body is still missing at baseline %s", async baseline => {
  const f = browserFixture(true);
  for (let index = 0; index < baseline / 2; index++) {
    f.emit("Earlier user message", true); f.emit("Earlier assistant reply");
  }
  const session = (await startAsyncC2C(options, f.browser, f.ui))!;
  await session.submit(handoff); f.showSentTurn(true);
  expect(await session.wait()).toMatchObject({ status: "WAITING" });
  f.emit("Intervening user message", true);
  const waiting = session.wait();
  await vi.advanceTimersByTimeAsync(2000);
  const result = await waiting;
  expect(result).toMatchObject({ status: "ERROR", summary: expect.stringContaining("ASYNC_TURN_MISMATCH: intervening_user") });
  // A later complete anchor and matching response cannot reopen the attempt.
  f.turns.pop(); f.showSentBody(); f.reply();
  expect(await session.wait()).toEqual(result);
  expect(f.press).toHaveBeenCalledOnce();
});

it.each(["duplicate_anchor", "stale_anchor", "intervening_user", "baseline_changed"])(
  "rejects %s with numeric diagnostics and keeps the rejection terminal", async reason => {
    const delayed = reason === "intervening_user" || reason === "baseline_changed";
    const f = browserFixture(delayed);
    f.emit("Earlier user message", true); f.emit("Earlier assistant reply");
    const session = (await startAsyncC2C(options, f.browser, f.ui))!;
    await session.submit(handoff);
    const response = delayed ? undefined : f.response();
    if (reason === "duplicate_anchor") f.emit(f.turns.at(-1)!.text, true);
    if (reason === "stale_anchor") f.turns.unshift(f.turns.pop()!);
    if (reason === "intervening_user") {
      f.showSentTurn(true); f.emit("Another user message before the anchor appears", true);
    }
    if (reason === "baseline_changed") f.turns.splice(0, 1);
    const result = await session.wait();
    expect(result).toMatchObject({ status: "ERROR", summary: expect.stringContaining(`ASYNC_TURN_MISMATCH: ${reason} (baseline=2, baselineUser=0, count=`) });
    const reads = vi.mocked(f.tab.playwright.evaluate).mock.calls.length;
    if (delayed) f.showSentTurn();
    f.emit(`${AUDIT_START}\n${JSON.stringify(response ?? f.response())}\n${AUDIT_END}`);
    expect(await session.wait()).toEqual(result);
    expect(f.tab.playwright.evaluate).toHaveBeenCalledTimes(reads);
    expect(f.press).toHaveBeenCalledOnce();
  });

it("rejects a previously observed anchor disappearing even when the original user baseline is restored", async () => {
  const f = browserFixture(), session = (await startAsyncC2C(options, f.browser, f.ui))!;
  await session.submit(handoff);
  expect(await session.wait()).toMatchObject({ status: "WAITING" });
  f.turns.pop();
  const waiting = session.wait();
  await vi.advanceTimersByTimeAsync(2000);
  expect(await waiting).toMatchObject({ status: "ERROR", summary: expect.stringContaining("ASYNC_TURN_MISMATCH: anchor_disappeared") });
});

it("rejects an intervening user rendered before the delayed anchor between DOM checks", async () => {
  const f = browserFixture(true);
  f.emit("Earlier user message", true); f.emit("Earlier assistant reply");
  const session = (await startAsyncC2C(options, f.browser, f.ui))!;
  await session.submit(handoff);
  expect(await session.wait()).toMatchObject({ status: "WAITING" });
  f.emit("Another user arrived during the render delay", true);
  f.showSentTurn(); f.reply();
  const waiting = session.wait();
  await vi.advanceTimersByTimeAsync(2000);
  expect(await waiting).toMatchObject({ status: "ERROR", summary: expect.stringContaining("ASYNC_TURN_MISMATCH: intervening_user") });
  expect(f.press).toHaveBeenCalledOnce();
});

it.each([false, true])("keeps the submission deadline while waiting for the first anchor (heading visible=%s) and rejects its late reply", async headingVisible => {
  const f = browserFixture(true), session = (await startAsyncC2C({ ...options, timeoutMs: 1500 }, f.browser, f.ui))!;
  await session.submit(handoff);
  if (headingVisible) f.showSentTurn(true);
  expect(await session.wait()).toMatchObject({ status: "WAITING", remainingMs: 1500 });
  const waiting = session.wait();
  await vi.advanceTimersByTimeAsync(1500);
  expect(await waiting).toMatchObject({ status: "ERROR", summary: "ASYNC_TIMEOUT" });
  if (headingVisible) f.showSentBody(); else f.showSentTurn();
  f.reply();
  expect(await session.wait()).toMatchObject({ status: "ERROR", summary: "ASYNC_TIMEOUT" });
  expect(f.press).toHaveBeenCalledOnce();
});

it.each(["foreign Error", "record", "string"])("preserves the observed CDP transport failure across realms (%s) and stops without retry", async kind => {
  const f = browserFixture(), session = (await startAsyncC2C(options, f.browser, f.ui))!;
  await session.submit(handoff);
  const message = 'Timed out after 2000ms waiting for selector div:has(> h4): Timed out running CDP command "Runtime.evaluate" for tab 1\nlocator.waitFor(visible) timed out for selector div:has(> h4)\nLocator diagnostics: {"kind":"no_matches"}';
  const error = kind === "foreign Error" ? vm.runInNewContext("new Error(message)", { message }) : kind === "record" ? { name: "Error", message } : message;
  vi.mocked(f.tab.playwright.evaluate).mockRejectedValue(error);
  expect(await session.wait()).toMatchObject({ status: "ERROR", origin: "local", summary: message });
  const calls = vi.mocked(f.tab.playwright.evaluate).mock.calls.length;
  f.reply(); expect(await session.wait()).toMatchObject({ status: "ERROR", summary: message });
  await expect(session.submit(handoff, true)).rejects.toThrow("ASYNC_AUDIT_LIMIT");
  expect(f.tab.playwright.evaluate).toHaveBeenCalledTimes(calls);
  expect(f.waitFor).not.toHaveBeenCalled();
  expect(f.press).toHaveBeenCalledOnce();
});

it("preserves cross-realm errors from URL checks", async () => {
  const f = browserFixture(), session = (await startAsyncC2C(options, f.browser, f.ui))!;
  await session.submit(handoff);
  const error = vm.runInNewContext('new Error("CDP transport disconnected")');
  vi.mocked(f.tab.url).mockRejectedValue(error);
  expect(await session.wait()).toMatchObject({ status: "ERROR", summary: "CDP transport disconnected" });
  expect(f.press).toHaveBeenCalledOnce();
});

it("keeps an unresolved DOM read exclusive, then makes watchdog expiration terminal even if it later settles", async () => {
  const f = browserFixture(), session = (await startAsyncC2C(options, f.browser, f.ui))!;
  await session.submit(handoff); f.hang();
  const waiting = session.wait();
  await vi.advanceTimersByTimeAsync(1_999);
  await expect(session.wait()).rejects.toThrow("ASYNC_BUSY");
  await vi.advanceTimersByTimeAsync(1);
  expect(await waiting).toMatchObject({ status: "ERROR", summary: expect.stringContaining("ASYNC_WAIT_UNAVAILABLE") });
  f.reply(); f.release();
  expect(await session.wait()).toMatchObject({ status: "ERROR" });
  await expect(session.submit(handoff, true)).rejects.toThrow("ASYNC_AUDIT_LIMIT");
  expect(f.tab.playwright.evaluate).toHaveBeenCalledTimes(2);
  expect(f.waitFor).not.toHaveBeenCalled();
});

it("clips all browser operations to one short call budget without accepting a late result", async () => {
  const f = browserFixture(), session = (await startAsyncC2C(options, f.browser, f.ui))!;
  await session.submit(handoff); f.reply();
  const evaluate = vi.mocked(f.tab.playwright.evaluate).getMockImplementation()!;
  vi.mocked(f.tab.url).mockImplementation(async () => {
    await new Promise(resolve => setTimeout(resolve, 1500)); return threadUrl;
  });
  vi.mocked(f.tab.playwright.evaluate).mockImplementation(async (...args) => {
    await new Promise(resolve => setTimeout(resolve, 1500)); return evaluate(...args);
  });
  const waiting = session.wait(4000);
  await vi.advanceTimersByTimeAsync(3999);
  await expect(session.wait()).rejects.toThrow("ASYNC_BUSY");
  await vi.advanceTimersByTimeAsync(1);
  expect(await waiting).toMatchObject({ status: "ERROR", summary: expect.stringContaining("ASYNC_WAIT_UNAVAILABLE") });
  const calls = vi.mocked(f.tab.url).mock.calls.length;
  await vi.advanceTimersByTimeAsync(500);
  expect(await session.wait()).toMatchObject({ status: "ERROR" });
  expect(f.tab.url).toHaveBeenCalledTimes(calls);
  expect(f.press).toHaveBeenCalledOnce();
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
