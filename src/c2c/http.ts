import { createHash } from "node:crypto";
import { callbackTicketSchema, type CallbackTicket } from "./protocol.js";
import type { DeliveryStatus } from "./browser.js";

export class HttpSendError extends Error {
  constructor(code: string, readonly delivery: DeliveryStatus) { super(code); }
}
/** Only an adapter that confirmed no staged browser POST remains may throw this. */
export class HttpPreparationError extends Error {
  readonly aborted = true;
  constructor() { super("ASYNC_HTTP_PREPARATION_FAILED"); }
}
export interface HttpConversation {
  conversationId: string;
  parentMessageId: string;
  messages: Array<{ id: string; role: string; text: string }>;
}
export interface PreparedHttpRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
  /** Abort any staged browser request and release its browser before delivery. */
  release(signal: AbortSignal): Promise<{ aborted: true; browserStopped: true }>;
}
export interface HttpSenderOptions {
  transport: "http";
  hubId: string;
  workspaceId: string;
  conversationId: string;
  /** Explicit local authentication; implementations must not refresh or log secrets implicitly. */
  readConversation(signal: AbortSignal): Promise<HttpConversation>;
  /** Failures without an explicit abort guarantee are terminal and uncertain. */
  prepare(message: string, signal: AbortSignal): Promise<PreparedHttpRequest>;
  fetch?: typeof globalThis.fetch;
}
export interface HttpSendRequest { ticket: CallbackTicket; remainingMs: number; expiresAt: number }

function withinDeadline<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason); };
    if (signal.aborted) { reject(signal.reason); return; }
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve().then(() => { signal.throwIfAborted(); return operation(); }).then(
      value => { signal.removeEventListener("abort", abort); resolve(value); },
      error => { signal.removeEventListener("abort", abort); reject(error); },
    );
  });
}

export function formatHttpHandoff(request: HttpSendRequest, handoff: string): string {
  return `${handoff}\n\nC2C_CALLBACK ${JSON.stringify(request.ticket)}\n\n` +
    `C2C_DEADLINE ${request.expiresAt}\n\n` +
    "Audit this handoff through the routed C2C MCP and explicit workspace. " +
    "Complete this attempt only by calling submit_audit_result with every C2C_CALLBACK field unchanged and result: " +
    "{status:PASS|FIX|BLOCKED|ERROR,complete:true,summary,findings}. " +
    "FIX requires findings with file, positive line, evidence and fix; other statuses use findings:[]. " +
    "Use BLOCKED for missing evidence/authorization and ERROR for MCP failure. " +
    "Only bounded read/callback recovery in the receiver contract is allowed; never resend or expand scope. " +
    "The capability is short-lived and only authorizes this result; do not copy it elsewhere. " +
    "Do not commit, push or rollout. A chat reply cannot complete this attempt.";
}

/** Explicit opt-in transport; AuditSession remains the only callback controller. */
export async function createHttpSender(options: HttpSenderOptions) {
  if (options.transport !== "http" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(options.conversationId))
    throw new HttpSendError("ASYNC_HTTP_CONFIGURATION_REQUIRED", "not_sent");
  const used = new Map<string, DeliveryStatus>();
  let stopped = false;
  let parent: string;
  async function read(signal: AbortSignal) {
    const snapshot = await options.readConversation(signal);
    if (snapshot.conversationId !== options.conversationId || !snapshot.parentMessageId)
      throw new HttpSendError("ASYNC_THREAD_CHANGED", "not_sent");
    return snapshot;
  }
  async function verifyBinding() {
    if (stopped) throw new HttpSendError("ASYNC_SEND_TERMINAL", "not_sent");
    try { parent = (await read(AbortSignal.timeout(5000))).parentMessageId; }
    catch (error) {
      stopped = true;
      throw error instanceof HttpSendError ? error : new HttpSendError("ASYNC_HTTP_AUTH_REQUIRED", "not_sent");
    }
  }
  await verifyBinding();
  return {
    verifyBinding,
    async send(request: HttpSendRequest, handoff: string) {
      const attemptId = request.ticket?.attemptId;
      if (stopped || used.has(attemptId))
        throw new HttpSendError("ASYNC_SEND_TERMINAL", used.get(attemptId) ?? "not_sent");
      used.set(attemptId, "not_sent"); stopped = true;
      let prepared: PreparedHttpRequest | undefined;
      let releaseStarted = false;
      let signal: AbortSignal;
      async function release() {
        releaseStarted = true;
        // An armed browser POST can resume if its debugger disconnects. Until
        // the adapter confirms abortion, neither delivery nor cleanup is known.
        used.set(attemptId, "uncertain");
        try {
          const confirmation = await withinDeadline(() => prepared!.release(signal), signal);
          if (confirmation?.aborted !== true || confirmation.browserStopped !== true)
            throw new Error("release-unconfirmed");
        } catch {
          throw new HttpSendError("ASYNC_HTTP_RELEASE_UNCONFIRMED", "uncertain");
        }
        used.set(attemptId, "not_sent");
      }
      try {
        const ticket = callbackTicketSchema.parse(request.ticket);
        if (ticket.hubId !== options.hubId || ticket.workspaceId !== options.workspaceId)
          throw new HttpSendError("ASYNC_HTTP_CALLBACK_MISMATCH", "not_sent");
        if (!handoff.startsWith("[C2C Handoff]\n") || Buffer.byteLength(handoff) > 48 * 1024 ||
            createHash("sha256").update(handoff).digest("hex") !== ticket.handoffId)
          throw new HttpSendError("ASYNC_HANDOFF_MISMATCH", "not_sent");
        const remaining = Math.min(request.remainingMs, request.expiresAt - Date.now());
        if (!Number.isFinite(remaining) || remaining <= 0)
          throw new HttpSendError("ASYNC_TIMEOUT", "not_sent");
        signal = AbortSignal.timeout(Math.min(Math.ceil(remaining), 600_000));
        const snapshot = await read(signal);
        if (snapshot.parentMessageId !== parent) throw new HttpSendError("ASYNC_HTTP_STALE_PARENT", "not_sent");
        const message = formatHttpHandoff(request, handoff);
        used.set(attemptId, "uncertain");
        try { prepared = await withinDeadline(() => options.prepare(message, signal), signal); }
        catch (error) {
          if (error instanceof HttpPreparationError) used.set(attemptId, "not_sent");
          throw new HttpSendError(error instanceof HttpPreparationError ? error.message
            : "ASYNC_HTTP_PREPARATION_UNCONFIRMED", used.get(attemptId)!);
        }
        signal.throwIfAborted();
        if (prepared.url !== "https://chatgpt.com/backend-api/f/conversation" || Buffer.byteLength(prepared.body) > 256 * 1024)
          throw new HttpSendError("ASYNC_HTTP_REQUEST_INVALID", "not_sent");
        const body = JSON.parse(prepared.body);
        if (body.conversation_id !== options.conversationId || body.parent_message_id !== parent ||
            body.action !== "next" || body.messages?.length !== 1 || body.messages[0].author?.role !== "user" ||
            typeof body.messages[0].id !== "string" || !body.messages[0].id || body.messages[0].content?.parts?.join("") !== message)
          throw new HttpSendError("ASYNC_HTTP_REQUEST_INVALID", "not_sent");
        await release();
        if ((await read(signal)).parentMessageId !== parent)
          throw new HttpSendError("ASYNC_HTTP_STALE_PARENT", "not_sent");
        signal.throwIfAborted();
        used.set(attemptId, "uncertain");
        const response = await (options.fetch ?? globalThis.fetch)(prepared.url, {
          method: "POST", redirect: "error", headers: prepared.headers, body: prepared.body, signal,
        });
        if (!response.ok || response.headers.get("cf-mitigated") === "challenge") {
          await response.body?.cancel();
          throw new HttpSendError([401, 403].includes(response.status) || response.headers.get("cf-mitigated") === "challenge"
            ? "ASYNC_HTTP_AUTH_REQUIRED" : "ASYNC_HTTP_REJECTED", "uncertain");
        }
        // Drain without retaining response text, which can contain the callback capability.
        const reader = response.body?.getReader();
        let bytes = 0;
        if (reader) try {
          for (;;) {
            const chunk = await reader.read(); if (chunk.done) break;
            bytes += chunk.value.byteLength;
            if (bytes > 16 * 1024 * 1024) { await reader.cancel(); throw new Error("response-limit"); }
            signal.throwIfAborted();
          }
        } finally { reader.releaseLock(); }
        const delivered = await read(signal);
        signal.throwIfAborted();
        if (!delivered.messages.some(item => item.id === body.messages[0].id && item.role === "user" && item.text === message))
          throw new HttpSendError("ASYNC_HTTP_DELIVERY_UNCONFIRMED", "uncertain");
        used.set(attemptId, "sent"); stopped = false;
        return { attemptId, sent: true as const };
      } catch (error) {
        // Resolve cleanup classification before reporting the original failure.
        // Never retry release if its acknowledgement or deadline was lost.
        if (prepared && !releaseStarted) {
          try { await release(); } catch (cleanupError) { error = cleanupError; }
        }
        const delivery = used.get(attemptId)!;
        throw new HttpSendError(error instanceof HttpSendError ? error.message
          : delivery === "not_sent" ? "ASYNC_HTTP_PREPARATION_FAILED" : "ASYNC_SEND_UNCERTAIN", delivery);
      }
    },
  };
}
