import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { AuditInbox } from "../../src/c2c/inbox.js";

const hubId = `hub-${randomUUID()}`;
const registration = () => ({ hubId, workspaceId: "0123456789ab", taskId: "budget-task",
  attemptId: randomUUID(), handoffId: "a".repeat(64), timeoutMs: 50 });
const result = { status: "PASS", complete: true, summary: "Test complete", findings: [] };
afterEach(() => vi.useRealTimers());

it.each(["callback", "expiry", "cancel", "restart"])("preserves %s semantics beyond 180 seconds within the 600-second budget", async mode => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const inbox = new AuditInbox(hubId);
  try {
    expect(() => inbox.register({ ...registration(), timeoutMs: 600_001 })).toThrow();
    const ticket = inbox.register({ ...registration(), timeoutMs: 600_000 });
    const waiting = inbox.wait(ticket);
    const outcome = mode === "callback" ? expect(waiting).resolves.toEqual(result)
      : expect(waiting).rejects.toThrow(mode === "expiry" ? "ASYNC_TIMEOUT"
        : mode === "cancel" ? "ASYNC_ATTEMPT_TERMINAL" : "ASYNC_INBOX_CLOSED");
    await vi.advanceTimersByTimeAsync(181_000);
    if (mode === "callback") {
      inbox.submit({ ...ticket, result });
      expect(() => inbox.submit({ ...ticket, result })).not.toThrow();
      expect(() => inbox.submit({ ...ticket, result: { ...result, summary: "conflict" } })).toThrow("ASYNC_CALLBACK_CONFLICT");
    } else if (mode === "expiry") await vi.advanceTimersByTimeAsync(419_000);
    else if (mode === "cancel") inbox.cancel(ticket);
    else {
      inbox.close();
      const restarted = new AuditInbox(hubId);
      expect(() => restarted.submit({ ...ticket, result })).toThrow("ASYNC_ATTEMPT_UNAVAILABLE");
      restarted.close();
    }
    await outcome;
    if (mode === "callback") await vi.advanceTimersByTimeAsync(419_000);
    expect(() => inbox.submit({ ...ticket, result })).toThrow();
  } finally { inbox.close(); }
});

it("bounds the runtime inbox, rejects duplicate registration, and reclaims expired entries", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const inbox = new AuditInbox(hubId), first = registration(), ticket = inbox.register(first);
  expect(() => inbox.register(first)).toThrow("ASYNC_ATTEMPT_EXISTS");
  for (let index = 1; index < 64; index++) inbox.register(registration());
  expect(() => inbox.register(registration())).toThrow("ASYNC_INBOX_FULL");
  inbox.submit({ ...ticket, result });
  await vi.advanceTimersByTimeAsync(50);
  expect(() => inbox.submit({ ...ticket, result })).toThrow("ASYNC_ATTEMPT_UNAVAILABLE");
  expect(inbox.register(registration())).toHaveProperty("capability");
  inbox.close();
});

it.each([false, true])("makes interruption terminal without a later callback (already aborted=%s)", async alreadyAborted => {
  const inbox = new AuditInbox(hubId), ticket = inbox.register({ ...registration(), timeoutMs: 1000 });
  const abort = new AbortController();
  if (alreadyAborted) abort.abort();
  const waiting = inbox.wait(ticket, abort.signal);
  const rejected = expect(waiting).rejects.toThrow("ASYNC_WAIT_INTERRUPTED");
  if (!alreadyAborted) {
    await expect(inbox.wait(ticket)).rejects.toThrow("ASYNC_BUSY");
    abort.abort();
  }
  await rejected;
  expect(() => inbox.submit({ ...ticket, result })).toThrow("ASYNC_ATTEMPT_TERMINAL");
  inbox.close();
});
