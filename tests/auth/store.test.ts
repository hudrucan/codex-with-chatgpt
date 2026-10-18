import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { AuthStore } from "../../src/auth/store.js";
import { createHub } from "../../src/hub/store.js";
import { cleanup, isolateStateDir } from "../helpers.js";
let state: string;
beforeEach(() => { state = isolateStateDir(); });
afterEach(() => { cleanup(state); delete process.env.C2C_STATE_DIR; });

it("persists Hub clients and hashed tokens, and rotates refresh credentials across reloads", () => {
  const hub = createHub("Desk"), store = new AuthStore(hub.hubId);
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
  const hub = createHub("Desk"), file = path.join(state, "auth", `${hub.hubId}.json`);
  if (kind === "missing") fs.unlinkSync(file); else fs.writeFileSync(file, "{");
  expect(() => new AuthStore(hub.hubId)).toThrow(/AUTH_STATE_CONFLICT/);
  expect(fs.existsSync(file)).toBe(kind !== "missing");
});
