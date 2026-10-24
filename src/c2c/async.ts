import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { ensureDir } from "../config/paths.js";
import { stateFile } from "../config/state-files.js";
import { sourceFingerprint } from "./source.js";

export const AUDIT_START = "[C2C Audit v1]";
export const AUDIT_END = "[C2C Audit End v1]";
const MAX_AUDITS = 3, MAX_WAIT_MS = 45_000, MIN_WAIT_MS = 1_000, HARD_TIMEOUT_MS = 180_000;
const findingSchema = z.object({
  file: z.string().min(1), line: z.number().int().positive(),
  evidence: z.string().min(1), fix: z.string().min(1),
}).strict();
const responseSchema = z.object({
  taskId: z.string(), attemptId: z.string(), workspaceId: z.string(), handoffId: z.string(),
  status: z.enum(["PASS", "FIX", "BLOCKED", "ERROR"]), complete: z.literal(true),
  summary: z.string().min(1), findings: z.array(findingSchema),
}).strict().refine(value => value.status === "FIX" ? value.findings.length > 0 : value.findings.length === 0);
type Response = z.infer<typeof responseSchema>;
export type AuditResult = Response & { canAutoFix: boolean; origin: "web" | "local" };

// Structural subset of the upstream in-app browser API; no browser client/runtime.
interface Locator {
  fill(value: string): Promise<void>;
  press(key: string): Promise<void>;
  innerText(options?: { timeoutMs?: number }): Promise<string>;
  filter(options: { has?: Locator; hasText?: string }): Locator;
  last(): Locator;
  waitFor(options: { state: "visible"; timeoutMs: number }): Promise<void>;
}
export interface AuditTab {
  id: string;
  url(): Promise<string | undefined>;
  playwright: {
    getByRole(role: string, options: { name: string; exact: boolean }): Locator;
    locator(selector: string): Locator;
    evaluate<T, A>(fn: (arg: A) => T, arg: A): Promise<T>;
  };
}
export interface AuditBrowser { tabs: { selected(): Promise<AuditTab | undefined> } }
export interface AuditUI {
  // Ground these labels and the heading/container structure in the visible DOM.
  composerName: string;
  userHeading: string;
  assistantHeading: string;
  // Use visible Project navigation and New chat in the existing in-app browser.
  openProjectThread(projectUrl: string): Promise<AuditTab>;
}
interface Options {
  async?: boolean;
  taskId: string;
  workspaceId: string;
  workspaceRoot: string;
  hubId?: string;
  timeoutMs?: number;
}

function threadIdentity(value: string | undefined): string | undefined {
  if (!value) return;
  try {
    const url = new URL(value);
    if (url.origin !== "https://chatgpt.com" || url.search || url.hash || url.username || url.password) return;
    return url.pathname.match(/^(?:\/g\/g-p-[a-f0-9]{32}(?:-[a-z0-9-]+)?)?\/c\/([a-f0-9-]+)\/?$/)?.[1];
  } catch { return; }
}

/** Explicit opt-in. No state, browser access or discovery on the manual path. */
export async function startAsyncC2C(options: Options, browser: AuditBrowser, ui: AuditUI): Promise<AsyncC2C | undefined> {
  if (options.async !== true) return;
  z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/).parse(options.taskId);
  z.string().regex(/^[a-f0-9]{12}$/).parse(options.workspaceId);
  z.string().min(1).parse(options.workspaceRoot);
  const timeoutMs = z.number().int().positive().max(HARD_TIMEOUT_MS).parse(options.timeoutMs ?? HARD_TIMEOUT_MS);
  // A zero-byte, exclusive claim survives runtime loss without persisting an
  // orchestration/checkpoint. Never recreate an interrupted task's audit budget.
  const claim = stateFile("async-tasks", createHash("sha256").update(options.taskId).digest("hex"));
  ensureDir(path.dirname(claim));
  stateFile("async-tasks", path.basename(claim));
  try { fs.closeSync(fs.openSync(claim, "wx", 0o600)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("ASYNC_RESUME_UNSUPPORTED: Retain the original handle or stop async for this task.");
    throw error;
  }
  let tab = await bounded(browser.tabs.selected(), 30_000);
  let identity = tab && threadIdentity(await bounded(tab.url(), 30_000));
  let projectUrl: string | undefined;
  if (!identity) {
    const { resolveAuditProject } = await import("./project.js");
    projectUrl = resolveAuditProject(options.workspaceId, options.hubId);
    tab = await bounded(ui.openProjectThread(projectUrl), 30_000);
    const url = await bounded(tab.url(), 30_000);
    identity = threadIdentity(url);
    const projectId = new URL(projectUrl).pathname.match(/\/g\/(g-p-[a-f0-9]{32})/)![1];
    // A freshly opened Project chat receives its /c/<id> URL after first send.
    if (url !== projectUrl && (!identity || !new URL(url!).pathname.startsWith(`/g/${projectId}-`) &&
        !new URL(url!).pathname.startsWith(`/g/${projectId}/`)))
      throw new Error("ASYNC_PROJECT_MISMATCH: New thread must belong to the resolved Project.");
  }
  return new AsyncC2C({ taskId: options.taskId, workspaceId: options.workspaceId, workspaceRoot: options.workspaceRoot }, timeoutMs, tab!, identity, { ...ui }, projectUrl);
}

class WatchdogExpired extends Error {
  constructor() { super("ASYNC_WATCHDOG_EXPIRED"); }
}

function bounded<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([operation, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new WatchdogExpired()), Math.max(0, timeoutMs));
  })]).finally(() => clearTimeout(timer));
}

/** Only the factory may create a task handle and claim its one audit budget. */
class AsyncC2C {
  private audits = 0;
  private pending?: { request: Pick<Response, "taskId" | "attemptId" | "workspaceId" | "handoffId">; anchor: string; baseline: number; deadline: number };
  private result?: AuditResult;
  private busy = false;
  private submittedSource?: string;
  private fixVerified = false;

  constructor(private options: Readonly<Pick<Options, "taskId" | "workspaceId" | "workspaceRoot">>, private timeoutMs: number, private tab: AuditTab, private identity: string | undefined,
    private ui: AuditUI, private projectUrl?: string) {}

  /** fixed=true acknowledges one in-scope fix plus local validation before re-audit. */
  async submit(handoff: string, fixed = false): Promise<void> {
    if (this.busy || this.pending || this.audits >= MAX_AUDITS ||
        (this.audits > 0 && (!fixed || this.result?.status !== "FIX" || !this.fixVerified)))
      throw new Error("ASYNC_AUDIT_LIMIT: Only a validated in-scope fix may start another audit (3 audits, 2 fixes maximum).");
    if (!handoff.startsWith("[C2C Handoff]\n")) throw new Error("ASYNC_HANDOFF_REQUIRED");
    this.busy = true;
    try {
      const request = { taskId: this.options.taskId, attemptId: randomUUID(), workspaceId: this.options.workspaceId,
        handoffId: createHash("sha256").update(handoff).digest("hex") };
      const anchor = `C2C_REQUEST ${JSON.stringify(request)}`;
      this.pending = { request, anchor, baseline: 0, deadline: performance.now() + this.timeoutMs };
      this.audits++;
      this.result = undefined;
      this.fixVerified = false;
      this.submittedSource = sourceFingerprint(this.options.workspaceRoot, this.options.workspaceId);
      await this.io(() => this.assertThread());
      const baseline = await this.io(() => this.turns());
      this.pending.baseline = baseline.count;
      const composer = this.tab.playwright.getByRole("textbox", { name: this.ui.composerName, exact: true });
      if ((await this.io(() => composer.innerText())).trim()) throw new Error("ASYNC_DRAFT_PRESENT");
      const message = `${handoff}\n\n${anchor}\n\nAudit this newly sent handoff through the routed C2C MCP and explicit workspace. ` +
        `Return ${AUDIT_START}, one JSON object, then ${AUDIT_END}. Copy taskId, attemptId, workspaceId and handoffId from C2C_REQUEST. ` +
        'Include status (PASS/FIX/BLOCKED/ERROR), complete:true, summary and findings. Each FIX finding needs file, positive line, evidence and fix; other statuses use findings:[]. ' +
        'On any MCP failure immediately return ERROR with the actual error; do not retry. BLOCKED means required evidence or authorization is missing. ' +
        'Do not accept an old ACK or expand scope. Do not commit, push or rollout. Return the terminal frame only after the audit is complete.';
      await this.io(() => composer.fill(message));
      await this.io(() => composer.press("Enter"));
    } catch (error) {
      this.finishLocal(error instanceof Error ? error.message : String(error));
      throw error;
    } finally { this.busy = false; }
  }

  /** One upstream locator wait per slice; no model polling of transcript snapshots. */
  async wait(maxWaitMs = MAX_WAIT_MS): Promise<AuditResult | { status: "WAITING"; remainingMs: number }> {
    if (this.busy) throw new Error("ASYNC_BUSY");
    if (this.result) return this.result;
    if (!this.pending) throw new Error("ASYNC_NOT_SENT");
    z.number().int().min(MIN_WAIT_MS).max(MAX_WAIT_MS).parse(maxWaitMs);
    if (this.remaining() <= 0) return this.finishLocal("ASYNC_TIMEOUT");
    this.busy = true;
    try {
      await this.io(() => this.assertThread());
      const candidate = this.tab.playwright.locator("div:has(> h4)")
        .filter({ has: this.tab.playwright.getByRole("heading", { name: this.ui.assistantHeading, exact: true }) })
        .filter({ hasText: this.pending.request.attemptId }).filter({ hasText: AUDIT_END }).last();
      const slice = Math.min(maxWaitMs, Math.ceil(this.remaining()));
      const started = performance.now();
      // Give a normal locator timeout time to settle before the independent
      // watchdog. A watchdog leaves an unresolved upstream wait: never continue.
      try { await bounded(candidate.waitFor({ state: "visible", timeoutMs: slice }), Math.min(slice + 1_000, this.remaining())); }
      catch (error) {
        if (error instanceof WatchdogExpired) return this.finishLocal("ASYNC_WAIT_UNAVAILABLE: Watchdog expired with an unresolved browser wait.");
        if (error instanceof Error && error.name === "TimeoutError") {
          if (performance.now() - started < slice) return this.finishLocal("ASYNC_PREMATURE_BROWSER_TIMEOUT");
          if (!error.message.startsWith(`locator.waitFor: Timeout ${slice}ms exceeded.`))
            return this.finishLocal("ASYNC_WAIT_UNAVAILABLE: Unrecognized browser timeout.");
          if (this.remaining() <= 0) return this.finishLocal("ASYNC_TIMEOUT");
          return { status: "WAITING", remainingMs: this.remaining() };
        }
        throw error;
      }
      if (this.remaining() <= 0) return this.finishLocal("ASYNC_TIMEOUT");
      await this.io(() => this.assertThread(true));
      const turns = await this.io(() => this.turns());
      if (this.remaining() <= 0) return this.finishLocal("ASYNC_TIMEOUT");
      if (turns.anchorIndex < this.pending.baseline || turns.anchors !== 1 || turns.latestUser !== turns.anchorIndex || !turns.reply)
        return this.finishLocal("ASYNC_TURN_MISMATCH");
      const text = turns.reply;
      const start = text.indexOf(AUDIT_START), end = text.indexOf(AUDIT_END);
      if (start < 0 || end < start || text.indexOf(AUDIT_START, start + AUDIT_START.length) !== -1 ||
          text.indexOf(AUDIT_END, end + AUDIT_END.length) !== -1) return this.finishLocal("ASYNC_RESPONSE_INVALID");
      const parsed = responseSchema.safeParse(JSON.parse(text.slice(start + AUDIT_START.length, end).trim()));
      if (!parsed.success || Object.entries(this.pending.request).some(([key, value]) => parsed.data[key as keyof Response] !== value))
        return this.finishLocal("ASYNC_RESPONSE_MISMATCH");
      this.result = { ...parsed.data, canAutoFix: false, origin: "web" };
      this.pending = undefined;
      return this.result;
    } catch (error) {
      return this.finishLocal(error instanceof Error ? error.message : String(error));
    } finally { this.busy = false; }
  }

  /** Call immediately before an in-scope edit round, with no intervening source edits. */
  verifySourceForFix(): AuditResult {
    if (this.busy || this.pending || this.result?.status !== "FIX") throw new Error("ASYNC_FIX_NOT_AVAILABLE");
    if (this.audits >= MAX_AUDITS) return this.result;
    try {
      if (sourceFingerprint(this.options.workspaceRoot, this.options.workspaceId) !== this.submittedSource)
        return this.finishLocal("ASYNC_SOURCE_DRIFT: Local source changed since the submitted handoff; stop before editing.");
      this.fixVerified = true;
      return this.result = { ...this.result, canAutoFix: true };
    } catch (error) { return this.finishLocal(error instanceof Error ? error.message : String(error)); }
  }

  private remaining(): number { return Math.max(0, this.pending!.deadline - performance.now()); }
  private io<T>(operation: () => Promise<T>): Promise<T> {
    const remaining = this.remaining();
    if (remaining <= 0) return Promise.reject(new Error("ASYNC_TIMEOUT"));
    return bounded(operation(), Math.min(30_000, remaining));
  }
  private async assertThread(requireIdentity = false): Promise<void> {
    const url = await this.tab.url(), identity = threadIdentity(url);
    if (!this.identity && this.projectUrl) {
      const projectId = new URL(this.projectUrl).pathname.match(/\/g\/(g-p-[a-f0-9]{32})/)![1];
      if (identity && (new URL(url!).pathname.startsWith(`/g/${projectId}-`) || new URL(url!).pathname.startsWith(`/g/${projectId}/`)))
        this.identity = identity;
      else if (!requireIdentity && url === this.projectUrl) return;
    }
    if (!this.identity || identity !== this.identity) throw new Error("ASYNC_THREAD_CHANGED");
  }
  private turns() {
    return this.tab.playwright.evaluate(({ userHeading, assistantHeading, anchor }) => {
      const turns = [...document.querySelectorAll("h4")].filter(heading =>
        heading.textContent === userHeading || heading.textContent === assistantHeading)
        .map(heading => ({ user: heading.textContent === userHeading, text: (heading.nextElementSibling as HTMLElement | null)?.innerText ?? "" }));
      const anchors = turns.map((turn, index) => turn.user && turn.text.includes(anchor) ? index : -1).filter(index => index >= 0);
      const anchorIndex = anchors[0] ?? -1;
      return { count: turns.length, anchors: anchors.length, anchorIndex,
        latestUser: turns.map((turn, index) => turn.user ? index : -1).filter(index => index >= 0).pop() ?? -1,
        reply: anchorIndex < 0 ? "" : turns.slice(anchorIndex + 1).filter(turn => !turn.user).at(-1)?.text ?? "" };
    }, { userHeading: this.ui.userHeading, assistantHeading: this.ui.assistantHeading, anchor: this.pending!.anchor });
  }
  private finishLocal(summary: string): AuditResult {
    this.result = { ...(this.pending?.request ?? this.result!), status: "ERROR", complete: true, summary, findings: [], canAutoFix: false, origin: "local" };
    this.pending = undefined;
    this.fixVerified = false;
    return this.result;
  }
}
