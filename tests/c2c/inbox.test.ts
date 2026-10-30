import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { AuditInbox } from "../../src/c2c/inbox.js";
import { MAX_AUDIT_MS } from "../../src/c2c/protocol.js";

const hubId = `hub-${randomUUID()}`;
const registration = () => ({ hubId, workspaceId: "0123456789ab", taskId: randomUUID(),
  attemptId: randomUUID(), handoffId: "a".repeat(64), timeoutMs: 50 });
const result = { status: "PASS", complete: true, summary: "Test complete", findings: [] };
const fix = { ...result, status: "FIX", findings: [{ file: "src/index.ts", line: 1, evidence: "fixture", fix: "scoped fix" }] };
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
  expect(() => inbox.submit({ ...ticket, result })).toThrow("ASYNC_TIMEOUT");
  expect(() => inbox.register(registration())).toThrow("ASYNC_INBOX_FULL");
  await vi.advanceTimersByTimeAsync(MAX_AUDIT_MS);
  expect(inbox.register(registration())).toHaveProperty("capability");
  inbox.close();
});

it.each(["pending", "cancelled", "interrupted", "expired", "PASS"])("rejects another attempt for the same task after %s", async mode => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const inbox = new AuditInbox(hubId), input = registration(), ticket = inbox.register(input);
  try {
    if (mode === "cancelled") inbox.cancel(ticket);
    if (mode === "interrupted") {
      const abort = new AbortController(); abort.abort();
      await expect(inbox.wait(ticket, abort.signal)).rejects.toThrow("ASYNC_WAIT_INTERRUPTED");
    }
    if (mode === "expired") await vi.advanceTimersByTimeAsync(51);
    if (mode === "PASS") inbox.submit({ ...ticket, result });
    expect(() => inbox.register({ ...input, attemptId: randomUUID(), handoffId: "b".repeat(64) })).toThrow("ASYNC_TASK_REPLAY");
    expect(inbox.register(registration())).toHaveProperty("capability");
    expect(inbox.register({ ...input, workspaceId: "abcdef012345", attemptId: randomUUID() })).toHaveProperty("capability");
  } finally { inbox.close(); }
});

it("allows only the latest authenticated and invalidated FIX ticket to advance up to three rounds", () => {
  const inbox = new AuditInbox(hubId), input = registration();
  let ticket = inbox.register(input);
  try {
    for (let round = 1; round <= 3; round++) {
      inbox.submit({ ...ticket, result: { ...result, status: "FIX", findings: [{ file: "src/index.ts", line: 1, evidence: "fixture", fix: "scoped fix" }] } });
      const next = { ...input, attemptId: randomUUID(), previousAttempt: ticket };
      expect(() => inbox.register(next)).toThrow("ASYNC_TASK_REPLAY"); // FIX alone does not authorize continuation.
      inbox.cancel(ticket);
      expect(() => inbox.register({ ...next, previousAttempt: { ...ticket, capability: "0".repeat(64) } })).toThrow("ASYNC_CALLBACK_MISMATCH");
      if (round === 3) expect(() => inbox.register(next)).toThrow("ASYNC_TASK_REPLAY");
      else {
        ticket = inbox.register(next);
        expect(() => inbox.register({ ...next, attemptId: randomUUID() })).toThrow("ASYNC_TASK_REPLAY");
      }
    }
  } finally { inbox.close(); }
});

it("expires the replay guard ten minutes after the capability deadline without extending it on rejection", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const inbox = new AuditInbox(hubId), input = registration(), ticket = inbox.register(input);
  const replay = () => inbox.register({ ...input, attemptId: randomUUID() });
  try {
    await vi.advanceTimersByTimeAsync(50 + MAX_AUDIT_MS - 1);
    expect(replay).toThrow("ASYNC_TASK_REPLAY");
    await vi.advanceTimersByTimeAsync(1);
    expect(replay()).toHaveProperty("capability");
    expect(() => inbox.submit({ ...ticket, result })).toThrow("ASYNC_ATTEMPT_UNAVAILABLE");
  } finally { inbox.close(); }
});

it.each([MAX_AUDIT_MS + 1, 2 * MAX_AUDIT_MS - 1])("allows verified FIX continuation after %s ms without reactivating callbacks", async elapsed => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const inbox = new AuditInbox(hubId), input = { ...registration(), timeoutMs: MAX_AUDIT_MS }, ticket = inbox.register(input);
  try {
    inbox.submit({ ...ticket, result: fix }); inbox.cancel(ticket);
    await vi.advanceTimersByTimeAsync(elapsed);
    expect(() => inbox.submit({ ...ticket, result: fix })).toThrow("ASYNC_TIMEOUT");
    expect(() => inbox.wait(ticket)).toThrow("ASYNC_TIMEOUT");
    expect(() => inbox.cancel(ticket)).toThrow("ASYNC_TIMEOUT");
    expect(() => inbox.register({ ...input, attemptId: randomUUID() })).toThrow("ASYNC_TASK_REPLAY");
    const next = inbox.register({ ...input, attemptId: randomUUID(), previousAttempt: ticket });
    inbox.submit({ ...next, result });
    expect(await inbox.wait(next)).toEqual(result);
    expect(() => inbox.submit({ ...ticket, result: fix })).toThrow("ASYNC_TIMEOUT");
    expect(() => inbox.register({ ...input, attemptId: randomUUID(), previousAttempt: ticket })).toThrow("ASYNC_TASK_REPLAY");
  } finally { inbox.close(); }
});

it.each([2 * MAX_AUDIT_MS, 2 * MAX_AUDIT_MS + 1])("rejects FIX continuation after guard expiration at %s ms", async elapsed => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const inbox = new AuditInbox(hubId), input = { ...registration(), timeoutMs: MAX_AUDIT_MS }, ticket = inbox.register(input);
  try {
    inbox.submit({ ...ticket, result: fix }); inbox.cancel(ticket);
    await vi.advanceTimersByTimeAsync(elapsed);
    expect(() => inbox.register({ ...input, attemptId: randomUUID(), previousAttempt: ticket })).toThrow("ASYNC_TASK_REPLAY");
    expect(() => inbox.submit({ ...ticket, result: fix })).toThrow("ASYNC_ATTEMPT_UNAVAILABLE");
    expect(inbox.register(registration())).toHaveProperty("capability");
  } finally { inbox.close(); }
});

it.each(["pending", "cancelled", "PASS", "ERROR", "BLOCKED", "unverified FIX"])("rejects expired %s proof as a FIX continuation", async mode => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const inbox = new AuditInbox(hubId), input = { ...registration(), timeoutMs: MAX_AUDIT_MS }, ticket = inbox.register(input);
  try {
    if (["PASS", "ERROR", "BLOCKED"].includes(mode)) inbox.submit({ ...ticket, result: { ...result, status: mode } });
    if (mode === "unverified FIX") inbox.submit({ ...ticket, result: fix });
    else if (mode !== "pending") inbox.cancel(ticket);
    await vi.advanceTimersByTimeAsync(MAX_AUDIT_MS + 1);
    expect(() => inbox.register({ ...input, attemptId: randomUUID(), previousAttempt: ticket })).toThrow("ASYNC_TASK_REPLAY");
    expect(() => inbox.cancel(ticket)).toThrow("ASYNC_TIMEOUT");
  } finally { inbox.close(); }
});

it.each(["capability", "hubId", "workspaceId", "taskId", "handoffId"])("authenticates retained FIX proof against its %s", async field => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const inbox = new AuditInbox(hubId), input = { ...registration(), timeoutMs: MAX_AUDIT_MS }, ticket = inbox.register(input);
  try {
    inbox.submit({ ...ticket, result: fix }); inbox.cancel(ticket);
    await vi.advanceTimersByTimeAsync(MAX_AUDIT_MS + 1);
    const value = field === "hubId" ? `hub-${randomUUID()}` : field === "workspaceId" ? "abcdef012345"
      : field === "taskId" ? "foreign-task" : "0".repeat(64);
    expect(() => inbox.register({ ...input, attemptId: randomUUID(), previousAttempt: { ...ticket, [field]: value } })).toThrow("ASYNC_CALLBACK_MISMATCH");
  } finally { inbox.close(); }
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
