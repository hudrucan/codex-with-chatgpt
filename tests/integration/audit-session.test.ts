import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startBridge, type Bridge } from "../../src/bridge/server.js";
import { AuditSession } from "../../src/c2c/session.js";
import { createBrowserSender } from "../../src/c2c/browser.js";
import { MAX_AUDIT_MS, type CallbackTicket } from "../../src/c2c/protocol.js";
import { WorkspaceRegistry } from "../../src/workspace/registry.js";
import * as sourceAccess from "../../src/c2c/source.js";
import { buildC2C } from "../../scripts/build-c2c.mjs";
import { fixtureHub, cleanup, isolateStateDir, makeTmpDir, makeGitRepo, write } from "../helpers.js";

let state: string, root: string, bridge: Bridge, client: Client, session: AuditSession;
const pass = { status: "PASS", complete: true, summary: "MCP audit complete", findings: [] };
const fix = { ...pass, status: "FIX", findings: [{ file: "src/index.ts", line: 1, evidence: "fixture", fix: "scoped edit" }] };
const handoff = "[C2C Handoff]\nRepo fixture, uncommitted validation.";
const options = () => ({ hubId: bridge.hubId, workspaceId: new WorkspaceRegistry(bridge.hubId).list()[0].workspaceId,
  workspaceRoot: root, taskId: "session-task", timeoutMs: 2000 });
const submit = (request: { ticket: CallbackTicket }, result = pass) => client.callTool({
  name: "submit_audit_result", arguments: { ...request.ticket, result },
});
beforeEach(async () => {
  state = isolateStateDir(); root = makeTmpDir("audit-session"); makeGitRepo(root);
  bridge = await startBridge({ hubId: fixtureHub(root).hubId, port: 0 });
  const token = bridge.authStore.issueTokens({ clientId: "session-test", scopes: ["audit.submit"] }).accessToken;
  client = new Client({ name: "session-test", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${bridge.localBaseUrl()}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  }));
  session = new AuditSession(options());
});
afterEach(async () => {
  vi.restoreAllMocks();
  await session.close(); await client.close(); await bridge.close();
  cleanup(state); cleanup(root); delete process.env.C2C_STATE_DIR;
});

it.each(["missing browser", "missing tab", "stale URL", "stale composer", "missing composer", "draft"])(
  "returns manual fallback before source hashing or registration for %s", async phase => {
    const transport = vi.spyOn(globalThis, "fetch"), scans = vi.spyOn(sourceAccess, "sourceFingerprint");
    const browser = phase === "missing browser" ? undefined : { tabs: { selected: async () =>
      phase === "missing tab" ? undefined : { id: "existing", url: async () => {
        if (phase === "stale URL") throw new Error("browser.user is unavailable.");
        return "https://chatgpt.com/c/12345678-abcd";
      }, playwright: { getByRole: () => ({
        innerText: async () => {
          if (phase === "stale composer") throw new Error("browser.user is unavailable.");
          if (phase === "missing composer") throw new Error("Composer missing");
          return phase === "draft" ? "User draft" : "";
        },
        fill: vi.fn(), press: vi.fn(),
      }) } },
    } };
    const code = phase.startsWith("stale") ? "ASYNC_BROWSER_BINDING_STALE"
      : phase === "draft" ? "ASYNC_DRAFT_PRESENT"
      : phase === "missing composer" ? "ASYNC_COMPOSER_UNAVAILABLE" : "ASYNC_THREAD_REQUIRED";
    // Sender setup is the first step of the automatic flow, before terminal prepare.
    await expect((async () => {
      await createBrowserSender(browser, "Observed composer");
      await session.prepare(handoff);
    })()).rejects.toMatchObject({ message: code, delivery: "not_sent" });
    expect(transport).not.toHaveBeenCalled(); expect(scans).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(state, "async-tasks"))).toBe(false);
  },
);

it("uses two scans per audit, one before each fix, and caps the task at three audits/two fixes", async () => {
  const scans = vi.spyOn(sourceAccess, "sourceFingerprint");
  await session.close(); session = new AuditSession({ ...options(), timeoutMs: 10_000 });
  expect(scans).not.toHaveBeenCalled();
  for (let i = 0; i < 3; i++) {
    const request = await session.prepare(handoff + i);
    expect(request.ticket.handoffId).toBe(createHash("sha256").update(handoff + i).digest("hex"));
    expect(request).not.toHaveProperty("message");
    expect(scans).toHaveBeenCalledTimes(3 * i + 1);
    await expect(session.prepare(handoff)).rejects.toThrow("ASYNC_AUDIT_LIMIT");
    const waiting = session.wait();
    await expect(session.wait()).rejects.toThrow("ASYNC_NOT_PENDING");
    expect((await submit(request, fix)).structuredContent).toEqual({ accepted: true });
    const result = await waiting;
    expect(result).toMatchObject({ status: "FIX", canContinue: i < 2 });
    expect(result).not.toHaveProperty("capability");
    expect(scans).toHaveBeenCalledTimes(3 * i + 2);
    if (i < 2) {
      expect(await session.verifySourceForFix()).toEqual({ canAutoFix: true });
      await expect(session.verifySourceForFix()).rejects.toThrow("ASYNC_FIX_NOT_AVAILABLE");
      expect(scans).toHaveBeenCalledTimes(3 * i + 3);
      write(root, "src/index.ts", `export const answer = ${i};\n`);
    }
  }
  await expect(session.verifySourceForFix()).rejects.toThrow("ASYNC_FIX_NOT_AVAILABLE");
  await expect(session.prepare(handoff)).rejects.toThrow("ASYNC_AUDIT_LIMIT");
  expect(fs.existsSync(path.join(state, "async-tasks"))).toBe(false);
});

it("ignores abandoned legacy claims and isolates an independently authorized task from an interrupted attempt", async () => {
  const legacy = write(state, `async-tasks/${createHash("sha256").update(options().taskId).digest("hex")}`, "");
  const first = await session.prepare(handoff);
  await session.close();
  await expect(session.prepare(handoff)).rejects.toThrow("ASYNC_AUDIT_LIMIT");
  session = new AuditSession({ ...options(), taskId: "independently-authorized-task" });
  const second = await session.prepare(handoff), waiting = session.wait();
  expect(second.ticket.attemptId).not.toBe(first.ticket.attemptId);
  expect(second.ticket.capability).not.toBe(first.ticket.capability);
  expect((await submit(first)).isError).toBe(true);
  expect((await submit(second)).structuredContent).toEqual({ accepted: true });
  expect(await waiting).toMatchObject({ status: "PASS", canContinue: false });
  expect(fs.readFileSync(legacy).length).toBe(0);
  expect(fs.readdirSync(path.dirname(legacy))).toHaveLength(1);
});

it.each(["during registration", "before wait", "during wait", "before fix", "during fix authorization"])("fails closed on source drift %s", async phase => {
  const fetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (...args) => {
    const response = await fetch(...args);
    if ((phase === "during registration" && String(args[0]).endsWith("/register")) ||
        (phase === "during fix authorization" && String(args[0]).endsWith("/cancel"))) write(root, "src/index.ts", "drift");
    return response;
  });
  const request = await session.prepare(handoff);
  if (phase === "before wait") write(root, "src/index.ts", "drift");
  const waiting = session.wait();
  if (phase === "during wait") write(root, "src/index.ts", "drift");
  const rejected = ["during registration", "before wait", "during wait"].includes(phase)
    ? expect(waiting).rejects.toThrow("ASYNC_SOURCE_DRIFT") : undefined;
  expect((await submit(request, fix)).structuredContent).toEqual({ accepted: true });
  if (rejected) await rejected;
  else {
    await waiting;
    if (phase === "before fix") write(root, "src/index.ts", "drift");
    await expect(session.verifySourceForFix()).rejects.toThrow("ASYNC_SOURCE_DRIFT");
  }
  await expect(session.prepare(handoff)).rejects.toThrow("ASYNC_AUDIT_LIMIT");
});

it("validates canonical workspace identity before registration without an initial source scan", () => {
  const transport = vi.spyOn(globalThis, "fetch"), scans = vi.spyOn(sourceAccess, "sourceFingerprint");
  expect(() => new AuditSession({ ...options(), workspaceId: "abcdef012345" })).toThrow("ASYNC_SOURCE_WORKSPACE_MISMATCH");
  expect(scans).not.toHaveBeenCalled(); expect(transport).not.toHaveBeenCalled();
});

it.each(["prepare", "callback", "fix"])("rejects a source scan that exhausts the deadline at %s", async phase => {
  await session.close();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  try {
    session = new AuditSession(options());
    const scan = sourceAccess.sourceFingerprint;
    let slow = phase === "prepare";
    vi.spyOn(sourceAccess, "sourceFingerprint").mockImplementation((...args) => {
      const source = scan(...args); if (slow) vi.advanceTimersByTime(2100); return source;
    });
    if (phase === "prepare") await expect(session.prepare(handoff)).rejects.toThrow("ASYNC_TIMEOUT");
    else {
      const request = await session.prepare(handoff); slow = phase === "callback";
      const waiting = session.wait();
      const rejected = slow ? expect(waiting).rejects.toThrow("ASYNC_TIMEOUT") : undefined;
      expect((await submit(request, fix)).structuredContent).toEqual({ accepted: true });
      if (rejected) await rejected;
      else { await waiting; slow = true; await expect(session.verifySourceForFix()).rejects.toThrow("ASYNC_FIX_NOT_AVAILABLE"); }
    }
    await expect(session.prepare(handoff)).rejects.toThrow("ASYNC_AUDIT_LIMIT");
  } finally { vi.useRealTimers(); }
});

it.each(["restart", "grant removal"])("rejects automatic fixes after %s", async kind => {
  const request = await session.prepare(handoff), waiting = session.wait();
  await submit(request, fix); await waiting;
  if (kind === "restart") {
    await bridge.close(); await client.close(); bridge = await startBridge({ hubId: bridge.hubId, port: 0 });
  } else new WorkspaceRegistry(bridge.hubId).remove(options().workspaceId);
  await expect(session.verifySourceForFix()).rejects.toThrow();
});

it("retains the original deadline and rejects a late callback without sending an acknowledgement", async () => {
  await session.close(); vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  try {
    session = new AuditSession({ ...options(), timeoutMs: 100 });
    const request = await session.prepare(handoff);
    await vi.advanceTimersByTimeAsync(120);
    await expect(session.wait()).rejects.toThrow("ASYNC_TIMEOUT");
    expect((await submit(request)).isError).toBe(true);
  } finally { vi.useRealTimers(); }
});

it("accepts an OAuth callback after 180 seconds within the default 600-second budget", async () => {
  await session.close(); vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const transportTimeout = vi.spyOn(AbortSignal, "timeout");
  try {
    const { timeoutMs: _timeoutMs, ...defaults } = options(); session = new AuditSession(defaults);
    const request = await session.prepare(handoff), waiting = session.wait();
    expect(request.remainingMs).toBe(600_000); expect(transportTimeout).toHaveBeenCalledWith(602_000);
    await vi.advanceTimersByTimeAsync(181_000);
    expect((await submit(request)).structuredContent).toEqual({ accepted: true });
    expect(await waiting).toMatchObject({ status: "PASS", canContinue: false });
    expect((await submit(request)).structuredContent).toEqual({ accepted: true });
  } finally { transportTimeout.mockRestore(); vi.useRealTimers(); }
});

it("continues verified FIX rounds after ten-minute edit phases without accepting expired callbacks or exceeding three audits", async () => {
  await session.close(); vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  try {
    session = new AuditSession({ ...options(), timeoutMs: MAX_AUDIT_MS });
    for (let round = 0; round < 3; round++) {
      const request = await session.prepare(handoff + round), waiting = session.wait();
      expect((await submit(request, fix)).structuredContent).toEqual({ accepted: true });
      expect(await waiting).toMatchObject({ status: "FIX", canContinue: round < 2 });
      if (round < 2) {
        expect(await session.verifySourceForFix()).toEqual({ canAutoFix: true });
        await vi.advanceTimersByTimeAsync(MAX_AUDIT_MS + 1);
        write(root, "src/index.ts", `export const answer = ${round};\n`);
        expect((await submit(request, fix)).isError).toBe(true);
      }
    }
    await expect(session.verifySourceForFix()).rejects.toThrow("ASYNC_FIX_NOT_AVAILABLE");
    await expect(session.prepare(handoff)).rejects.toThrow("ASYNC_AUDIT_LIMIT");
  } finally { vi.useRealTimers(); }
});

it("stops a verified FIX when editing outlasts the replay guard", async () => {
  await session.close(); vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  try {
    session = new AuditSession({ ...options(), timeoutMs: MAX_AUDIT_MS });
    const request = await session.prepare(handoff), waiting = session.wait();
    await submit(request, fix); await waiting;
    expect(await session.verifySourceForFix()).toEqual({ canAutoFix: true });
    await vi.advanceTimersByTimeAsync(2 * MAX_AUDIT_MS);
    write(root, "src/index.ts", "scoped fix\n");
    await expect(session.prepare(handoff)).rejects.toThrow("ASYNC_TASK_REPLAY");
    expect((await submit(request, fix)).isError).toBe(true);
    await expect(session.prepare(handoff)).rejects.toThrow("ASYNC_AUDIT_LIMIT");
  } finally { vi.useRealTimers(); }
});

it("does not offer a ticket when the callback runtime is unavailable", async () => {
  await bridge.close(); await expect(session.prepare(handoff)).rejects.toThrow("ASYNC_CALLBACK_RUNTIME_UNAVAILABLE");
});

it("fails closed on EPERM before offering a browser ticket", async () => {
  const transport = vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("fetch failed", { cause: { code: "EPERM" } }));
  try { await expect(session.prepare(handoff)).rejects.toThrow("ASYNC_CALLBACK_TRANSPORT_UNAVAILABLE: EPERM"); }
  finally { transport.mockRestore(); }
});

it("stops after callback loss without retrying the wait or resuming the failed task", async () => {
  const request = await session.prepare(handoff);
  const transport = vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("private transport detail", { cause: { code: "EPERM" } }));
  try {
    const error = await session.wait().catch(error => error);
    expect(error.message).toBe("ASYNC_CALLBACK_TRANSPORT_UNAVAILABLE: EPERM");
    expect(error.message).not.toContain(request.ticket.capability);
    expect(transport.mock.calls.filter(([url]) => String(url).endsWith("/wait"))).toHaveLength(1);
    await expect(session.prepare(handoff)).rejects.toThrow("ASYNC_AUDIT_LIMIT");
    expect((await submit(request)).isError).toBe(true);
  } finally { transport.mockRestore(); }
});

const sizedHandoff = (pattern: string, bytes = 48 * 1024) => handoff + pattern.repeat(bytes).slice(0, bytes - Buffer.byteLength(handoff));

it.each(["concurrent", "EOF", "Ctrl+C", "killed"])("blocks cross-process task replay after %s and accepts a newly authorized task", async mode => {
  const out = path.join(state, "replay-bundle"); await buildC2C(out);
  const start = () => {
    const child = spawn(process.execPath, [path.join(out, "local.mjs"), "async"], {
      env: process.env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    });
    const reader = createInterface({ input: child.stdout })[Symbol.asyncIterator](), closed = once(child, "close");
    child.stderr.resume();
    return { child, closed, read: async () => JSON.parse((await reader.next()).value!),
      prepare: (taskId: string, text = handoff) => child.stdin.write(JSON.stringify({
        operation: "prepare", options: { ...options(), taskId, timeoutMs: 5000 }, handoff: text,
      }) + "\n") };
  };
  const first = start(), controllers = [first];
  try {
    first.prepare("multi-process-task");
    if (mode === "concurrent") {
      const second = start(); controllers.push(second); second.prepare("multi-process-task", handoff + "changed");
      const replies = await Promise.all([first.read(), second.read()]);
      expect(replies.map(reply => reply.ok).sort()).toEqual([false, true]);
      expect(replies.find(reply => !reply.ok)).toEqual({ ok: false, error: "ASYNC_TASK_REPLAY" });
      const winner = replies[0].ok ? first : second, loser = replies[0].ok ? second : first;
      expect((await loser.closed)[0]).toBe(1);
      winner.child.stdin.end(); await winner.closed;
    } else {
      expect(await first.read()).toMatchObject({ ok: true, value: { ticket: { taskId: "multi-process-task" } } });
      if (mode === "EOF") first.child.stdin.end();
      else if (mode === "Ctrl+C") first.child.stdin.write("\x03");
      else first.child.kill("SIGKILL");
      await first.closed;
      const restarted = start(); controllers.push(restarted);
      restarted.prepare("multi-process-task", handoff + "changed");
      expect(await restarted.read()).toEqual({ ok: false, error: "ASYNC_TASK_REPLAY" });
      expect((await restarted.closed)[0]).toBe(1);
    }
    const independent = start(); controllers.push(independent); independent.prepare("new-user-authorization");
    const prepared = await independent.read(); expect(prepared.ok).toBe(true);
    expect((await submit(prepared.value)).structuredContent).toEqual({ accepted: true });
    expect(await independent.read()).toMatchObject({ ok: true, value: { status: "PASS", canContinue: false } });
    expect((await independent.closed)[0]).toBe(0);
    expect(fs.existsSync(path.join(state, "async-tasks"))).toBe(false);
  } finally { for (const controller of controllers) { controller.child.kill(); await controller.closed; } }
});

it.each([
  ["callback", handoff, undefined], ["uncertain send", handoff, undefined], ["stdin closed", handoff, undefined],
  ["callback lost", handoff, undefined], ["FIX loop", handoff, undefined], ["reconfigured options", handoff, undefined],
  ["stdin closed at prepare", handoff, "ASYNC_INTERRUPTED"],
  ["quoted/backslash handoff", sizedHandoff('"\\'), undefined], ["maximum JSON escaping", sizedHandoff("\u0000"), undefined],
  ["oversized handoff", sizedHandoff('"\\', 48 * 1024 + 1), "ASYNC_HANDOFF_REQUIRED"],
  ["oversized serialized input", sizedHandoff("\u0000", 50 * 1024), "ASYNC_LOCAL_REQUEST_INVALID"],
] as const)("prepares and waits in one native command with %s", async (mode, content, expectedError) => {
  const out = path.join(state, "bundle"); await buildC2C(out);
  const child = spawn(process.execPath, [path.join(out, "local.mjs"), "async"], { env: process.env, stdio: ["pipe", "pipe", "pipe"] });
  const reader = createInterface({ input: child.stdout })[Symbol.asyncIterator](), closed = once(child, "close");
  let stderr = ""; child.stderr.on("data", value => { stderr += value; });
  const read = async () => JSON.parse((await reader.next()).value!);
  try {
    const command = { operation: "prepare", options: { ...options(), taskId: "native-task" }, handoff: content };
    if (content !== handoff) expect(Buffer.byteLength(JSON.stringify(command))).toBeGreaterThan(64 * 1024);
    if (mode === "stdin closed at prepare") child.stdin.end(JSON.stringify(command) + "\n");
    else child.stdin.write(JSON.stringify(command) + "\n");
    const response = await read();
    if (mode === "stdin closed at prepare" && response.ok) {
      // Windows may deliver pipe EOF after registration completes. Both orderings
      // must stop the process and revoke any ticket already emitted.
      expect(response.value.ticket.taskId).toBe("native-task");
      expect(await read()).toEqual({ ok: false, error: "ASYNC_INTERRUPTED" });
      expect((await closed)[0], stderr).toBe(1);
      expect((await submit(response.value)).isError).toBe(true);
      return;
    }
    if (expectedError) {
      expect(response).toEqual({ ok: false, error: expectedError }); expect((await closed)[0], stderr).toBe(1); return;
    }
    const request = response.value;
    expect(response.ok).toBe(true); expect(request.ticket.taskId).toBe("native-task");
    expect(request.ticket.handoffId).toBe(createHash("sha256").update(content).digest("hex"));
    expect(JSON.stringify(response)).not.toContain(root); expect(request).not.toHaveProperty("message");
    expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThan(1024);
    if (mode === "uncertain send" || mode === "stdin closed") {
      if (mode === "uncertain send") child.stdin.write("\x03"); else child.stdin.end();
      expect(await read()).toMatchObject({ ok: false, error: expect.stringContaining("ASYNC_INTERRUPTED") });
      expect((await closed)[0], stderr).toBe(1); expect((await submit(request)).isError).toBe(true); return;
    }
    let received = false;
    const waiting = read().then(value => { received = true; return value; });
    await new Promise(resolve => setTimeout(resolve, 30)); expect(received).toBe(false);
    if (mode === "callback lost") {
      expect(await waiting).toEqual({ ok: false, error: "ASYNC_TIMEOUT" });
      expect((await closed)[0], stderr).toBe(1); expect((await submit(request)).isError).toBe(true); return;
    }
    if (mode === "FIX loop" || mode === "reconfigured options") {
      expect((await submit(request, fix)).structuredContent).toEqual({ accepted: true });
      expect(await waiting).toMatchObject({ ok: true, value: { status: "FIX", canContinue: true } });
      if (mode === "reconfigured options") {
        child.stdin.write(JSON.stringify(command) + "\n");
        expect(await read()).toEqual({ ok: false, error: "ASYNC_OPTIONS_ALREADY_SET" });
        expect((await closed)[0], stderr).toBe(1); return;
      }
      child.stdin.write(JSON.stringify({ operation: "verifySourceForFix" }) + "\n");
      expect(await read()).toEqual({ ok: true, value: { canAutoFix: true } });
      expect((await submit(request)).isError).toBe(true);
      write(root, "src/index.ts", "scoped fix\n");
      child.stdin.write(JSON.stringify({ operation: "prepare", handoff }) + "\n");
      const second = await read();
      expect(second.ok).toBe(true);
      expect(second.value.ticket.attemptId).not.toBe(request.ticket.attemptId);
      expect((await submit(second.value)).structuredContent).toEqual({ accepted: true });
    } else expect((await submit(request)).structuredContent).toEqual({ accepted: true });
    expect(mode === "FIX loop" ? await read() : await waiting).toMatchObject({ ok: true, value: { status: "PASS", canContinue: false } });
    expect((await closed)[0], stderr).toBe(0);
  } finally { child.kill(); await closed; }
});
