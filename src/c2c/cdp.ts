import { createHash } from "node:crypto";
import { callbackTicketSchema, type CallbackTicket } from "./protocol.js";

export class CdpSendError extends Error {
  constructor(code: string, readonly delivery: "not_sent" | "uncertain" | "sent") { super(code); }
}

const uuid = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";
export function conversationUrl(input: string) {
  const value = new RegExp(`^${uuid}$`).test(input) ? `https://chatgpt.com/c/${input}` : input;
  try {
    const url = new URL(value);
    if (url.origin === "https://chatgpt.com" && !url.search && !url.hash && !url.username && !url.password &&
        new RegExp(`^(?:/g/g-p-[a-f0-9]{32}(?:-[a-z0-9-]+)?)?/c/${uuid}/?$`).test(url.pathname))
      return `${url.origin}${url.pathname.replace(/\/$/, "")}`;
  } catch { /* Reject anything except an explicit ChatGPT conversation. */ }
  throw new CdpSendError("ASYNC_THREAD_REQUIRED", "not_sent");
}

/** One loopback connection and one explicitly addressed tab; no tab discovery. */
export async function createCdpSender(conversation: string, endpoint: string) {
  const targetUrl = conversationUrl(conversation);
  try {
    const url = new URL(endpoint);
    if (url.protocol !== "ws:" || !["127.0.0.1", "[::1]"].includes(url.hostname) || !url.port ||
        url.username || url.password || url.search || url.hash || !/^\/devtools\/browser\/[a-zA-Z0-9-]+$/.test(url.pathname))
      throw new Error();
  } catch { throw new CdpSendError("ASYNC_CDP_ENDPOINT_REQUIRED", "not_sent"); }
  if (typeof WebSocket === "undefined") throw new CdpSendError("ASYNC_CDP_WEBSOCKET_REQUIRED", "not_sent");
  const socket = new WebSocket(endpoint);
  let sequence = 0, closed = false, stopped = false, navigated = false, interrupted = false;
  let targetId: string | undefined;
  let phase: "idle" | "sending" | "uncertain" | "sent" = "idle";
  let cleanup: Promise<{ targetClosed: boolean }> | undefined;
  const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  const events = new Set<(message: any) => void>();
  const disconnect = () => {
    if (closed) return;
    closed = true;
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error("ASYNC_CDP_CLOSED")); }
    pending.clear();
    for (const listener of events) listener({ method: "closed" });
    socket.close();
  };
  socket.addEventListener("close", disconnect, { once: true });
  socket.addEventListener("error", disconnect, { once: true });
  socket.addEventListener("message", event => {
    try {
      const message = JSON.parse(String(event.data)), item = pending.get(message.id);
      if (item) {
        pending.delete(message.id); clearTimeout(item.timer);
        message.error ? item.reject(new Error("ASYNC_CDP_COMMAND_FAILED")) : item.resolve(message.result);
      } else for (const listener of events) listener(message);
    } catch { disconnect(); }
  });
  const initialDeadline = performance.now() + 15_000;
  const call = (method: string, params: object = {}, sessionId?: string, deadline = initialDeadline): Promise<any> =>
    new Promise((resolve, reject) => {
      if (closed || performance.now() >= deadline) { reject(new Error(closed ? "ASYNC_CDP_CLOSED" : "ASYNC_TIMEOUT")); return; }
      const id = ++sequence;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error("ASYNC_TIMEOUT")); }, Math.max(1, deadline - performance.now()));
      pending.set(id, { resolve, reject, timer });
      try { socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); }
      catch { pending.delete(id); clearTimeout(timer); reject(new Error("ASYNC_CDP_CLOSED")); }
    });
  let sessionId: string;
  const evaluate = async (action: "ready" | "fill" | "send", text = "", deadline = initialDeadline) => {
    const remaining = Math.floor(deadline - performance.now());
    if (remaining <= 0) throw new Error("ASYNC_TIMEOUT");
    const result = await call("Runtime.evaluate", { awaitPromise: true, returnByValue: true,
      expression: `(${composerAction.toString()})(${JSON.stringify(action)},${JSON.stringify(targetUrl)},${JSON.stringify(text)},${Date.now() + remaining})`,
    }, sessionId, deadline);
    if (result.exceptionDetails || !result.result?.value?.ok)
      throw new Error(result.result?.value?.code ?? "ASYNC_COMPOSER_UNAVAILABLE");
  };
  const close = ({ completed = false } = {}) => {
    stopped = true;
    return cleanup ??= (async () => {
      try {
        // A click acknowledgement alone cannot prove that the audit finished.
        // Never close a target with an in-flight/ambiguous send or a user draft.
        if (closed || !targetId || !(phase === "idle" || phase === "sent" && completed))
          return { targetClosed: false };
        const deadline = performance.now() + 1000;
        if (navigated) await evaluate("ready", "", deadline);
        const result = await call("Target.closeTarget", { targetId }, undefined, deadline);
        return { targetClosed: result.success === true };
      } catch { return { targetClosed: false }; }
      finally { disconnect(); }
    })();
  };
  try {
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => { clearTimeout(timer); socket.removeEventListener("open", opened); socket.removeEventListener("error", failed); error ? reject(error) : resolve(); };
      const opened = () => finish(), failed = () => finish(new Error("ASYNC_CDP_UNAVAILABLE"));
      const timer = setTimeout(() => finish(new Error("ASYNC_TIMEOUT")), Math.max(1, initialDeadline - performance.now()));
      socket.addEventListener("open", opened, { once: true }); socket.addEventListener("error", failed, { once: true });
    });
    ({ targetId } = await call("Target.createTarget", { url: "about:blank" }));
    ({ sessionId } = await call("Target.attachToTarget", { targetId, flatten: true }));
    await call("Page.enable", {}, sessionId);
    await call("Page.setLifecycleEventsEnabled", { enabled: true }, sessionId);
    const loaders = new Set<string>();
    let loaderId: string | undefined, checkLoaded = () => {};
    const loaded = new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => { clearTimeout(timer); events.delete(listener); error ? reject(error) : resolve(); };
      checkLoaded = () => { if (loaderId && loaders.has(loaderId)) finish(); };
      const listener = (message: any) => {
        if (message.method === "closed") finish(new Error("ASYNC_CDP_CLOSED"));
        else if (message.sessionId === sessionId && message.method === "Page.lifecycleEvent" && message.params.name === "load") {
          loaders.add(message.params.loaderId); checkLoaded();
        }
      };
      const timer = setTimeout(() => finish(new Error("ASYNC_TIMEOUT")), Math.max(1, initialDeadline - performance.now()));
      events.add(listener);
    });
    navigated = true;
    await Promise.all([loaded, call("Page.navigate", { url: targetUrl }, sessionId).then(result => {
      if (!result.loaderId || result.errorText) throw new Error("ASYNC_CDP_NAVIGATION_FAILED");
      loaderId = result.loaderId; checkLoaded();
    })]);
    await evaluate("ready");
  } catch (error) { await close(); throw new CdpSendError(safeCode(error), "not_sent"); }
  const used = new Map<string, "not_sent" | "uncertain" | "sent">();
  return {
    close,
    interrupt() {
      interrupted = stopped = true;
      // Disconnect without closing the target or touching its draft/request.
      disconnect();
    },
    async send(request: { ticket: CallbackTicket; remainingMs: number; expiresAt: number }, handoff: string) {
      let delivery: "not_sent" | "uncertain" | "sent" = "not_sent";
      const attemptId = request.ticket.attemptId;
      if (stopped || used.has(attemptId)) throw new CdpSendError("ASYNC_SEND_TERMINAL", used.get(attemptId) ?? "not_sent");
      stopped = true; used.set(attemptId, delivery);
      try {
        callbackTicketSchema.parse(request.ticket);
        const deadline = performance.now() + Math.min(request.remainingMs, request.expiresAt - Date.now());
        if (!Number.isFinite(deadline) || performance.now() >= deadline) throw new Error("ASYNC_TIMEOUT");
        if (!handoff.startsWith("[C2C Handoff]\n") || Buffer.byteLength(handoff) > 48 * 1024 ||
            createHash("sha256").update(handoff).digest("hex") !== request.ticket.handoffId)
          throw new Error("ASYNC_HANDOFF_MISMATCH");
        const message = `${handoff}\n\nC2C_CALLBACK ${JSON.stringify(request.ticket)}\nC2C_DEADLINE ${request.expiresAt}\n\n` +
          "Inspect the repository through the routed C2C MCP. Call submit_audit_result with every callback field unchanged and " +
          "result:{status:PASS|FIX|BLOCKED|ERROR,complete:true,summary,findings}. FIX findings require file,line,evidence,fix; otherwise findings:[]. " +
          "Use BLOCKED for missing evidence/authorization, ERROR for MCP failure. A chat reply does not complete this attempt.";
        phase = "sending";
        await evaluate("fill", message, deadline);
        if (interrupted) throw new Error("ASYNC_INTERRUPTED");
        // A lost renderer response may follow a successful click: never retry it.
        phase = delivery = "uncertain"; used.set(attemptId, delivery);
        await evaluate("send", message, deadline);
        phase = delivery = "sent"; used.set(attemptId, delivery); stopped = interrupted || !!cleanup;
        return { sent: true as const, attemptId };
      } catch (error) {
        phase = delivery === "not_sent" ? "idle" : delivery;
        throw new CdpSendError(interrupted ? "ASYNC_INTERRUPTED" : safeCode(error), delivery);
      }
    },
  };
}

function safeCode(error: unknown) {
  return error instanceof Error && /^ASYNC_[A-Z_]+$/.test(error.message) ? error.message : "ASYNC_CDP_FAILED";
}

/** Serialized into the pinned renderer; never reads history or authentication. */
function composerAction(action: string, target: string, text: string, expiresAt: number): Promise<{ ok: boolean; code?: string }> {
  return new Promise(resolve => {
    let observer: MutationObserver | undefined, timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (code?: string) => { observer?.disconnect(); clearTimeout(timer); resolve({ ok: !code, ...(code ? { code } : {}) }); };
    const check = () => {
      if (Date.now() >= expiresAt) { finish("ASYNC_TIMEOUT"); return true; }
      if (location.origin + location.pathname.replace(/\/$/, "") !== target) { finish("ASYNC_THREAD_CHANGED"); return true; }
      const composers = document.querySelectorAll<HTMLElement>('#prompt-textarea[contenteditable="true"]');
      const editor = composers[0];
      if (composers.length !== 1 || !editor?.isConnected || !editor.getClientRects().length) return false;
      const draft = editor.innerText.replace(/\r\n/g, "\n").trimEnd();
      if (action !== "send" && draft.trim()) { finish("ASYNC_DRAFT_PRESENT"); return true; }
      if (action === "fill") {
        editor.focus();
        if (!document.execCommand("insertText", false, text)) finish("ASYNC_COMPOSER_UNAVAILABLE");
        else finish();
      } else if (action === "send") {
        if (draft !== text.trimEnd()) { finish("ASYNC_DRAFT_CHANGED"); return true; }
        const buttons = document.querySelectorAll<HTMLButtonElement>('[data-testid="send-button"]');
        if (buttons.length !== 1 || buttons[0].disabled || !buttons[0].getClientRects().length) return false;
        buttons[0].click(); finish();
      } else finish();
      return true;
    };
    if (check()) return;
    // Writes must never remain armed after a lost CDP response or cancellation.
    if (action !== "ready") { finish("ASYNC_COMPOSER_UNAVAILABLE"); return; }
    // Observe readiness, including button activation, without polling.
    observer = new MutationObserver(check);
    observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
    timer = setTimeout(() => finish("ASYNC_TIMEOUT"), Math.max(1, expiresAt - Date.now()));
  });
}
