import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { AuthStore } from "../../src/auth/store.js";
import { startBridge, type Bridge } from "../../src/bridge/server.js";
import { Workspace } from "../../src/workspace/manager.js";
import { cleanup, isolateStateDir, legacyAuthFixture, makeTmpDir } from "../helpers.js";

let state: string;
let root: string;
let bridge: Bridge;
let legacy: ReturnType<typeof legacyAuthFixture>;
beforeEach(async () => {
  state = isolateStateDir(); root = makeTmpDir("auth-http-adoption");
  legacy = legacyAuthFixture(state, new Workspace(root).id);
  bridge = await startBridge({ workspaceRoot: root, port: 0, persistRuntime: false });
});
afterEach(async () => { await bridge?.close(); [state, root].forEach(cleanup); delete process.env.C2C_STATE_DIR; });

it("accepts the existing access token through Hub bearer validation without reauthorization", async () => {
  expect(bridge.authStore.hubId).toBe(bridge.hubId);
  expect(bridge.pairing.hubId).toBe(bridge.hubId);
  expect(bridge.authStore.getClient(legacy.client.clientId)).toEqual(legacy.client);
  const saved = JSON.parse(fs.readFileSync(path.join(state, "auth", `${bridge.hubId}.json`), "utf8"));
  expect(saved).toEqual({ version: 1, hubId: bridge.hubId, clients: legacy.data.clients,
    tokens: legacy.data.tokens.map(({ workspaceId: _owner, ...token }) => ({ ...token, hubId: bridge.hubId })) });
  expect(fs.readFileSync(legacy.file, "utf8")).toBe(legacy.contents);
  const response = await fetch(`${bridge.localBaseUrl()}/mcp`, { headers: { authorization: `Bearer ${legacy.accessToken}` } });
  expect(response.status).toBe(405);
});

it("refreshes the unchanged legacy credential through OAuth and persists Hub-bound replacement tokens", async () => {
  const response = await fetch(`${bridge.localBaseUrl()}/oauth/token`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ grant_type: "refresh_token", refresh_token: legacy.refreshToken, client_id: legacy.client.clientId }),
  });
  expect(response.status).toBe(200);
  const body = await response.json() as { access_token: string; refresh_token: string };
  expect(body.refresh_token).not.toBe(legacy.refreshToken);
  const reloaded = new AuthStore(bridge.hubId);
  expect(reloaded.getClient(legacy.client.clientId)).toEqual(legacy.client);
  expect(reloaded.verifyAccessToken(legacy.accessToken)).toMatchObject({ ok: true, record: { hubId: bridge.hubId } });
  expect(reloaded.verifyAccessToken(body.access_token)).toMatchObject({ ok: true, record: { hubId: bridge.hubId } });
  expect(reloaded.refresh(legacy.refreshToken, legacy.client.clientId).ok).toBe(false);
  const saved = JSON.parse(fs.readFileSync(path.join(state, "auth", `${bridge.hubId}.json`), "utf8"));
  expect(saved.tokens.every((token: { hubId: string; workspaceId?: string }) => token.hubId === bridge.hubId && token.workspaceId === undefined)).toBe(true);
  expect(fs.readFileSync(legacy.file, "utf8")).toBe(legacy.contents);
});
