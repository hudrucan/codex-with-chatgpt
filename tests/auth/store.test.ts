import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AuthStore, ClientRegistrationLimitError, MAX_OAUTH_CLIENTS } from "../../src/auth/store.js";
import { createHub } from "../../src/hub/store.js";
import { cleanup, isolateStateDir } from "../helpers.js";
let state: string;
beforeEach(() => { state = isolateStateDir(); });
afterEach(() => { vi.restoreAllMocks(); cleanup(state); delete process.env.C2C_STATE_DIR; });

function fullClientStore() {
  const hub = createHub("Demo Hub"), file = path.join(state, "auth", `${hub.hubId}.json`);
  const clients = Array.from({ length: MAX_OAUTH_CLIENTS }, (_, index) => ({
    clientId: `client-${String(index).padStart(3, "0")}`, redirectUris: ["http://localhost/callback"],
    createdAt: index === 2 ? "1999-01-01T00:00:00.000Z" : "2000-01-01T00:00:00.000Z",
  })).reverse();
  fs.writeFileSync(file, JSON.stringify({ version: 1, hubId: hub.hubId, clients, tokens: [] }));
  return { hub, file, clients, store: new AuthStore(hub.hubId) };
}

it("recovers a full anonymous registration store by createdAt, then clientId, independently of insertion order", () => {
  const { hub, file, store } = fullClientStore();
  for (const oldest of ["client-002", "client-000", "client-001"]) {
    const added = store.registerClient({ redirectUris: ["http://localhost/callback"] });
    expect(store.getClient(oldest)).toBeUndefined();
    const current = new AuthStore(hub.hubId);
    expect(current.getClient(oldest)).toBeUndefined(); expect(current.getClient(added.clientId)).toEqual(added);
    expect(JSON.parse(fs.readFileSync(file, "utf8")).clients).toHaveLength(MAX_OAUTH_CLIENTS);
  }
});

it.each(["access", "refresh", "authorization code"])("never reclaims a registration referenced by a live %s", kind => {
  const { store } = fullClientStore(), clientId = "client-002";
  const code = kind === "authorization code" ? store.createAuthorizationCode({
    clientId, redirectUri: "http://localhost/callback", codeChallenge: "challenge", scopes: ["workspace.read"], pairingSessionId: "pairing",
  }) : undefined;
  const tokens = code ? undefined : store.issueTokens({ clientId,
    scopes: kind === "refresh" ? ["workspace.read", "offline_access"] : ["workspace.read"],
    ...(kind === "refresh" ? { accessTtlMs: -1 } : {}),
  });
  const original = store.getClient(clientId);
  store.registerClient({ redirectUris: ["http://localhost/callback"] });
  expect(store.getClient(clientId)).toEqual(original); expect(store.getClient("client-000")).toBeUndefined();
  if (code) expect(store.consumeAuthorizationCode(code)).toMatchObject({ clientId });
  else if (kind === "refresh") expect(store.refresh(tokens!.refreshToken!, clientId).ok).toBe(true);
  else expect(store.verifyAccessToken(tokens!.accessToken).ok).toBe(true);
});

it("rejects a fully code-protected store without losing approvals, then recovers after code expiry", () => {
  const { store, clients, file } = fullClientStore(), now = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  const input = (clientId: string) => ({ clientId, redirectUri: "http://localhost/callback",
    codeChallenge: "challenge", scopes: ["workspace.read"], pairingSessionId: "pairing" });
  const codes = clients.map(client => store.createAuthorizationCode(input(client.clientId)));
  const before = fs.readFileSync(file);
  expect(() => store.registerClient({ redirectUris: [] })).toThrow(ClientRegistrationLimitError);
  expect(fs.readFileSync(file)).toEqual(before);
  for (const client of clients) expect(store.getClient(client.clientId)).toEqual(client);
  expect(store.consumeAuthorizationCode(codes[0])).toMatchObject({ clientId: clients[0].clientId });
  clock.mockReturnValue(now + 5 * 60_000 + 1);
  store.registerClient({ redirectUris: [] });
  expect(store.getClient("client-002")).toBeUndefined();
  for (const code of codes) expect(store.consumeAuthorizationCode(code)).toBeNull();
  expect(JSON.parse(fs.readFileSync(file, "utf8")).clients).toHaveLength(MAX_OAUTH_CLIENTS);
});

it("persists Hub clients and hashed tokens, and rotates refresh credentials across reloads", () => {
  const hub = createHub("Demo Hub"), store = new AuthStore(hub.hubId);
  const client = store.registerClient({ clientName: "ChatGPT", redirectUris: ["http://localhost/callback"] });
  const tokens = store.issueTokens({ clientId: client.clientId, scopes: ["workspace.read", "offline_access"] });
  const file = path.join(state, "auth", `${hub.hubId}.json`), persisted = fs.readFileSync(file, "utf8");
  expect(persisted).not.toContain(tokens.accessToken); expect(persisted).not.toContain(tokens.refreshToken!);
  const reloaded = new AuthStore(hub.hubId);
  expect(reloaded.getClient(client.clientId)).toEqual(client);
  expect(reloaded.verifyAccessToken(tokens.accessToken)).toMatchObject({ ok: true, record: { hubId: hub.hubId } });
  const rotated = reloaded.refresh(tokens.refreshToken!, client.clientId);
  expect(rotated.ok).toBe(true);
  const current = new AuthStore(hub.hubId);
  expect(current.refresh(tokens.refreshToken!, client.clientId).ok).toBe(false);
  if (rotated.ok) expect(current.verifyAccessToken(rotated.tokens.accessToken)).toMatchObject({ ok: true, record: { hubId: hub.hubId } });
});

it("isolates Hub credentials and rejects a foreign store without merging or overwriting it", () => {
  const a = createHub("One"), b = createHub("Two"), first = new AuthStore(a.hubId);
  const client = first.registerClient({ redirectUris: [] }), token = first.issueTokens({ clientId: client.clientId, scopes: ["workspace.read"] }).accessToken;
  const second = new AuthStore(b.hubId);
  expect(second.getClient(client.clientId)).toBeUndefined(); expect(second.verifyAccessToken(token).ok).toBe(false);
  const target = path.join(state, "auth", `${b.hubId}.json`);
  fs.copyFileSync(path.join(state, "auth", `${a.hubId}.json`), target);
  const bytes = fs.readFileSync(target);
  expect(() => new AuthStore(b.hubId)).toThrow(/AUTH_STATE_CONFLICT/);
  expect(fs.readFileSync(target)).toEqual(bytes);
});

it.each(["missing", "malformed"])("fails closed on %s authoritative auth state", kind => {
  const hub = createHub("Demo Hub"), file = path.join(state, "auth", `${hub.hubId}.json`);
  if (kind === "missing") fs.unlinkSync(file); else fs.writeFileSync(file, "{");
  expect(() => new AuthStore(hub.hubId)).toThrow(/AUTH_STATE_CONFLICT/);
  expect(fs.existsSync(file)).toBe(kind !== "missing");
});
