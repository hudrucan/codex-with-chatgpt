import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startBridge, type Bridge } from "../../src/bridge/server.js";
import { callbackLocal } from "../../src/c2c/callback-client.js";
import type { CallbackTicket } from "../../src/c2c/protocol.js";
import { WorkspaceRegistry } from "../../src/workspace/registry.js";
import { Logger } from "../../src/logger/index.js";
import { fixtureHub, cleanup, isolateStateDir, makeTmpDir } from "../helpers.js";

let state: string, root: string, bridge: Bridge, client: Client, workspaceId: string;
const result = { status: "PASS", complete: true, summary: "Local MCP callback verified", findings: [] };
beforeEach(async () => {
  state = isolateStateDir(); root = makeTmpDir("audit-callback");
  const hub = fixtureHub(root); workspaceId = new WorkspaceRegistry(hub.hubId).list()[0].workspaceId;
  bridge = await startBridge({ hubId: hub.hubId, port: 0,
    logger: new Logger({ file: path.join(state, "callback.log"), console: false, level: "debug" }) });
  client = await connect(["audit.submit"]);
});
afterEach(async () => {
  await client.close(); await bridge.close(); cleanup(state); cleanup(root); delete process.env.C2C_STATE_DIR;
});
async function connect(scopes: string[]) {
  const token = bridge.authStore.issueTokens({ clientId: "callback-test", scopes }).accessToken;
  const value = new Client({ name: "callback-test", version: "1" });
  await value.connect(new StreamableHTTPClientTransport(new URL(`${bridge.localBaseUrl()}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  }));
  return value;
}
function register(timeoutMs = 2000): Promise<CallbackTicket> {
  return callbackLocal("register", { hubId: bridge.hubId, workspaceId, taskId: "callback-task",
    attemptId: randomUUID(), handoffId: "a".repeat(64), timeoutMs }) as Promise<CallbackTicket>;
}
function submit(ticket: CallbackTicket, payload: unknown = result, caller = client) {
  return caller.callTool({ name: "submit_audit_result", arguments: { ...ticket, result: payload } });
}

it("registers an attempt, receives its OAuth MCP callback through one local event wait, and deduplicates exact results", async () => {
  const ticket = await register();
  const tools = (await client.listTools()).tools;
  expect(tools).toHaveLength(11);
  expect(tools.find(t => t.name === "submit_audit_result")?.annotations).toMatchObject({
    readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false,
  });
  let received = false;
  const waiting = callbackLocal("wait", ticket).then(value => { received = true; return value; });
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(received).toBe(false);
  expect((await submit(ticket)).isError).not.toBe(true);
  expect(await waiting).toEqual(result);
  expect((await submit(ticket)).isError).not.toBe(true);
  const conflict = await submit(ticket, { ...result, summary: "different result" });
  expect(conflict.isError).toBe(true);
  expect(JSON.stringify(conflict)).toContain("ASYNC_CALLBACK_CONFLICT");
  const logs = fs.readFileSync(path.join(state, "callback.log"), "utf8");
  expect(logs).not.toContain(ticket.capability);
  expect(logs).not.toContain(result.summary);
  expect(logs).not.toContain(bridge.adminToken);
});

it.each(["hubId", "workspaceId", "taskId", "attemptId", "handoffId", "capability"] as const)("rejects wrong %s without consuming the pending attempt", async field => {
  const ticket = await register();
  const other = { ...ticket, [field]: field === "hubId" ? `hub-${randomUUID()}` : field === "workspaceId" ? "f".repeat(12)
    : field === "attemptId" ? randomUUID() : field === "taskId" ? "wrong-task" : "f".repeat(64) };
  expect((await submit(other)).isError).toBe(true);
  expect((await submit(ticket)).isError).not.toBe(true);
  expect(await callbackLocal("wait", ticket)).toEqual(result);
});

it("requires OAuth and audit.submit without broadening a repository-read token", async () => {
  const ticket = await register(), reader = await connect(["workspace.read"]);
  try {
    expect((await submit(ticket, result, reader)).isError).toBe(true);
    const unauthenticated = await fetch(`${bridge.localBaseUrl()}/mcp`, { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1,
        method: "tools/call", params: { name: "submit_audit_result", arguments: { ...ticket, result } } }) });
    expect(unauthenticated.status).toBe(401);
    expect((await submit(ticket)).isError).not.toBe(true);
  } finally { await reader.close(); }
});

it("rejects callbacks after workspace grant removal and protects local endpoints from remote callers", async () => {
  const ticket = await register();
  new WorkspaceRegistry(bridge.hubId).remove(workspaceId);
  expect((await submit(ticket)).isError).toBe(true);
  for (const headers of [{}, { authorization: `Bearer ${bridge.adminToken}`, "x-forwarded-for": "203.0.113.1" }]) {
    const response = await fetch(`${bridge.localBaseUrl()}/admin/c2c/register`, { method: "POST", headers });
    expect(response.status).toBe(404);
  }
});

it.each(["schema", "size", "cancel"])("rejects %s and cannot accept a conflicting terminal", async kind => {
  const ticket = await register();
  if (kind === "cancel") {
    await callbackLocal("cancel", ticket);
    expect((await submit(ticket)).isError).toBe(true);
  } else {
    const invalid = kind === "schema" ? { ...result, complete: false } : { ...result, status: "FIX",
      findings: Array.from({ length: 10 }, () => ({ file: "src/file.ts", line: 1, evidence: "x".repeat(1000), fix: "x".repeat(1000) })) };
    expect((await submit(ticket, invalid)).isError).toBe(true);
    expect((await submit(ticket)).isError).not.toBe(true);
  }
});

it("expires the event wait at the original deadline and rejects late results", async () => {
  const ticket = await register(50);
  await expect(callbackLocal("wait", ticket)).rejects.toThrow("ASYNC_TIMEOUT");
  expect((await submit(ticket)).isError).toBe(true);
});

it("rejects an outstanding wait on shutdown and cannot restore capabilities after runtime restart", async () => {
  const ticket = await register();
  const waiting = callbackLocal("wait", ticket);
  const rejected = expect(waiting).rejects.toThrow("ASYNC_INBOX_CLOSED");
  await new Promise(resolve => setTimeout(resolve, 20));
  await bridge.close(); await rejected; await client.close();
  bridge = await startBridge({ hubId: bridge.hubId, port: 0 });
  client = await connect(["audit.submit"]);
  expect((await submit(ticket)).isError).toBe(true);
  await expect(callbackLocal("wait", ticket)).rejects.toThrow("ASYNC_ATTEMPT_UNAVAILABLE");
  // The inbox is never serialized alongside Hub runtime metadata.
  const persisted = fs.readFileSync(path.join(state, "runtime", `${bridge.hubId}.json`), "utf8");
  expect(persisted).not.toContain(ticket.capability);
  expect(persisted).not.toContain(ticket.attemptId);
});
