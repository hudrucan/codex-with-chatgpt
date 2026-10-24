import path from "node:path";
import fs from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SCOPE } from "./auth.js";
import { JevError, readPrivate, writePrivate } from "./state.js";

export const sampleInput = {
  invocationReason: "Explicit connection smoke test using public synthetic data.",
  state: "An in-memory cache can reduce repeated database reads, but requires invalidation and uses memory.",
  questions: {
    helps_reads: { type: "noul", instructions: "Can this cache reduce repeated database reads?" },
    tradeoff: { type: "choice", instructions: "Which tradeoff is explicitly stated?", criteria: { memory: "Uses memory and requires invalidation", disk: "Requires more disk space" } },
    evidence: { type: "score", instructions: "How directly does the state describe a tradeoff?", criteria: ["No tradeoff described", "An explicit benefit and cost are described"] },
  },
};

export async function verify(directory: string, origin: string, approvalSecret: string, infer = false) {
  const request = (route: string, init?: RequestInit) => fetch(`${origin}${route}`, { ...init, redirect: "manual", signal: AbortSignal.timeout(20_000) });
  const rpcHeaders = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
  const unauthorizedBody = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "evaluate", arguments: sampleInput } });
  for (const auth of [undefined, "Bearer c2c_at_unrelated_identity", "Bearer jev_at_invalid"]) {
    const response = await request("/mcp", { method: "POST", headers: { ...rpcHeaders, ...(auth ? { Authorization: auth } : {}) }, body: unauthorizedBody });
    if (response.status !== 401) throw new JevError("Authentication probe failed; do not expose the tunnel.");
    await response.body?.cancel();
  }
  const discovery = await (await request("/.well-known/oauth-protected-resource/mcp")).json();
  if (discovery.resource !== `${origin}/mcp`) throw new JevError("OAuth resource discovery mismatch.");
  const clientFile = path.join(directory, origin.startsWith("http:") ? "probe-local.json" : "probe-public.json");
  const clientSchema = z.object({ client_id: z.string() });
  let clientId: string;
  if (fs.existsSync(clientFile)) clientId = readPrivate(clientFile, clientSchema).client_id;
  else {
    const registered = await request("/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
      client_name: "Jev connection verification", redirect_uris: ["http://127.0.0.1:1/callback"],
      token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], scope: SCOPE,
    }) });
    if (registered.status !== 201) throw new JevError("OAuth client registration failed.");
    clientId = clientSchema.parse(await registered.json()).client_id;
    writePrivate(clientFile, { client_id: clientId });
  }
  const verifier = randomBytes(32).toString("base64url");
  const state = randomBytes(16).toString("hex");
  const query = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: "http://127.0.0.1:1/callback",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", state, scope: SCOPE, resource: `${origin}/mcp` });
  const page = await request(`/authorize?${query}`);
  const id = (await page.text()).match(/name="request" value="([a-f0-9]{64})"/)?.[1];
  if (!id) throw new JevError("OAuth authorization page unavailable.");
  const approved = await request("/approve", { method: "POST", headers: { Origin: origin, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ request: id, secret: approvalSecret }) });
  const location = approved.headers.get("location");
  if (approved.status !== 302 || !location) throw new JevError("OAuth approval failed.");
  const callback = new URL(location);
  if (callback.searchParams.get("state") !== state) throw new JevError("OAuth state mismatch.");
  const tokenBody = { grant_type: "authorization_code", client_id: clientId, code: callback.searchParams.get("code")!, redirect_uri: "http://127.0.0.1:1/callback", resource: `${origin}/mcp` };
  const exchange = (body: Record<string, string>) => request("/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body) });
  if ((await exchange({ ...tokenBody, code_verifier: randomBytes(32).toString("base64url") })).status !== 400) {
    throw new JevError("PKCE rejection probe failed; do not expose the tunnel.");
  }
  const tokenResponse = await exchange({ ...tokenBody, code_verifier: verifier });
  if (!tokenResponse.ok) throw new JevError("OAuth code exchange failed.");
  let tokens = await tokenResponse.json() as { access_token: string; refresh_token: string };
  const refreshed = await exchange({ grant_type: "refresh_token", client_id: clientId, refresh_token: tokens.refresh_token, resource: `${origin}/mcp` });
  if (!refreshed.ok) throw new JevError("OAuth refresh failed.");
  const oldAccess = tokens.access_token;
  tokens = await refreshed.json() as typeof tokens;
  const old = await request("/mcp", { method: "POST", headers: { ...rpcHeaders, Authorization: `Bearer ${oldAccess}` }, body: unauthorizedBody });
  if (old.status !== 401) throw new JevError("Rotated access token remained valid.");
  const client = new Client({ name: "jev-verification", version: "1.0.0" });
  let result: unknown;
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${tokens.access_token}` } } }));
    const list = await client.listTools();
    if (list.tools.length !== 1 || list.tools[0].name !== "evaluate") throw new JevError("Unexpected MCP tools.");
    if (infer) {
      const evaluated = await client.callTool({ name: "evaluate", arguments: sampleInput });
      if (evaluated.isError || !evaluated.structuredContent) {
        const content = evaluated.content as Array<{ type: string; text?: string }>;
        throw new JevError(`Live evaluation failed: ${content.find((item) => item.type === "text")?.text ?? "No structured result."}`);
      }
      result = evaluated.structuredContent;
    }
  } finally {
    await client.close();
    await request("/revoke", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: clientId, token: tokens.refresh_token }) });
  }
  const revoked = await request("/mcp", { method: "POST", headers: { ...rpcHeaders, Authorization: `Bearer ${tokens.access_token}` }, body: unauthorizedBody });
  if (revoked.status !== 401) throw new JevError("Revocation probe failed; do not expose the tunnel.");
  return { origin, authentication: "passed", pkce: "passed", refreshAndRevocation: "passed", initialize: "passed", tools: ["evaluate"], inference: result ?? "not run" };
}
