import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { hubIdSchema, withHubControlPlane } from "../hub/store.js";
import { ensureDir, getStateDir, writeSecureJson } from "../config/paths.js";

export const SUPPORTED_SCOPES = [
  "workspace.read",
  "workspace.search",
  "git.read",
  "offline_access",
] as const;

export type Scope = (typeof SUPPORTED_SCOPES)[number];

export interface ClientRegistration {
  clientId: string;
  clientName?: string;
  redirectUris: string[];
  createdAt: string;
}

export interface AuthorizationCodeRecord {
  code: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: string[];
  hubId: string;
  pairingSessionId: string;
  resource?: string;
  expiresAt: number;
}

export interface TokenRecord {
  hash: string;
  kind: "access" | "refresh";
  clientId: string;
  hubId: string;
  scopes: string[];
  issuedAt: number;
  expiresAt: number;
  revoked: boolean;
}

const clientSchema = z.object({ clientId: z.string().min(1), clientName: z.string().optional(),
  redirectUris: z.array(z.string()), createdAt: z.string().datetime() }).strict();
const tokenFields = { hash: z.string().regex(/^[a-f0-9]{64}$/), kind: z.enum(["access", "refresh"]),
  clientId: z.string(), scopes: z.array(z.string()), issuedAt: z.number().finite(),
  expiresAt: z.number().finite(), revoked: z.boolean() };
const tokenSchema = z.object({ ...tokenFields, hubId: hubIdSchema }).strict();
const legacySchema = z.object({ clients: z.array(clientSchema), tokens: z.array(
  z.object({ ...tokenFields, workspaceId: z.string().regex(/^[a-f0-9]{12}$/) }).strict()
) }).strict();
const authSchema = z.object({ version: z.literal(1), hubId: hubIdSchema,
  clients: z.array(clientSchema), tokens: z.array(tokenSchema) }).strict();
type PersistedAuthState = z.infer<typeof authSchema>;

export class AuthStateError extends Error {
  constructor(message: string) { super(`AUTH_STATE_CONFLICT: ${message}`); this.name = "AuthStateError"; }
}

function withAuthLock<T>(file: string, operation: () => T): T {
  ensureDir(path.dirname(file));
  const lock = `${file}.lock`;
  let fd: number;
  try { fd = fs.openSync(lock, "wx", 0o600); }
  catch { throw new AuthStateError("Another auth operation holds the state lock."); }
  try { return operation(); }
  finally { fs.closeSync(fd); fs.unlinkSync(lock); }
}

function readAuthJson(file: string): unknown | undefined {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new AuthStateError("Auth state is malformed or unreadable.");
  }
}

function requireUniqueRecords(data: { clients: ClientRegistration[]; tokens: { hash: string }[] }): void {
  if (new Set(data.clients.map((client) => client.clientId)).size !== data.clients.length ||
      new Set(data.tokens.map((token) => token.hash)).size !== data.tokens.length) throw new Error("Duplicate auth records");
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
}

export type VerifyTokenResult =
  | { ok: true; record: TokenRecord }
  | { ok: false; reason: "unknown" | "expired" | "revoked" | "wrong_kind" };

const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const AUTH_CODE_TTL_MS = 5 * 60 * 1000;

function sha256hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function newToken(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString("base64url")}`;
}

export function base64UrlSha256(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

/** Constant-time string comparison for equal-length inputs. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export class AuthStore {
  private clients = new Map<string, ClientRegistration>();
  private tokens = new Map<string, TokenRecord>();
  private authCodes = new Map<string, AuthorizationCodeRecord>();
  private readonly file: string;

  constructor(
    readonly hubId: string,
    opts: { file?: string } = {}
  ) {
    if (!hubIdSchema.safeParse(hubId).success) throw new AuthStateError("Auth owner must be a Hub ID.");
    this.file = opts.file ?? path.join(getStateDir(), "auth", `${hubId}.json`);
    const data = withHubControlPlane(hubId, ({ hub, authInitialized, completeAuthAdoption }) => {
      return withAuthLock(this.file, () => {
        const raw = readAuthJson(this.file);
        let current: PersistedAuthState | undefined;
        try {
          if (raw !== undefined) { current = authSchema.parse(raw); requireUniqueRecords(current); }
          if (current && (current.hubId !== hubId || current.tokens.some((token) => token.hubId !== hubId))) throw new Error("Wrong owner");
        } catch { throw new AuthStateError("Hub auth ownership or format is invalid."); }
        if (authInitialized) {
          if (!current && hub.legacyOwnerWorkspaceId) throw new AuthStateError("Initialized Hub auth state is missing; recovery is required.");
          if (!current) {
            current = { version: 1, hubId, clients: [], tokens: [] };
            writeSecureJson(this.file, current);
          }
          return current;
        }
        const legacyFile = path.join(getStateDir(), "auth", `${hub.legacyOwnerWorkspaceId}.json`);
        return withAuthLock(legacyFile, () => {
          const legacyRaw = readAuthJson(legacyFile);
          let expected: PersistedAuthState = { version: 1, hubId, clients: [], tokens: [] };
          try {
            if (legacyRaw !== undefined) {
              const legacy = legacySchema.parse(legacyRaw);
              requireUniqueRecords(legacy);
              if (legacy.tokens.some((token) => token.workspaceId !== hub.legacyOwnerWorkspaceId)) throw new Error("Wrong legacy owner");
              expected = { version: 1, hubId, clients: legacy.clients,
                tokens: legacy.tokens.map(({ workspaceId: _owner, ...token }) => ({ ...token, hubId })) };
            }
          } catch { throw new AuthStateError("Legacy auth ownership or format is invalid."); }
          if (current && canonical(current) !== canonical(expected)) throw new AuthStateError("Hub and legacy auth stores conflict; merging is forbidden.");
          if (!current) writeSecureJson(this.file, expected);
          if (canonical(readAuthJson(legacyFile)) !== canonical(legacyRaw)) throw new AuthStateError("Legacy auth changed during adoption.");
          completeAuthAdoption();
          return expected;
        });
      });
    });
    const now = Date.now();
    for (const client of data.clients) this.clients.set(client.clientId, client);
    for (const token of data.tokens) if (!token.revoked && token.expiresAt > now) this.tokens.set(token.hash, token);
  }

  private save(): void {
    const now = Date.now();
    const state: PersistedAuthState = {
      version: 1, hubId: this.hubId,
      clients: [...this.clients.values()],
      tokens: [...this.tokens.values()].filter((t) => !t.revoked && t.expiresAt > now),
    };
    writeSecureJson(this.file, state);
  }

  // ---- Dynamic Client Registration -------------------------------------

  registerClient(input: { clientName?: string; redirectUris: string[] }): ClientRegistration {
    const client: ClientRegistration = {
      clientId: `c2c_client_${randomBytes(12).toString("base64url")}`,
      clientName: input.clientName,
      redirectUris: input.redirectUris,
      createdAt: new Date().toISOString(),
    };
    this.clients.set(client.clientId, client);
    this.save();
    return client;
  }

  getClient(clientId: string): ClientRegistration | undefined {
    return this.clients.get(clientId);
  }

  // ---- Authorization codes ----------------------------------------------

  createAuthorizationCode(input: {
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    scopes: string[];
    pairingSessionId: string;
    resource?: string;
  }): string {
    const code = newToken("c2c_ac");
    this.authCodes.set(code, {
      code,
      clientId: input.clientId,
      redirectUri: input.redirectUri,
      codeChallenge: input.codeChallenge,
      scopes: input.scopes,
      hubId: this.hubId,
      pairingSessionId: input.pairingSessionId,
      resource: input.resource,
      expiresAt: Date.now() + AUTH_CODE_TTL_MS,
    });
    return code;
  }

  /** One-time consumption of an authorization code. */
  consumeAuthorizationCode(code: string): AuthorizationCodeRecord | null {
    const record = this.authCodes.get(code);
    if (!record) return null;
    this.authCodes.delete(code);
    if (Date.now() > record.expiresAt || record.hubId !== this.hubId) return null;
    return record;
  }

  // ---- Tokens -------------------------------------------------------------

  issueTokens(input: {
    clientId: string;
    scopes: string[];
    accessTtlMs?: number;
  }): { accessToken: string; refreshToken: string | null; expiresIn: number; scopes: string[] } {
    const now = Date.now();
    const accessTtl = input.accessTtlMs ?? ACCESS_TOKEN_TTL_MS;

    const accessToken = newToken("c2c_at");
    this.tokens.set(sha256hex(accessToken), {
      hash: sha256hex(accessToken),
      kind: "access",
      clientId: input.clientId,
      hubId: this.hubId,
      scopes: input.scopes,
      issuedAt: now,
      expiresAt: now + accessTtl,
      revoked: false,
    });

    let refreshToken: string | null = null;
    if (input.scopes.includes("offline_access")) {
      refreshToken = newToken("c2c_rt");
      this.tokens.set(sha256hex(refreshToken), {
        hash: sha256hex(refreshToken),
        kind: "refresh",
        clientId: input.clientId,
        hubId: this.hubId,
        scopes: input.scopes,
        issuedAt: now,
        expiresAt: now + REFRESH_TOKEN_TTL_MS,
        revoked: false,
      });
    }
    this.save();
    return {
      accessToken,
      refreshToken,
      expiresIn: Math.floor(accessTtl / 1000),
      scopes: input.scopes,
    };
  }

  verifyAccessToken(token: string): VerifyTokenResult {
    const record = this.tokens.get(sha256hex(token));
    if (!record) return { ok: false, reason: "unknown" };
    if (record.kind !== "access") return { ok: false, reason: "wrong_kind" };
    if (record.revoked) return { ok: false, reason: "revoked" };
    if (Date.now() > record.expiresAt) return { ok: false, reason: "expired" };
    return { ok: true, record };
  }

  /** Refresh-token rotation: old refresh token is revoked, a new pair is issued. */
  refresh(
    refreshToken: string,
    clientId: string
  ): { ok: true; tokens: ReturnType<AuthStore["issueTokens"]> } | { ok: false; reason: string } {
    const record = this.tokens.get(sha256hex(refreshToken));
    if (!record || record.kind !== "refresh" || record.hubId !== this.hubId) return { ok: false, reason: "invalid_grant" };
    if (record.revoked) return { ok: false, reason: "invalid_grant" };
    if (Date.now() > record.expiresAt) return { ok: false, reason: "invalid_grant" };
    if (record.clientId !== clientId) return { ok: false, reason: "invalid_client" };
    record.revoked = true;
    this.tokens.delete(record.hash);
    const tokens = this.issueTokens({
      clientId,
      scopes: record.scopes,
    });
    return { ok: true, tokens };
  }

  revokeToken(token: string): boolean {
    const record = this.tokens.get(sha256hex(token));
    if (!record) return false;
    record.revoked = true;
    this.tokens.delete(record.hash);
    this.save();
    return true;
  }

  /** Used by `c2c unpair`: revoke everything for this Hub. */
  revokeAll(): number {
    const count = this.tokens.size;
    this.tokens.clear();
    this.authCodes.clear();
    this.save();
    return count;
  }

  tokenCount(): number {
    return this.tokens.size;
  }

  static deleteStateFile(hubId: string): void {
    const file = path.join(getStateDir(), "auth", `${hubId}.json`);
    try {
      fs.rmSync(file, { force: true });
    } catch {
      // ignore
    }
  }
}

export function filterScopes(requested: string | undefined): string[] {
  if (!requested || requested.trim() === "") return [...SUPPORTED_SCOPES];
  const asked = requested.split(/[\s+]+/).filter(Boolean);
  const granted = asked.filter((scope) => (SUPPORTED_SCOPES as readonly string[]).includes(scope));
  // An explicit retired/unknown scope must not expand into all core permissions.
  return granted;
}
