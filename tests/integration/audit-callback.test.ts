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
import { SUPPORTED_SCOPES } from "../../src/auth/store.js";
import { fixtureHub, cleanup, isolateStateDir, makeTmpDir, pkceVerifierAndChallenge } from "../helpers.js";

let state: string, root: string, bridge: Bridge, client: Client, workspaceId: string;
const result = { status: "PASS", complete: true, summary: "Local MCP callback verified", findings: [] };
beforeEach(async () => {
  state = isolateStateDir(); root = makeTmpDir("audit-callback");
  fs.writeFileSync(path.join(root, "hello.txt"), "hello callback\n");
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
  const token = bridge.authStore.issueTokens({ clientId: "metadata-test", scopes: ["workspace.read"] }).accessToken;
  // Inspect the wire descriptor; SDK response parsing can strip extension fields.
  const listed = await fetch(`${bridge.localBaseUrl()}/mcp`, { method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json",
      accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) });
  expect(listed.status).toBe(200);
  const { result: { tools } } = await listed.json() as { result: { tools: Array<{
    name: string; annotations?: unknown; securitySchemes?: unknown; _meta?: { securitySchemes?: unknown };
  }> } };
  expect(tools).toHaveLength(11);
  expect(tools.find(t => t.name === "submit_audit_result")?.annotations).toMatchObject({
    readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false,
  });
  expect(tools.find(t => t.name === "submit_audit_result")?._meta?.securitySchemes).toEqual([
    { type: "oauth2", scopes: ["audit.submit"] },
  ]);
  expect(tools.find(t => t.name === "submit_audit_result")?.securitySchemes).toEqual([
    { type: "oauth2", scopes: ["audit.submit"] },
  ]);
  const ticket = await register();
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

it.each([{ scopes: [] }, { scopes: ["workspace.read", "offline_access"] }])("denies existing restricted grants before and after refresh without consuming the attempt ($scopes)", async ({ scopes }) => {
  const ticket = await register();
  const clientId = "restricted-test", base = bridge.localBaseUrl();
  const original = bridge.authStore.issueTokens({ clientId, scopes });
  const refreshed = await fetch(`${base}/oauth/token`, { method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", client_id: clientId,
      refresh_token: original.refreshToken!, scope: SUPPORTED_SCOPES.join(" ") }) });
  // Empty grants have no refresh token; tokens with offline_access must retain their grant.
  expect(refreshed.status).toBe(scopes.includes("offline_access") ? 200 : 400);
  const rotated = await refreshed.json() as { access_token?: string; scope?: string };
  if (rotated.access_token) expect(rotated.scope).toBe(scopes.join(" "));
  for (const token of [original.accessToken, ...(rotated.access_token ? [rotated.access_token] : [])]) {
    expect(bridge.authStore.verifyAccessToken(token)).toMatchObject({ ok: true, record: { scopes } });
    const response = await fetch(`${base}/mcp`, { method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json",
        accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { name: "submit_audit_result", arguments: { ...ticket, result } } }) });
    expect(response.status).toBe(200);
    expect(response.headers.get("www-authenticate")).toBeNull();
    const denied = (await response.json()).result;
    expect(denied.isError).toBe(true);
    expect(JSON.stringify(denied)).toContain("INSUFFICIENT_SCOPE");
    expect(denied._meta?.["mcp/www_authenticate"]).toBeUndefined();
  }
  const unauthenticated = await fetch(`${base}/mcp`, { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1,
      method: "tools/call", params: { name: "submit_audit_result", arguments: { ...ticket, result } } }) });
  expect(unauthenticated.status).toBe(401);
  expect((await submit(ticket)).structuredContent).toEqual({ accepted: true });
  expect(await callbackLocal("wait", ticket)).toEqual(result);
});

it.each([
  { request: "omitted", scope: undefined },
  { request: "four scopes", scope: "workspace.read workspace.search git.read offline_access" },
  { request: "five scopes", scope: SUPPORTED_SCOPES.join(" ") },
])("grants visible five-scope consent for $request through issuance, refresh, reads and callbacks", async ({ scope }) => {
  const base = bridge.localBaseUrl(), redirectUri = "http://127.0.0.1:19999/callback";
  const metadata = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json();
  expect(metadata.scopes_supported).toContain("audit.submit");
  const registration = await fetch(`${base}/oauth/register`, { method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "oauth-callback-test", redirect_uris: [redirectUri] }) });
  expect(registration.status).toBe(201);
  const { client_id: clientId } = await registration.json() as { client_id: string };
  const { verifier, challenge } = pkceVerifierAndChallenge();
  const tokensBeforeConsent = bridge.authStore.tokenCount();
  const scopes = [...SUPPORTED_SCOPES];
  const authorize = new URL(`${base}/oauth/authorize`);
  authorize.search = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri,
    response_type: "code", code_challenge: challenge, code_challenge_method: "S256",
    ...(scope === undefined ? {} : { scope }) }).toString();
  const page = await fetch(authorize, { redirect: "manual" });
  expect(page.status).toBe(200);
  const html = await page.text();
  for (const label of ["Read files in this workspace", "Search this workspace", "Read git status and diffs",
    "Submit terminal C2C audit results to pending in-memory inboxes", "Stay connected between sessions"])
    expect(html).toContain(label);
  expect(html).toContain("audit submissions change the in-memory inbox");
  expect(bridge.authStore.tokenCount()).toBe(tokensBeforeConsent);
  const requestId = html.match(/name="request_id" value="([a-f0-9]+)"/)?.[1];
  expect(requestId).toBeDefined();
  const approved = await fetch(`${base}/oauth/authorize`, { method: "POST", redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ request_id: requestId!, pairing_code: bridge.pairing.create().code }) });
  expect(approved.status).toBe(302);
  const code = new URL(approved.headers.get("location")!).searchParams.get("code")!;
  const issued = await fetch(`${base}/oauth/token`, { method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", client_id: clientId,
      redirect_uri: redirectUri, code, code_verifier: verifier }) });
  expect(issued.status).toBe(200);
  const initial = await issued.json() as { access_token: string; refresh_token: string; scope: string };
  const refresh = await fetch(`${base}/oauth/token`, { method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", client_id: clientId,
      refresh_token: initial.refresh_token }) });
  expect(refresh.status).toBe(200);
  const rotated = await refresh.json() as typeof initial;
  for (const token of [initial, rotated]) {
    expect(token.scope.split(" ")).toEqual(scopes);
    const caller = new Client({ name: "oauth-callback-test", version: "1" });
    await caller.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token.access_token}` } },
    }));
    try {
      for (const name of ["workspace_info", "read_file", "search_workspace", "git_status"]) {
        const read = await caller.callTool({ name, arguments: { workspace: workspaceId,
          ...(name === "read_file" ? { path: "hello.txt" } : {}),
          ...(name === "search_workspace" ? { query: "hello" } : {}) } });
        // The fixture is not a Git repo, so git_status returns its supported empty overview.
        expect(read.isError).not.toBe(true);
      }
      const ticket = await register();
      expect((await submit(ticket, result, caller)).structuredContent).toEqual({ accepted: true });
      expect(await callbackLocal("wait", ticket)).toEqual(result);
    } finally { await caller.close(); }
  }
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
