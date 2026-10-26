import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startBridge, type Bridge } from "../../src/bridge/server.js";
import { AuditSession } from "../../src/c2c/session.js";
import { WorkspaceRegistry } from "../../src/workspace/registry.js";
import { localAccess } from "../../src/c2c/local.js";
import { buildC2C } from "../../scripts/build-c2c.mjs";
import { fixtureHub, cleanup, isolateStateDir, makeTmpDir, makeGitRepo, write } from "../helpers.js";

let state: string, root: string, bridge: Bridge, client: Client, session: AuditSession;
const pass = { status: "PASS", complete: true, summary: "MCP audit complete", findings: [] };
const fix = { ...pass, status: "FIX", findings: [{ file: "src/index.ts", line: 1, evidence: "fixture", fix: "scoped edit" }] };
const handoff = "[C2C Handoff]\nRepo fixture, uncommitted validation.";
const options = () => ({ async: true, hubId: bridge.hubId, workspaceId: new WorkspaceRegistry(bridge.hubId).list()[0].workspaceId,
  workspaceRoot: root, taskId: "session-task", timeoutMs: 2000 });
function ticket(request: { message: string }) { return JSON.parse(request.message.split("\nC2C_CALLBACK ")[1].split("\n")[0]); }
const submit = (request: { message: string }, result = pass) => client.callTool({
  name: "submit_audit_result", arguments: { ...ticket(request), result },
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
  await session.close(); await client.close(); await bridge.close();
  cleanup(state); cleanup(root); delete process.env.C2C_STATE_DIR;
});

it("accepts only callback results, verifies source before fixes, and caps one claim at three audits/two fixes", async () => {
  await session.close(); session = new AuditSession({ ...options(), timeoutMs: 10_000 });
  for (let i = 0; i < 3; i++) {
    const request = await session.submit(handoff + i, i > 0);
    await expect(session.submit(handoff)).rejects.toThrow("ASYNC_AUDIT_LIMIT");
    const waiting = session.sent(request.attemptId);
    expect((await submit(request, fix)).isError).not.toBe(true);
    expect(await waiting).toMatchObject({ status: "FIX", canAutoFix: false, canContinue: i < 2 });
    if (i < 2) {
      expect(await session.verifySourceForFix()).toMatchObject({ canAutoFix: true });
      write(root, "src/index.ts", `export const answer = ${i};\n`);
    }
  }
  await expect(session.verifySourceForFix()).rejects.toThrow("ASYNC_FIX_NOT_AVAILABLE");
  await expect(session.submit(handoff, true)).rejects.toThrow("ASYNC_AUDIT_LIMIT");
  expect(() => localAccess.claimTask(options().taskId)).toThrow("ASYNC_RESUME_UNSUPPORTED");
});

it.each(["before send acknowledgement", "during wait", "before fix"])("fails closed on source drift %s", async phase => {
  const request = await session.submit(handoff);
  if (phase === "before send acknowledgement") {
    write(root, "src/index.ts", "drift");
    await expect(session.sent(request.attemptId)).rejects.toThrow("ASYNC_SOURCE_DRIFT");
  } else {
    const waiting = session.sent(request.attemptId);
    // Source is captured synchronously before waiting for the callback.
    if (phase === "during wait") write(root, "src/index.ts", "drift");
    expect((await submit(request, fix)).isError).not.toBe(true);
    if (phase === "during wait") await expect(waiting).rejects.toThrow("ASYNC_SOURCE_DRIFT");
    else {
      await waiting; write(root, "src/index.ts", "drift");
      await expect(session.verifySourceForFix()).rejects.toThrow("ASYNC_SOURCE_DRIFT");
    }
  }
  await expect(session.submit(handoff, true)).rejects.toThrow("ASYNC_AUDIT_LIMIT");
});

it.each(["restart", "grant removal"])("rejects automatic fixes after %s", async kind => {
  const request = await session.submit(handoff), waiting = session.sent(request.attemptId);
  await submit(request, fix); await waiting;
  if (kind === "restart") {
    await bridge.close(); await client.close();
    bridge = await startBridge({ hubId: bridge.hubId, port: 0 });
  } else new WorkspaceRegistry(bridge.hubId).remove(options().workspaceId);
  await expect(session.verifySourceForFix()).rejects.toThrow();
});

it("retains the original deadline across sending and rejects a late callback", async () => {
  await session.close();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  try {
    session = new AuditSession({ ...options(), timeoutMs: 100 });
    const request = await session.submit(handoff);
    await vi.advanceTimersByTimeAsync(120);
    await expect(session.sent(request.attemptId)).rejects.toThrow("ASYNC_TIMEOUT");
    expect((await submit(request)).isError).toBe(true);
  } finally { vi.useRealTimers(); }
});

it("accepts an OAuth callback after 180 seconds with the default 600-second sender, Hub and client budget", async () => {
  await session.close();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const transportTimeout = vi.spyOn(AbortSignal, "timeout");
  try {
    const { timeoutMs: _timeoutMs, ...defaults } = options();
    session = new AuditSession(defaults);
    expect(session.options.timeoutMs).toBe(600_000);
    const request = await session.submit(handoff);
    expect(request.remainingMs).toBe(600_000);
    const waiting = session.sent(request.attemptId);
    expect(transportTimeout).toHaveBeenCalledWith(602_000);
    await vi.advanceTimersByTimeAsync(181_000);
    expect((await submit(request)).structuredContent).toEqual({ accepted: true });
    expect(await waiting).toMatchObject({ status: "PASS", canContinue: false });
    expect((await submit(request)).structuredContent).toEqual({ accepted: true });
  } finally { transportTimeout.mockRestore(); vi.useRealTimers(); }
});

it("does not claim or offer a message when transport capability is unavailable", async () => {
  await bridge.close();
  await expect(session.submit(handoff)).rejects.toThrow("ASYNC_CALLBACK_RUNTIME_UNAVAILABLE");
  expect(fs.existsSync(path.join(state, "async-tasks"))).toBe(false);
});

it("fails closed on EPERM without claiming a task or offering a browser message", async () => {
  const transport = vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("fetch failed", { cause: { code: "EPERM" } }));
  try { await expect(session.submit(handoff)).rejects.toThrow("ASYNC_CALLBACK_TRANSPORT_UNAVAILABLE: EPERM"); }
  finally { transport.mockRestore(); }
  expect(fs.existsSync(path.join(state, "async-tasks"))).toBe(false);
});

it("stops after a callback transport failure without retrying the wait or releasing the task claim", async () => {
  const request = await session.submit(handoff);
  const transport = vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("private transport detail", { cause: { code: "EPERM" } }));
  try {
    const error = await session.sent(request.attemptId).catch(error => error);
    expect(error.message).toBe("ASYNC_CALLBACK_TRANSPORT_UNAVAILABLE: EPERM");
    expect(error.message).not.toContain(ticket(request).capability);
    expect(transport.mock.calls.filter(([url]) => String(url).endsWith("/wait"))).toHaveLength(1);
    await expect(session.submit(handoff)).rejects.toThrow("ASYNC_AUDIT_LIMIT");
    expect(() => localAccess.claimTask(options().taskId)).toThrow("ASYNC_RESUME_UNSUPPORTED");
    expect((await submit(request)).isError).toBe(true);
  } finally { transport.mockRestore(); }
});

const sizedHandoff = (pattern: string, bytes = 48 * 1024) =>
  handoff + pattern.repeat(bytes).slice(0, bytes - Buffer.byteLength(handoff));

it.each([
  ["callback", handoff, undefined],
  ["uncertain send", handoff, undefined],
  ["stdin closed", handoff, undefined],
  ["quoted/backslash handoff", sizedHandoff('"\\'), undefined],
  ["maximum JSON escaping", sizedHandoff("\u0000"), undefined],
  ["oversized handoff", sizedHandoff('"\\', 48 * 1024 + 1), "ASYNC_HANDOFF_REQUIRED"],
  ["oversized serialized input", sizedHandoff("\u0000", 50 * 1024), "ASYNC_LOCAL_REQUEST_INVALID"],
] as const)("runs a native terminal session with %s and no inbox polling", async (mode, content, expectedError) => {
  const out = path.join(state, "bundle"); await buildC2C(out);
  const child = spawn(process.execPath, [path.join(out, "local.mjs"), "async"], { env: process.env, stdio: ["pipe", "pipe", "pipe"] });
  const reader = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const closed = once(child, "close");
  let stderr = ""; child.stderr.on("data", value => { stderr += value; });
  const send = (value: unknown) => child.stdin.write(JSON.stringify(value) + "\n");
  const read = async () => JSON.parse((await reader.next()).value!);
  try {
    send({ ...options(), taskId: "native-terminal-session" });
    expect(await read()).toEqual({ ok: true, value: { status: "READY" } });
    const command = { operation: "submit", handoff: content };
    if (content !== handoff) expect(Buffer.byteLength(JSON.stringify(command))).toBeGreaterThan(64 * 1024);
    send(command);
    const response = await read();
    if (expectedError) {
      expect(response).toEqual({ ok: false, error: expectedError });
      expect((await closed)[0], stderr).toBe(1);
      expect(fs.existsSync(path.join(state, "async-tasks"))).toBe(false);
      return;
    }
    const request = response.value;
    expect(response.ok).toBe(true);
    expect(request.message.startsWith(content + "\n\nC2C_CALLBACK ")).toBe(true);
    expect(request.message).not.toContain(root);
    if (mode === "uncertain send" || mode === "stdin closed") {
      if (mode === "uncertain send") send({ operation: "abort" });
      else child.stdin.end();
      const error = await read();
      expect(error.ok).toBe(false);
      expect(error.error).toContain(mode === "uncertain send" ? "ASYNC_SEND_UNCERTAIN" : "ASYNC_INTERRUPTED");
      expect((await closed)[0], stderr).toBe(1);
      expect((await submit(request)).isError).toBe(true);
      expect(() => localAccess.claimTask("native-terminal-session")).toThrow("ASYNC_RESUME_UNSUPPORTED");
      return;
    }
    send({ operation: "sent", attemptId: request.attemptId });
    let received = false;
    const waiting = read().then(value => { received = true; return value; });
    await new Promise(resolve => setTimeout(resolve, 50)); expect(received).toBe(false);
    expect((await submit(request)).isError).not.toBe(true);
    expect(await waiting).toMatchObject({ ok: true, value: { status: "PASS", canContinue: false } });
    expect((await closed)[0], stderr).toBe(0);
  } finally { child.kill(); await closed; }
});
