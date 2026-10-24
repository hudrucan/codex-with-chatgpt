import { fixtureHub, fixtureAuthFile } from "../helpers.js";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import path from "node:path";
import fs from "node:fs";
import { AuthStore, MAX_OAUTH_CLIENTS, filterScopes } from "../../src/auth/store.js";
import { MAX_PENDING_AUTH_REQUESTS, PENDING_AUTH_TTL_MS } from "../../src/auth/oauth.js";
import { renameHub } from "../../src/hub/store.js";
import { startBridge, type Bridge } from "../../src/bridge/server.js";
import { makeTmpDir, cleanup, write, isolateStateDir, pkceVerifierAndChallenge } from "../helpers.js";

let root: string;
let bridge: Bridge;
let base: string;

const REDIRECT_URI = "http://127.0.0.1:19999/callback";

beforeAll(async () => {
  isolateStateDir();
  root = makeTmpDir("oauth-ws");
  write(root, "hello.txt", "hello oauth\n");
  bridge = await startBridge({
    hubId: fixtureHub(root).hubId,
    port: 0,
    persistRuntime: false,
    authStoreFile: fixtureAuthFile(fixtureHub(root).hubId, path.join(makeTmpDir("auth"), "store.json")),
  });
  base = bridge.localBaseUrl();
});

afterAll(async () => {
  await bridge.close();
  cleanup(root);
});

async function registerClient(): Promise<string> {
  const response = await fetch(`${base}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "ChatGPT-Test", redirect_uris: [REDIRECT_URI] }),
  });
  expect(response.status).toBe(201);
  const body = (await response.json()) as { client_id: string };
  return body.client_id;
}

async function authorizeWithPairing(
  clientId: string,
  challenge: string,
  pairingCode: string,
  state = "st-123",
  scope = "workspace.read workspace.search git.read offline_access"
): Promise<{ code: string | null; location: string | null; page?: string; status?: number }> {
  const authorizeUrl = new URL(`${base}/oauth/authorize`);
  authorizeUrl.searchParams.set("client_id", clientId);
  authorizeUrl.searchParams.set("redirect_uri", REDIRECT_URI);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set("code_challenge", challenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");
  authorizeUrl.searchParams.set("scope", scope);

  const pageResponse = await fetch(authorizeUrl, { redirect: "manual" });
  const html = await pageResponse.text();
  const requestId = html.match(/name="request_id" value="([a-f0-9]+)"/)?.[1];
  if (!requestId) return { code: null, location: null, page: html, status: pageResponse.status };

  const postResponse = await fetch(`${base}/oauth/authorize`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ request_id: requestId, pairing_code: pairingCode }),
    redirect: "manual",
  });
  if (postResponse.status !== 302) {
    return { code: null, location: null, page: await postResponse.text(), status: postResponse.status };
  }
  const location = postResponse.headers.get("location");
  const code = location ? new URL(location).searchParams.get("code") : null;
  return { code, location, status: postResponse.status };
}

async function exchangeToken(
  clientId: string,
  code: string,
  verifier: string
): Promise<{ status: number; body: Record<string, string> }> {
  const response = await fetch(`${base}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
    }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, string> };
}

describe("discovery metadata", () => {
  it("serves protected resource metadata", async () => {
    const response = await fetch(`${base}/.well-known/oauth-protected-resource/mcp`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { resource: string; authorization_servers: string[] };
    expect(body.resource).toContain("/mcp");
    expect(body.authorization_servers.length).toBe(1);
  });

  it("serves authorization server metadata with PKCE S256", async () => {
    const response = await fetch(`${base}/.well-known/oauth-authorization-server`);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.code_challenge_methods_supported).toEqual(["S256"]);
    expect(body.grant_types_supported).toEqual(["authorization_code", "refresh_token"]);
    expect(body.registration_endpoint).toContain("/oauth/register");
  });
});

describe("authorization + token flow", () => {
  it.each(["uncredentialed", "protected"])("bounds public client registration with %s slots without losing credentials", async kind => {
    const cappedRoot = makeTmpDir("oauth-client-cap"), hub = fixtureHub(cappedRoot);
    const store = new AuthStore(hub.hubId), original = store.registerClient({ redirectUris: [REDIRECT_URI] });
    const token = store.issueTokens({ clientId: original.clientId, scopes: ["workspace.read"] });
    const file = path.join(process.env.C2C_STATE_DIR!, "auth", `${hub.hubId}.json`);
    const state = JSON.parse(fs.readFileSync(file, "utf8"));
    state.clients = [original, ...Array.from({ length: MAX_OAUTH_CLIENTS - 1 }, (_, index) => ({ ...original,
      clientId: `seeded-${index}`, createdAt: "2000-01-01T00:00:00.000Z" }))];
    if (kind === "protected") {
      state.tokens = [state.tokens[0], ...state.clients.slice(1).map((client: { clientId: string }, index: number) => ({
        ...state.tokens[0], clientId: client.clientId, hash: (index + 1).toString(16).padStart(64, "0"),
      }))];
    }
    fs.writeFileSync(file, JSON.stringify(state));
    const cappedBridge = await startBridge({ hubId: hub.hubId, port: 0, persistRuntime: false });
    try {
      const register = () => fetch(`${cappedBridge.localBaseUrl()}/oauth/register`, { method: "POST",
        headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: [REDIRECT_URI] }) });
      const before = fs.readFileSync(file);
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await register();
        if (kind === "protected") {
          expect(response.status).toBe(503);
          expect(await response.json()).toMatchObject({ error: "temporarily_unavailable" });
          expect(fs.readFileSync(file)).toEqual(before);
          for (const client of state.clients) expect(cappedBridge.authStore.getClient(client.clientId)).toEqual(client);
        } else {
          expect(response.status).toBe(201);
          const added = await response.json() as { client_id: string };
          expect(cappedBridge.authStore.getClient(added.client_id)).toBeDefined();
          expect(JSON.parse(fs.readFileSync(file, "utf8")).clients).toHaveLength(MAX_OAUTH_CLIENTS);
        }
      }
      const reloaded = new AuthStore(hub.hubId);
      expect(reloaded.getClient(original.clientId)).toEqual(original);
      expect(reloaded.verifyAccessToken(token.accessToken).ok).toBe(true);
      if (kind === "protected") {
        expect(() => reloaded.registerClient({ redirectUris: [REDIRECT_URI] })).toThrow("registration limit");
        expect(fs.readFileSync(file)).toEqual(before);
      }
    } finally { await cappedBridge.close(); cleanup(cappedRoot); }
  });

  it("caps pending requests without evicting active approvals and reclaims consumed or expired slots", async () => {
    const clientId = await registerClient(), { challenge } = pkceVerifierAndChallenge();
    const now = Date.now() + PENDING_AUTH_TTL_MS;
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      const url = new URL(`${base}/oauth/authorize`);
      for (const [key, value] of Object.entries({ client_id: clientId, redirect_uri: REDIRECT_URI,
        response_type: "code", code_challenge: challenge, code_challenge_method: "S256" })) url.searchParams.set(key, value);
      const requests: string[] = [];
      for (let index = 0; index < MAX_PENDING_AUTH_REQUESTS; index++) {
        const response = await fetch(url); expect(response.status).toBe(200);
        requests.push((await response.text()).match(/name="request_id" value="([a-f0-9]+)"/)![1]);
      }
      const full = await fetch(url); expect(full.status).toBe(429);
      expect(full.headers.get("retry-after")).toBe(String(PENDING_AUTH_TTL_MS / 1000));
      expect(await full.json()).toMatchObject({ error: "temporarily_unavailable" });
      const pairing = bridge.pairing.create();
      const approve = (requestId: string) => fetch(`${base}/oauth/authorize`, { method: "POST", redirect: "manual",
        headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ request_id: requestId, pairing_code: pairing.code }) });
      const approved = await approve(requests[0]); expect(approved.status).toBe(302);
      expect(approved.headers.get("location")).toContain("code=");
      expect((await fetch(url)).status).toBe(200);
      clock.mockReturnValue(now + PENDING_AUTH_TTL_MS);
      expect((await approve(requests[1])).status).toBe(400);
      expect((await fetch(url)).status).toBe(200);
    } finally { clock.mockRestore(); }
  });

  it("completes the full pairing + PKCE flow and calls MCP", async () => {
    const clientId = await registerClient();
    const { verifier, challenge } = pkceVerifierAndChallenge();
    const pairing = bridge.pairing.create();
    const { code, location } = await authorizeWithPairing(clientId, challenge, pairing.code);
    expect(code).toBeTruthy();
    expect(location).toContain("state=st-123");

    const token = await exchangeToken(clientId, code!, verifier);
    expect(token.status).toBe(200);
    expect(token.body.access_token).toMatch(/^c2c_at_/);
    expect(token.body.refresh_token).toMatch(/^c2c_rt_/);
    expect(token.body.token_type).toBe("Bearer");

    // authorized MCP request
    const mcpResponse = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token.body.access_token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      }),
    });
    expect(mcpResponse.status).toBe(200);
  });

  it("rejects a wrong pairing code", async () => {
    const clientId = await registerClient();
    const { challenge } = pkceVerifierAndChallenge();
    bridge.pairing.create();
    const result = await authorizeWithPairing(clientId, challenge, "AAAA-AAAA");
    expect(result.code).toBeNull();
    expect(result.status).toBe(401);
    expect(result.page).toContain("Incorrect pairing code");
  });

  it("escapes the Hub display name in the pairing page", async () => {
    const xssWorkspaceRoot = makeTmpDir("oauth-html");
    renameHub(fixtureHub(xssWorkspaceRoot).hubId, "<script>alert('xss')</script>");
    const xssBridge = await startBridge({
      hubId: fixtureHub(xssWorkspaceRoot).hubId,
      port: 0,
      persistRuntime: false,
      authStoreFile: fixtureAuthFile(fixtureHub(xssWorkspaceRoot).hubId, path.join(makeTmpDir("auth-html"), "store.json")),
    });

    try {
      const xssBase = xssBridge.localBaseUrl();
      const registration = await fetch(`${xssBase}/oauth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_name: "HTML-Test", redirect_uris: [REDIRECT_URI] }),
      });
      expect(registration.status).toBe(201);
      const client = (await registration.json()) as { client_id: string };
      const { challenge } = pkceVerifierAndChallenge();

      const authorizeUrl = new URL(`${xssBase}/oauth/authorize`);
      authorizeUrl.searchParams.set("client_id", client.client_id);
      authorizeUrl.searchParams.set("redirect_uri", REDIRECT_URI);
      authorizeUrl.searchParams.set("response_type", "code");
      authorizeUrl.searchParams.set("code_challenge", challenge);
      authorizeUrl.searchParams.set("code_challenge_method", "S256");

      const response = await fetch(authorizeUrl, { redirect: "manual" });
      expect(response.status).toBe(200);
      const html = await response.text();

      expect(html).not.toContain("<script>alert('xss')</script>");
      expect(html).toContain("&lt;script&gt;alert(&#39;xss&#39;)&lt;/script&gt;");
    } finally {
      await xssBridge.close();
      cleanup(xssWorkspaceRoot);
    }
  });

  it("sets browser security headers on the pairing page", async () => {
    const clientId = await registerClient();
    const { challenge } = pkceVerifierAndChallenge();
    const authorizeUrl = new URL(`${base}/oauth/authorize`);
    authorizeUrl.searchParams.set("client_id", clientId);
    authorizeUrl.searchParams.set("redirect_uri", REDIRECT_URI);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("code_challenge", challenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");

    const response = await fetch(authorizeUrl, { redirect: "manual" });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https:; base-uri 'none'; frame-ancestors 'none'"
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("cache-control")).toBe("no-store, max-age=0");
  });

  it("rejects PKCE verifier mismatch", async () => {
    const clientId = await registerClient();
    const { challenge } = pkceVerifierAndChallenge();
    const pairing = bridge.pairing.create();
    const { code } = await authorizeWithPairing(clientId, challenge, pairing.code);
    const token = await exchangeToken(clientId, code!, "wrong-verifier-wrong-verifier-wrong");
    expect(token.status).toBe(400);
    expect(token.body.error).toBe("invalid_grant");
  });

  it("authorization codes are one-time", async () => {
    const clientId = await registerClient();
    const { verifier, challenge } = pkceVerifierAndChallenge();
    const pairing = bridge.pairing.create();
    const { code } = await authorizeWithPairing(clientId, challenge, pairing.code);
    const first = await exchangeToken(clientId, code!, verifier);
    expect(first.status).toBe(200);
    const second = await exchangeToken(clientId, code!, verifier);
    expect(second.status).toBe(400);
  });

  it("requires PKCE at the authorization endpoint", async () => {
    const clientId = await registerClient();
    const authorizeUrl = new URL(`${base}/oauth/authorize`);
    authorizeUrl.searchParams.set("client_id", clientId);
    authorizeUrl.searchParams.set("redirect_uri", REDIRECT_URI);
    authorizeUrl.searchParams.set("response_type", "code");
    const response = await fetch(authorizeUrl, { redirect: "manual" });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain("error=invalid_request");
  });

  it("rejects registration with non-https redirect uris", async () => {
    const response = await fetch(`${base}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["http://evil.example.com/cb"] }),
    });
    expect(response.status).toBe(400);
  });
});

describe("token enforcement on /mcp", () => {
  const mcpCall = (token?: string): Promise<Response> =>
    fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });

  it("401 without a token, with resource metadata pointer", async () => {
    const response = await mcpCall();
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("resource_metadata");
  });

  it("401 with an invalid token", async () => {
    const response = await mcpCall("c2c_at_totally-invalid");
    expect(response.status).toBe(401);
  });

  it.each(["missing", "invalid"])("authenticates a %s bearer before parsing malformed or oversized MCP bodies", async kind => {
    for (const body of ["{", JSON.stringify("x".repeat(8 * 1024 * 1024 + 1))]) {
      const response = await fetch(`${base}/mcp`, { method: "POST", headers: {
        "content-type": "application/json", ...(kind === "invalid" ? { authorization: "Bearer invalid" } : {}),
      }, body });
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toContain("resource_metadata");
      expect(await response.json()).toMatchObject({ error: "unauthorized" });
    }
  });

  it("still parses and limits JSON bodies after successful bearer authentication", async () => {
    const token = bridge.authStore.issueTokens({ clientId: "test", scopes: ["workspace.read"] });
    for (const [body, status] of [["{", 400], [JSON.stringify("x".repeat(8 * 1024 * 1024 + 1)), 413]] as const) {
      const response = await fetch(`${base}/mcp`, { method: "POST", headers: {
        "content-type": "application/json", authorization: `Bearer ${token.accessToken}`,
      }, body });
      expect(response.status).toBe(status);
      await response.text();
    }
  });

  it("401 with an expired token", async () => {
    const expired = bridge.authStore.issueTokens({
      clientId: "test",
      scopes: ["workspace.read"],
      accessTtlMs: -1000,
    });
    const response = await mcpCall(expired.accessToken);
    expect(response.status).toBe(401);
  });

  it("403 if bearer validation receives a record bound to another Hub", async () => {
    const foreign = bridge.authStore.issueTokens({ clientId: "test", scopes: ["workspace.read"] });
    const verdict = bridge.authStore.verifyAccessToken(foreign.accessToken);
    if (!verdict.ok) throw new Error("Missing token fixture");
    const verify = vi.spyOn(bridge.authStore, "verifyAccessToken").mockReturnValue({
      ok: true, record: { ...verdict.record, hubId: "hub-550e8400-e29b-41d4-a716-446655440000" },
    });
    try { expect((await mcpCall(foreign.accessToken)).status).toBe(403); }
    finally { verify.mockRestore(); }
  });

  it("401 after revocation", async () => {
    const tokens = bridge.authStore.issueTokens({ clientId: "test", scopes: ["workspace.read"] });
    expect((await mcpCall(tokens.accessToken)).status).toBe(200);
    bridge.authStore.revokeToken(tokens.accessToken);
    expect((await mcpCall(tokens.accessToken)).status).toBe(401);
  });
});

describe("refresh token rotation", () => {
  it("rotates refresh tokens and invalidates the old one", async () => {
    const clientId = await registerClient();
    const { verifier, challenge } = pkceVerifierAndChallenge();
    const pairing = bridge.pairing.create();
    const { code } = await authorizeWithPairing(clientId, challenge, pairing.code);
    const initial = await exchangeToken(clientId, code!, verifier);

    const refresh = async (refreshToken: string): Promise<{ status: number; body: Record<string, string> }> => {
      const response = await fetch(`${base}/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId }),
      });
      return { status: response.status, body: (await response.json()) as Record<string, string> };
    };

    const rotated = await refresh(initial.body.refresh_token);
    expect(rotated.status).toBe(200);
    expect(rotated.body.refresh_token).not.toBe(initial.body.refresh_token);

    const replayed = await refresh(initial.body.refresh_token);
    expect(replayed.status).toBe(400);
  });
});


describe("bridge-only OAuth scopes", () => {
  it("shows the state-changing audit permission in the local OAuth consent page", async () => {
    const clientId = await registerClient();
    const { challenge } = pkceVerifierAndChallenge();
    const authorize = new URL(`${base}/oauth/authorize`);
    authorize.search = new URLSearchParams({ client_id: clientId, redirect_uri: REDIRECT_URI, response_type: "code",
      code_challenge: challenge, code_challenge_method: "S256", scope: "audit.submit" }).toString();
    const response = await fetch(authorize, { redirect: "manual" });
    expect(response.status).toBe(200);
    const page = await response.text();
    expect(page).toContain("Submit terminal C2C audit results to pending in-memory inboxes");
    expect(page).toContain("audit submissions change the in-memory inbox");
  });

  it("does not broaden unsupported scope requests", () => {
    expect(filterScopes("unsupported.read")).toEqual([]);
    expect(filterScopes("unknown.scope")).toEqual([]);
    expect(filterScopes("unsupported.read workspace.read")).toEqual(["workspace.read"]);
    expect(filterScopes("audit.submit")).toEqual(["audit.submit"]);
    expect(filterScopes(undefined)).toEqual(["workspace.read", "workspace.search", "git.read", "offline_access"]);
  });

  it("does not grant core access to an unsupported-only OAuth authorization", async () => {
    const clientId = await registerClient();
    const { verifier, challenge } = pkceVerifierAndChallenge();
    const pairing = bridge.pairing.create();
    const authorization = await authorizeWithPairing(clientId, challenge, pairing.code, "unsupported-scope", "unsupported.read");
    expect(authorization.status).toBe(302);
    const token = await exchangeToken(clientId, authorization.code!, verifier);
    expect(token.status).toBe(200);
    expect(token.body.scope).toBe("");
    const verified = bridge.authStore.verifyAccessToken(token.body.access_token);
    expect(verified.ok).toBe(true);
    if (verified.ok) expect(verified.record.scopes).toEqual([]);
  });

  it("advertises only supported bridge scopes", async () => {
    const metadata = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
    expect(metadata.scopes_supported).toEqual(["workspace.read", "workspace.search", "git.read", "audit.submit", "offline_access"]);
    const resource = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json();
    expect(resource.resource_name).toBe("Codex with ChatGPT");
    expect(resource.scopes_supported).toEqual(metadata.scopes_supported);
  });
});
