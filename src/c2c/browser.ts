export { decodeTerminalOutput } from "./terminal-output.js";
import type { CallbackTicket } from "./protocol.js";

// Structural subset of the supported in-app browser API. No network or result reader.
interface Composer {
  innerText(): Promise<string>;
  fill(value: string): Promise<void>;
  press(key: string): Promise<void>;
}
export interface SendTab {
  id: string;
  url(): Promise<string | undefined>;
  playwright: { getByRole(role: string, options: { name: string; exact: boolean }): Composer };
}
interface Browser { browserId?: string; tabs: { selected(): Promise<SendTab | undefined> } }
type BrowserSource = Browser | undefined | (() => Promise<Browser | undefined>);

export type DeliveryStatus = "not_sent" | "uncertain" | "sent";
export class BrowserSendError extends Error {
  constructor(code: string, readonly delivery: DeliveryStatus) { super(code); }
}
const sendErrors = new Set(["ASYNC_TIMEOUT", "ASYNC_THREAD_CHANGED", "ASYNC_DRAFT_PRESENT", "ASYNC_HANDOFF_MISMATCH"]);

function transientRead(error: unknown) {
  if (!(error instanceof Error) || error instanceof BrowserSendError || /^browser\.user is unavailable\.?$/.test(error.message)) return false;
  const code = (error as Error & { code?: unknown; cause?: { code?: unknown } }).code
    ?? (error as Error & { cause?: { code?: unknown } }).cause?.code;
  return code === undefined ? error.name === "TimeoutError"
    : typeof code === "string" && ["ETIMEDOUT", "ECONNRESET", "EAI_AGAIN"].includes(code);
}

function bindingError(error: unknown, fallback: string): BrowserSendError {
  if (error instanceof BrowserSendError) return error;
  const stale = error instanceof Error && /^browser\.user is unavailable\.?$/.test(error.message);
  return new BrowserSendError(stale ? "ASYNC_BROWSER_BINDING_STALE" : fallback, "not_sent");
}

function thread(value: string | undefined) {
  if (!value) return;
  try {
    const url = new URL(value);
    if (url.origin !== "https://chatgpt.com" || url.search || url.hash || url.username || url.password) return;
    if (/^(?:\/g\/g-p-[a-f0-9]{32}(?:-[a-z0-9-]+)?)?\/c\/[a-f0-9-]+\/?$/.test(url.pathname))
      return url.pathname.replace(/\/$/, "");
  } catch { return; }
}

/** Pin the existing selected conversation; automatic delivery never opens or resolves a Project. */
export async function createBrowserSender(source: BrowserSource, composerName: string) {
  async function bind(expectedIdentity?: string) {
    try {
      const browser = typeof source === "function" ? await source() : source;
      const selected = await browser?.tabs.selected(), identity = selected && (expectedIdentity ?? thread(await selected.url()));
      if (!selected || !identity) throw new BrowserSendError("ASYNC_THREAD_REQUIRED", "not_sent");
      return { selected, identity, browserId: browser?.browserId };
    } catch (error) { throw bindingError(error, "ASYNC_BROWSER_UNAVAILABLE"); }
  }
  async function verify(binding: Awaited<ReturnType<typeof bind>>, deadline = Infinity) {
    for (let attempt = 0; ; attempt++) {
      let fallback = "ASYNC_BROWSER_UNAVAILABLE";
      try {
        if (performance.now() >= deadline) throw new BrowserSendError("ASYNC_TIMEOUT", "not_sent");
        if (thread(await binding.selected.url()) !== binding.identity)
          throw new BrowserSendError("ASYNC_THREAD_CHANGED", "not_sent");
        fallback = "ASYNC_COMPOSER_UNAVAILABLE";
        const composer = binding.selected.playwright.getByRole("textbox", { name: composerName, exact: true });
        if ((await composer.innerText()).trim()) throw new BrowserSendError("ASYNC_DRAFT_PRESENT", "not_sent");
        fallback = "ASYNC_BROWSER_UNAVAILABLE";
        if (thread(await binding.selected.url()) !== binding.identity)
          throw new BrowserSendError("ASYNC_THREAD_CHANGED", "not_sent");
        if (performance.now() >= deadline) throw new BrowserSendError("ASYNC_TIMEOUT", "not_sent");
        return;
      } catch (error) {
        if (performance.now() >= deadline) throw new BrowserSendError("ASYNC_TIMEOUT", "not_sent");
        // Only repeat reads of the pinned tab; never rebind, reset, fill or press here.
        if (attempt === 0 && transientRead(error) && performance.now() < deadline) continue;
        throw bindingError(error, fallback);
      }
    }
  }
  let binding = await bind();
  await verify(binding);
  const pinned = { tabId: binding.selected.id, identity: binding.identity, browserId: binding.browserId };
  const used = new Map<string, DeliveryStatus>();
  let stopped = false;
  return {
    // Call only before prepare, initially or after a completed, authorized FIX round.
    async verifyBinding() {
      if (stopped) throw new BrowserSendError("ASYNC_SEND_TERMINAL", "not_sent");
      stopped = true;
      const fresh = await bind(pinned.identity);
      if (fresh.selected.id !== pinned.tabId || fresh.identity !== pinned.identity || fresh.browserId !== pinned.browserId)
        throw new BrowserSendError("ASYNC_THREAD_CHANGED", "not_sent");
      await verify(fresh);
      binding = fresh;
      stopped = false;
    },
    async send(request: { ticket: CallbackTicket; remainingMs: number; expiresAt: number }, handoff: string) {
      const { ticket } = request, { attemptId } = ticket;
      if (stopped || used.has(attemptId)) throw new BrowserSendError("ASYNC_SEND_TERMINAL", used.get(attemptId) ?? "not_sent");
      // Even an interrupted fill/press consumes this sender: no uncertain-send retry.
      used.set(attemptId, "not_sent"); stopped = true;
      const { selected, identity } = binding;
      try {
        if (!Number.isFinite(request.expiresAt) || !Number.isFinite(request.remainingMs)) throw new Error("ASYNC_TIMEOUT");
        const deadline = performance.now() + Math.min(request.remainingMs, request.expiresAt - Date.now());
        const check = async () => {
          if (performance.now() >= deadline) throw new Error("ASYNC_TIMEOUT");
          if (thread(await selected.url()) !== identity) throw new Error("ASYNC_THREAD_CHANGED");
          if (performance.now() >= deadline) throw new Error("ASYNC_TIMEOUT");
        };
        const bytes = new TextEncoder().encode(handoff);
        const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), b => b.toString(16).padStart(2, "0")).join("");
        if (!handoff.startsWith("[C2C Handoff]\n") || bytes.length > 48 * 1024 || digest !== ticket.handoffId)
          throw new Error("ASYNC_HANDOFF_MISMATCH");
        const composer = selected.playwright.getByRole("textbox", { name: composerName, exact: true });
        await verify(binding, deadline);
        await composer.fill(`${handoff}\n\nC2C_CALLBACK ${JSON.stringify(ticket)}\n\n` +
          `C2C_DEADLINE ${request.expiresAt}\n\n` +
          "Audit this handoff through the routed C2C MCP and explicit workspace. " +
          "Complete this attempt only by calling submit_audit_result with every C2C_CALLBACK field unchanged and result: " +
          "{status:PASS|FIX|BLOCKED|ERROR,complete:true,summary,findings}. " +
          "FIX requires findings with file, positive line, evidence and fix; other statuses use findings:[]. " +
          "Use BLOCKED for missing evidence/authorization and ERROR for MCP failure. " +
          "Only bounded read/callback recovery in the receiver contract is allowed; never resend or expand scope. " +
          "The capability is short-lived and only authorizes this result; do not copy it elsewhere. " +
          "Do not commit, push or rollout. A chat reply cannot complete this attempt.");
        await check();
        used.set(attemptId, "uncertain");
        await composer.press("Enter");
        await check();
        used.set(attemptId, "sent");
        stopped = false;
        return { attemptId, sent: true };
      } catch (error) {
        const code = error instanceof BrowserSendError || error instanceof Error && sendErrors.has(error.message)
          ? error.message : "ASYNC_SEND_UNCERTAIN";
        throw new BrowserSendError(code, used.get(attemptId)!);
      }
    },
  };
}
