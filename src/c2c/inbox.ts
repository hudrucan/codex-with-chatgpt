import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { callbackSchema, callbackTicketSchema, registerAttemptSchema, type AuditPayload, type CallbackTicket, type Correlation } from "./protocol.js";

export class AuditInboxError extends Error {
  constructor(readonly code: string) { super(code); }
}
interface Entry {
  identity: Correlation;
  capabilityHash: Buffer;
  deadline: number;
  result?: AuditPayload;
  cancelled: boolean;
  timer: ReturnType<typeof setTimeout>;
  waiter?: { resolve(value: AuditPayload): void; reject(error: Error): void };
}
const digest = (value: string) => createHash("sha256").update(value).digest();

/** One bounded, runtime-owned inbox. Restart loses every capability and pending wait. */
export class AuditInbox {
  private entries = new Map<string, Entry>();
  private closed = false;
  constructor(readonly hubId: string) {}

  register(input: unknown): CallbackTicket {
    const { timeoutMs, ...identity } = registerAttemptSchema.parse(input);
    if (this.closed) throw new AuditInboxError("ASYNC_INBOX_CLOSED");
    if (identity.hubId !== this.hubId) throw new AuditInboxError("ASYNC_CALLBACK_OWNER_MISMATCH");
    if (this.entries.has(identity.attemptId)) throw new AuditInboxError("ASYNC_ATTEMPT_EXISTS");
    if (this.entries.size >= 64) throw new AuditInboxError("ASYNC_INBOX_FULL");
    const capability = randomBytes(32).toString("hex");
    const entry: Entry = { identity, capabilityHash: digest(capability), deadline: performance.now() + timeoutMs,
      cancelled: false, timer: setTimeout(() => this.expire(identity.attemptId), timeoutMs) };
    entry.timer.unref();
    this.entries.set(identity.attemptId, entry);
    return { ...identity, capability };
  }

  submit(input: unknown): void {
    const { result, ...ticket } = callbackSchema.parse(input);
    const entry = this.get(ticket);
    if (entry.cancelled) throw new AuditInboxError("ASYNC_ATTEMPT_TERMINAL");
    if (entry.result) {
      if (JSON.stringify(entry.result) !== JSON.stringify(result)) throw new AuditInboxError("ASYNC_CALLBACK_CONFLICT");
      return;
    }
    entry.result = result;
    entry.waiter?.resolve(result);
    entry.waiter = undefined;
  }

  wait(input: unknown, signal?: AbortSignal): Promise<AuditPayload> {
    const entry = this.get(callbackTicketSchema.parse(input));
    if (entry.cancelled) return Promise.reject(new AuditInboxError("ASYNC_ATTEMPT_TERMINAL"));
    if (entry.result) return Promise.resolve(entry.result);
    if (entry.waiter) return Promise.reject(new AuditInboxError("ASYNC_BUSY"));
    if (signal?.aborted) {
      entry.cancelled = true;
      return Promise.reject(new AuditInboxError("ASYNC_WAIT_INTERRUPTED"));
    }
    return new Promise<AuditPayload>((resolve, reject) => {
      const abort = () => { entry.waiter = undefined; entry.cancelled = true; reject(new AuditInboxError("ASYNC_WAIT_INTERRUPTED")); };
      signal?.addEventListener("abort", abort, { once: true });
      const cleanup = () => signal?.removeEventListener("abort", abort);
      entry.waiter = { resolve: value => { cleanup(); resolve(value); }, reject: error => { cleanup(); reject(error); } };
    });
  }

  cancel(input: unknown): void {
    const entry = this.get(callbackTicketSchema.parse(input));
    entry.cancelled = true;
    entry.waiter?.reject(new AuditInboxError("ASYNC_ATTEMPT_TERMINAL"));
    entry.waiter = undefined;
  }

  close(): void {
    this.closed = true;
    for (const entry of this.entries.values()) {
      clearTimeout(entry.timer);
      entry.waiter?.reject(new AuditInboxError("ASYNC_INBOX_CLOSED"));
    }
    this.entries.clear();
  }

  private get(ticket: CallbackTicket): Entry {
    if (this.closed) throw new AuditInboxError("ASYNC_INBOX_CLOSED");
    const entry = this.entries.get(ticket.attemptId);
    if (!entry) throw new AuditInboxError("ASYNC_ATTEMPT_UNAVAILABLE");
    if (performance.now() >= entry.deadline) { this.expire(ticket.attemptId); throw new AuditInboxError("ASYNC_TIMEOUT"); }
    if (Object.entries(entry.identity).some(([key, value]) => ticket[key as keyof Correlation] !== value) ||
        !timingSafeEqual(entry.capabilityHash, digest(ticket.capability))) throw new AuditInboxError("ASYNC_CALLBACK_MISMATCH");
    return entry;
  }
  private expire(attemptId: string): void {
    const entry = this.entries.get(attemptId);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.entries.delete(attemptId);
    entry.waiter?.reject(new AuditInboxError("ASYNC_TIMEOUT"));
  }
}
