import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";

export const AUDIT_START = "[C2C Audit v1]";
export const AUDIT_END = "[C2C Audit End v1]";
const MAX_AUDITS = 3, MAX_WAIT_MS = 5_000, MIN_WAIT_MS = 1_000, HARD_TIMEOUT_MS = 180_000;
const CHECK_INTERVAL_MS = 2_000, BROWSER_CHECK_MS = 2_000;
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
    evaluate<T, A>(fn: (arg: A) => T, arg: A, options?: { timeoutMs?: number }): Promise<T>;
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
export interface Options {
  async?: boolean;
  taskId: string;
  workspaceId: string;
  workspaceRoot: string;
  hubId?: string;
  timeoutMs?: number;
}

export interface LocalAccess {
  claimTask(taskId: string): void;
  sourceFingerprint(root: string, workspaceId: string): string;
  resolveProject(workspaceId: string, hubId?: string): Promise<string>;
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
export async function startController(options: Options, browser: AuditBrowser, ui: AuditUI, local: LocalAccess): Promise<AsyncC2C | undefined> {
  if (options.async !== true) return;
  z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/).parse(options.taskId);
  z.string().regex(/^[a-f0-9]{12}$/).parse(options.workspaceId);
  z.string().min(1).parse(options.workspaceRoot);
  const timeoutMs = z.number().int().positive().max(HARD_TIMEOUT_MS).parse(options.timeoutMs ?? HARD_TIMEOUT_MS);
  local.claimTask(options.taskId);
  let tab = await bounded(browser.tabs.selected(), 30_000);
  let identity = tab && threadIdentity(await bounded(tab.url(), 30_000));
  let projectUrl: string | undefined;
  if (!identity) {
    projectUrl = await local.resolveProject(options.workspaceId, options.hubId);
    tab = await bounded(ui.openProjectThread(projectUrl), 30_000);
    const url = await bounded(tab.url(), 30_000);
    identity = threadIdentity(url);
    const projectId = new URL(projectUrl).pathname.match(/\/g\/(g-p-[a-f0-9]{32})/)![1];
    // A freshly opened Project chat receives its /c/<id> URL after first send.
    if (url !== projectUrl && (!identity || !new URL(url!).pathname.startsWith(`/g/${projectId}-`) &&
        !new URL(url!).pathname.startsWith(`/g/${projectId}/`)))
      throw new Error("ASYNC_PROJECT_MISMATCH: New thread must belong to the resolved Project.");
  }
  return new AsyncC2C({ taskId: options.taskId, workspaceId: options.workspaceId, workspaceRoot: options.workspaceRoot }, timeoutMs, tab!, identity, { ...ui }, local, projectUrl);
}

class WatchdogExpired extends Error {
  constructor() { super("ASYNC_WATCHDOG_EXPIRED"); }
}

function errorMessage(error: unknown): string {
  try {
    if (error && typeof error === "object" && "message" in error && typeof error.message === "string") return error.message;
    return String(error);
  } catch { return "ASYNC_UNKNOWN_ERROR: Error details are unavailable."; }
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
  private nextCheckAt = 0;

  constructor(private options: Readonly<Pick<Options, "taskId" | "workspaceId" | "workspaceRoot">>, private timeoutMs: number, private tab: AuditTab, private identity: string | undefined,
    private ui: AuditUI, private local: LocalAccess, private projectUrl?: string) {}

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
      this.nextCheckAt = 0;
      this.submittedSource = this.local.sourceFingerprint(this.options.workspaceRoot, this.options.workspaceId);
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
      this.finishLocal(errorMessage(error));
      throw error;
    } finally { this.busy = false; }
  }

  /** One targeted DOM check per call. Local pacing never holds a CDP operation. */
  async wait(maxWaitMs = MAX_WAIT_MS): Promise<AuditResult | { status: "WAITING"; remainingMs: number }> {
    if (this.busy) throw new Error("ASYNC_BUSY");
    if (this.result) return this.result;
    if (!this.pending) throw new Error("ASYNC_NOT_SENT");
    z.number().int().min(MIN_WAIT_MS).max(MAX_WAIT_MS).parse(maxWaitMs);
    if (this.remaining() <= 0) return this.finishLocal("ASYNC_TIMEOUT");
    this.busy = true;
    try {
      const waitDeadline = performance.now() + Math.min(maxWaitMs, this.remaining());
      const pause = Math.min(Math.max(0, this.nextCheckAt - performance.now()), waitDeadline - performance.now());
      if (pause > 0) await new Promise<void>(resolve => setTimeout(resolve, pause));
      if (this.remaining() <= 0) return this.finishLocal("ASYNC_TIMEOUT");
      if (performance.now() >= waitDeadline) return { status: "WAITING", remainingMs: this.remaining() };
      const budget = () => {
        const value = Math.min(BROWSER_CHECK_MS, waitDeadline - performance.now());
        if (value <= 0) throw new WatchdogExpired();
        return value;
      };
      await this.io(() => this.assertThread(), budget());
      const checkMs = budget();
      const turns = await this.io(() => this.turns(checkMs), checkMs);
      this.nextCheckAt = performance.now() + CHECK_INTERVAL_MS;
      if (this.remaining() <= 0) return this.finishLocal("ASYNC_TIMEOUT");
      if (turns.anchorIndex < this.pending.baseline || turns.anchors !== 1 || turns.latestUser !== turns.anchorIndex)
        return this.finishLocal("ASYNC_TURN_MISMATCH");
      await this.io(() => this.assertThread(Boolean(turns.reply)), budget());
      if (this.remaining() <= 0) return this.finishLocal("ASYNC_TIMEOUT");
      if (!turns.reply) return { status: "WAITING", remainingMs: this.remaining() };
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
      return this.finishLocal(error instanceof WatchdogExpired
        ? "ASYNC_WAIT_UNAVAILABLE: Browser check watchdog expired; an upstream operation may still be unresolved."
        : errorMessage(error));
    } finally { this.busy = false; }
  }

  /** Call immediately before an in-scope edit round, with no intervening source edits. */
  verifySourceForFix(): AuditResult {
    if (this.busy || this.pending || this.result?.status !== "FIX") throw new Error("ASYNC_FIX_NOT_AVAILABLE");
    if (this.audits >= MAX_AUDITS) return this.result;
    try {
      if (this.local.sourceFingerprint(this.options.workspaceRoot, this.options.workspaceId) !== this.submittedSource)
        return this.finishLocal("ASYNC_SOURCE_DRIFT: Local source changed since the submitted handoff; stop before editing.");
      this.fixVerified = true;
      return this.result = { ...this.result, canAutoFix: true };
    } catch (error) { return this.finishLocal(errorMessage(error)); }
  }

  private remaining(): number { return Math.max(0, this.pending!.deadline - performance.now()); }
  private io<T>(operation: () => Promise<T>, timeoutMs = 30_000): Promise<T> {
    const remaining = this.remaining();
    if (remaining <= 0) return Promise.reject(new Error("ASYNC_TIMEOUT"));
    return bounded(operation(), Math.min(timeoutMs, remaining));
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
  private turns(timeoutMs = BROWSER_CHECK_MS) {
    return this.tab.playwright.evaluate(({ userHeading, assistantHeading, anchor, attemptId, endMarker }) => {
      const turns = [...document.querySelectorAll("h4")].filter(heading =>
        heading.textContent === userHeading || heading.textContent === assistantHeading);
      const userIndexes = turns.map((heading, index) => heading.textContent === userHeading ? index : -1).filter(index => index >= 0);
      const body = (index: number) => (turns[index]?.nextElementSibling as HTMLElement | null)?.innerText ?? "";
      const anchors = userIndexes.filter(index => body(index).includes(anchor));
      const anchorIndex = anchors[0] ?? -1;
      const replyIndex = turns.map((heading, index) => index > anchorIndex && heading.textContent === assistantHeading ? index : -1)
        .filter(index => index >= 0).pop() ?? -1;
      const reply = anchorIndex < 0 ? "" : body(replyIndex);
      return { count: turns.length, anchors: anchors.length, anchorIndex,
        latestUser: userIndexes.at(-1) ?? -1,
        reply: reply.includes(attemptId) && reply.includes(endMarker) ? reply : "" };
    }, { userHeading: this.ui.userHeading, assistantHeading: this.ui.assistantHeading, anchor: this.pending!.anchor,
      attemptId: this.pending!.request.attemptId, endMarker: AUDIT_END }, { timeoutMs });
  }
  private finishLocal(summary: string): AuditResult {
    this.result = { ...(this.pending?.request ?? this.result!), status: "ERROR", complete: true, summary, findings: [], canAutoFix: false, origin: "local" };
    this.pending = undefined;
    this.fixVerified = false;
    return this.result;
  }
}
