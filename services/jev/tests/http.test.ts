import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/http.js";
import { sampleInput, verify } from "../src/verify.js";
import { fixture, response } from "./fixtures.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const f of cleanup.splice(0)) await f(); });

async function serverFixture() {
  const f = fixture();
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const config = { ...f.config, port: (server.address() as { port: number }).port };
  const inference = vi.fn<typeof fetch>(async () => Response.json(response()));
  server.on("request", createApp(config, f.directory, f.credentials.approvalSecret, "test-typesafe-api-key", inference));
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); f.cleanup(); });
  const local = `http://127.0.0.1:${config.port}`;
  const request = (route: string, init: RequestInit = {}, publicHost = false) => new Promise<Response>((resolve, reject) => {
    const req = http.request(`${local}${route}`, { method: init.method ?? "GET", headers: { ...init.headers as Record<string, string>, ...(publicHost ? { Host: "jev.example.com" } : {}) } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers: res.headers as Record<string, string> })));
    });
    req.once("error", reject);
    req.end(init.body?.toString());
  });
  async function authorize(publicHost = false) {
    const origin = publicHost ? config.publicUrl : local;
    const registered = await request("/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
      client_name: "Test", redirect_uris: ["http://127.0.0.1:1/callback"], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"],
    }) }, publicHost);
    const client = await registered.json();
    expect(registered.status).toBe(201);
    const verifier = randomBytes(32).toString("base64url");
    const params = { client_id: client.client_id as string, redirect_uri: "http://127.0.0.1:1/callback", response_type: "code", code_challenge_method: "S256",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"), scope: "jev.evaluate", resource: `${origin}/mcp`, state: "preserve-this-state" };
    const page = await request(`/authorize?${new URLSearchParams(params)}`, {}, publicHost);
    expect(page.headers.get("referrer-policy")).toBe("same-origin");
    expect(page.headers.get("content-security-policy")).toContain("form-action 'self' http://127.0.0.1:1;");
    const nonce = (await page.text()).match(/name="request" value="([a-f0-9]{64})"/)![1];
    const approve = (secret: string, originHeader = origin) => request("/approve", { method: "POST", headers: { Origin: originHeader, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ request: nonce, secret }) }, publicHost);
    expect((await approve("bad-secret")).status).toBe(403);
    expect((await approve(f.credentials.approvalSecret, publicHost ? local : config.publicUrl)).status).toBe(400);
    const approved = await approve(f.credentials.approvalSecret);
    expect(approved.status).toBe(302);
    const callback = new URL(approved.headers.get("location")!);
    expect(callback.searchParams.get("state")).toBe("preserve-this-state");
    const tokenBody = { grant_type: "authorization_code", client_id: client.client_id, redirect_uri: params.redirect_uri, resource: params.resource, code: callback.searchParams.get("code")!, code_verifier: verifier };
    const exchange = (body = tokenBody) => request("/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body) }, publicHost);
    const exchanged = await exchange();
    expect(exchanged.status).toBe(200);
    expect((await exchange()).status).toBe(400);
    return { token: (await exchanged.json()).access_token as string, client, params };
  }
  return { ...f, config, inference, local, request, authorize };
}

describe("Independent authenticated Streamable HTTP", () => {
  it("verifies discovery, initialize, exactly one tool, all primitives, PKCE, refresh and revocation", async () => {
    const f = await serverFixture();
    const result = await verify(f.directory, f.local, f.credentials.approvalSecret, true);
    expect(result).toMatchObject({ authentication: "passed", initialize: "passed", tools: ["evaluate"], inference: { ...response(), advisoryOnly: true } });
    expect(f.inference).toHaveBeenCalledTimes(1);
  });

  it("rejects unauthenticated paid calls, C2C tokens, wrong hosts/origins and proxied admin requests", async () => {
    const f = await serverFixture();
    for (const authorization of ["", "Bearer c2c_at_a_different_permission_domain"]) {
      const response = await f.request("/mcp", { method: "POST", headers: { authorization, "Content-Type": "application/json" }, body: JSON.stringify({ method: "tools/call", params: { name: "evaluate", arguments: sampleInput } }) });
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toContain("oauth-protected-resource/mcp");
    }
    expect((await f.request("/health", { headers: { Host: "attacker.example" } })).status).toBe(403);
    expect((await f.request("/health", { headers: { Origin: "https://attacker.example" } })).status).toBe(403);
    expect((await f.request("/health", { headers: { Origin: "null" } })).status).toBe(403);
    expect((await f.request("/admin/info", { headers: { Authorization: `Bearer ${f.credentials.approvalSecret}`, "cf-connecting-ip": "1.2.3.4" } })).status).toBe(403);
    expect((await f.request("/admin/info", { headers: { Authorization: `Bearer ${f.credentials.approvalSecret}` } }, true)).status).toBe(403);
    expect(f.inference).not.toHaveBeenCalled();
  });

  it("keeps local and public token audiences separate, enforces bounded input and never persists raw tokens", async () => {
    const f = await serverFixture();
    const local = await f.authorize();
    const publicGrant = await f.authorize(true);
    const headers = { Authorization: `Bearer ${local.token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
    expect((await f.request("/mcp", { method: "POST", headers, body: "{}" }, true)).status).toBe(401);
    expect((await f.request("/mcp", { method: "POST", headers: { ...headers, Authorization: `Bearer ${publicGrant.token}` }, body: "{}" })).status).toBe(401);
    expect((await f.request("/mcp", { method: "GET", headers })).status).toBe(405);
    expect((await f.request("/mcp", { method: "POST", headers, body: "{" })).status).toBe(400);
    expect((await f.request("/mcp", { method: "POST", headers, body: JSON.stringify({ method: "tools/call", params: { name: "evaluate", arguments: { ...sampleInput, state: "x".repeat(17000) } } }) })).status).toBe(413);
    expect(fs.readFileSync(path.join(f.directory, "oauth.json"), "utf8")).not.toContain(local.token);
    expect(f.inference).not.toHaveBeenCalled();
  });
});
