import path from "node:path";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";
import { z } from "zod";
import type { OAuthServerProvider, AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import { InvalidClientMetadataError, InvalidGrantError, InvalidScopeError, InvalidTargetError, InvalidTokenError, InvalidRequestError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { OAuthClientInformationFullSchema, type OAuthClientInformationFull, type OAuthTokens, type OAuthTokenRevocationRequest } from "@modelcontextprotocol/sdk/shared/auth.js";
import { readPrivate, writePrivate } from "./state.js";

export const SCOPE = "jev.evaluate";
const tokenSchema = z.object({
  clientId: z.string(), accessHash: z.string(), refreshHash: z.string(), resource: z.string().url(),
  accessExpires: z.number(), refreshExpires: z.number(),
}).strict();
// OAuth SDK schemas use Zod 4; validate persisted clients separately below.
const authSchema = z.object({
  version: z.literal(1), service: z.literal("jev-mcp"),
  clients: z.array(z.unknown()).max(32), tokens: z.array(tokenSchema).max(64),
}).strict();
type Grant = AuthorizationParams & { clientId: string; expires: number; failures: number; origin: string };
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const secret = () => randomBytes(32).toString("hex");
const escape = (s: string) => s.replace(/[&<>"']/g, (v) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[v]!);
const now = () => Math.floor(Date.now() / 1000);

export class JevOAuth implements OAuthServerProvider {
  private readonly file: string;
  private readonly pending = new Map<string, Grant>();
  private readonly codes = new Map<string, Grant>();
  private approvalAttempts = 0;
  private approvalWindow = 0;
  readonly resource: URL;

  constructor(directory: string, private readonly publicUrl: string, private readonly approvalSecret: string, private readonly port: number) {
    this.file = path.join(directory, "oauth.json");
    this.resource = new URL(`${publicUrl}/mcp`);
    this.read();
  }

  private read() {
    const state = readPrivate(this.file, authSchema);
    const clients = state.clients.map((client) => OAuthClientInformationFullSchema.parse(client));
    if (new Set(clients.map((c) => c.client_id)).size !== clients.length) throw new InvalidRequestError("Conflicting OAuth state.");
    return { ...state, clients };
  }

  readonly clientsStore = {
    getClient: (id: string) => this.read().clients.find((c) => c.client_id === id),
    registerClient: (input: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">): OAuthClientInformationFull => {
      const state = this.read();
      if (state.clients.length >= 32 || input.redirect_uris.length === 0 || input.redirect_uris.length > 8
        || input.redirect_uris.some((uri) => {
          const u = new URL(uri);
          return uri.length > 2048 || !!u.hash || !!u.username || !!u.password
            || !(u.protocol === "https:" || (u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)));
        }) || (input.scope && input.scope !== SCOPE)) {
        throw new InvalidClientMetadataError("Unsupported client registration or registration limit reached.");
      }
      const client = OAuthClientInformationFullSchema.parse({ ...input, client_id: `jev_client_${secret()}`, client_id_issued_at: now(), scope: SCOPE });
      state.clients.push(client);
      writePrivate(this.file, state);
      return client;
    },
  };

  private target(resource?: URL): void {
    if (resource && ![this.resource.href, `http://127.0.0.1:${this.port}/mcp`].includes(resource.href)) throw new InvalidTargetError("Resource must be this Jev MCP endpoint.");
  }
  private scope(scopes?: string[]): void {
    if (scopes?.some((scope) => scope !== SCOPE)) throw new InvalidScopeError("Only jev.evaluate is supported.");
  }
  private prune(): void {
    for (const collection of [this.pending, this.codes]) {
      for (const [key, grant] of collection) if (grant.expires <= now()) collection.delete(key);
    }
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    this.scope(params.scopes);
    this.target(params.resource);
    this.prune();
    if (this.pending.size >= 32 || this.codes.size >= 32 || params.codeChallenge.length !== 43 || (params.state?.length ?? 0) > 2048) {
      throw new InvalidRequestError("Authorization limit exceeded or invalid PKCE challenge.");
    }
    const origin = res.req.hostname === "127.0.0.1" ? `http://127.0.0.1:${this.port}` : this.publicUrl;
    const id = secret();
    this.pending.set(id, { ...params, resource: params.resource ?? new URL(`${origin}/mcp`), origin, clientId: client.client_id, expires: now() + 300, failures: 0 });
    // Browsers apply form-action to the redirect chain, including the registered OAuth callback.
    res.setHeader("Content-Security-Policy", `default-src 'none'; form-action 'self' ${new URL(params.redirectUri).origin}; frame-ancestors 'none'; base-uri 'none'`);
    res.type("html").send(`<!doctype html><html lang="en"><meta charset="utf-8"><title>Authorize Jev</title>
      <h1>Authorize Jev evaluation</h1><p>Client: ${escape(client.client_name ?? client.client_id)}</p>
      <p>Redirect: ${escape(params.redirectUri)}</p>
      <p>This grants paid TypeSafe evaluations only. State is sent to TypeSafe. Results are advisory.</p>
      <form method="post" action="/approve"><input type="hidden" name="request" value="${id}">
      <label>Jev approval secret <input type="password" name="secret" autocomplete="off" required maxlength="64"></label>
      <button type="submit">Authorize this client</button></form></html>`);
  }

  approve(req: Request, res: Response): void {
    this.prune();
    const window = Math.floor(Date.now() / 60_000);
    if (window !== this.approvalWindow) { this.approvalWindow = window; this.approvalAttempts = 0; }
    if (++this.approvalAttempts > 10) { res.status(429).send("Approval rate limit reached."); return; }
    const grant = typeof req.body?.request === "string" ? this.pending.get(req.body.request) : undefined;
    const supplied = typeof req.body?.secret === "string" ? req.body.secret : "";
    if (!grant) { res.status(400).send("Authorization request expired or already used. Restart the connection."); return; }
    if (req.get("origin") !== grant.origin) {
      const category = req.get("origin") === "null" ? "opaque" : req.get("origin") ? "unexpected" : "missing";
      res.status(400).send(`Invalid approval origin (${category}).`); return;
    }
    if (++grant.failures > 5) { this.pending.delete(req.body.request); res.status(429).send("Restart authorization."); return; }
    if (!timingSafeEqual(Buffer.from(hash(supplied)), Buffer.from(hash(this.approvalSecret)))) {
      res.status(403).send("Invalid approval secret."); return;
    }
    this.pending.delete(req.body.request);
    const code = secret();
    this.codes.set(hash(code), { ...grant, expires: now() + 60 });
    const redirect = new URL(grant.redirectUri);
    redirect.searchParams.set("code", code);
    if (grant.state !== undefined) redirect.searchParams.set("state", grant.state);
    res.redirect(redirect.href);
  }

  private code(client: OAuthClientInformationFull, code: string): Grant {
    this.prune();
    const grant = this.codes.get(hash(code));
    if (!grant || grant.clientId !== client.client_id) throw new InvalidGrantError("Invalid or expired authorization code.");
    return grant;
  }
  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string): Promise<string> {
    return this.code(client, code).codeChallenge;
  }

  private issue(state: ReturnType<JevOAuth["read"]>, clientId: string, resource: string): OAuthTokens {
    state.tokens = state.tokens.filter((t) => t.refreshExpires > now());
    if (state.tokens.length >= 64) throw new InvalidGrantError("Token limit reached; revoke an existing grant.");
    const access = `jev_at_${secret()}`;
    const refresh = `jev_rt_${secret()}`;
    state.tokens.push({ clientId, resource, accessHash: hash(access), refreshHash: hash(refresh), accessExpires: now() + 3600, refreshExpires: now() + 30 * 86400 });
    writePrivate(this.file, state);
    return { access_token: access, refresh_token: refresh, token_type: "Bearer", expires_in: 3600, scope: SCOPE };
  }

  async exchangeAuthorizationCode(client: OAuthClientInformationFull, code: string, _verifier?: string, redirectUri?: string, resource?: URL): Promise<OAuthTokens> {
    const grant = this.code(client, code);
    this.target(resource);
    if (redirectUri !== grant.redirectUri || (resource && resource.href !== grant.resource?.href)) throw new InvalidGrantError("Redirect URI and resource must match the authorization request.");
    this.codes.delete(hash(code));
    return this.issue(this.read(), client.client_id, grant.resource!.href);
  }
  async exchangeRefreshToken(client: OAuthClientInformationFull, refresh: string, scopes?: string[], resource?: URL): Promise<OAuthTokens> {
    this.scope(scopes);
    this.target(resource);
    const state = this.read();
    const index = state.tokens.findIndex((t) => t.clientId === client.client_id && t.refreshHash === hash(refresh) && t.refreshExpires > now());
    if (index < 0) throw new InvalidGrantError("Invalid or expired refresh token.");
    const target = state.tokens[index].resource;
    if (resource && resource.href !== target) throw new InvalidTargetError("Refresh cannot change the resource.");
    state.tokens.splice(index, 1);
    return this.issue(state, client.client_id, target);
  }
  async verifyAccessToken(access: string) {
    const token = this.read().tokens.find((t) => t.accessHash === hash(access) && t.accessExpires > now());
    if (!token) throw new InvalidTokenError("Invalid or expired Jev token.");
    return { token: access, clientId: token.clientId, scopes: [SCOPE], expiresAt: token.accessExpires, resource: new URL(token.resource) };
  }
  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    const state = this.read();
    const value = hash(request.token);
    state.tokens = state.tokens.filter((t) => t.clientId !== client.client_id || (t.accessHash !== value && t.refreshHash !== value));
    writePrivate(this.file, state);
  }
}
