import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LegacyAuthSnapshot as AuthStore, finalizeAuthHandoff } from "../../src/migration/adoption.js";
import { hubMappingFile, resolveHub } from "../../src/migration/store.js";
import { Workspace } from "../../src/workspace/manager.js";
import { cleanup, isolateStateDir, legacyAuthFixture, makeTmpDir, write } from "../helpers.js";

let state: string;
let root: string;
let other: string;
beforeEach(() => { state = isolateStateDir(); root = makeTmpDir("auth-hub"); other = makeTmpDir("auth-other"); });
afterEach(() => { vi.restoreAllMocks(); [state, root, other].forEach(cleanup); delete process.env.C2C_STATE_DIR; });
function authFile(hubId: string) { return path.join(state, "auth", `${hubId}.json`); }
function initialized(ownerId: string) { return JSON.parse(fs.readFileSync(hubMappingFile(ownerId), "utf8")).authInitialized; }

describe("Hub-owned auth state", () => {
  it.each(["auth copy", "checkpoint"])("retries an interrupted %s without replacing identities or credentials", (stage) => {
    const owner = new Workspace(root);
    const legacy = legacyAuthFixture(state, owner.id);
    const hub = resolveHub(owner);
    const original = fs.renameSync;
    const blocked = stage === "auth copy" ? authFile(hub.hubId) : hubMappingFile(owner.id);
    const rename = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (String(to) === blocked) throw new Error("interrupted adoption");
      return original(from, to);
    });
    expect(() => new AuthStore(hub.hubId)).toThrow(/interrupted adoption/);
    expect(initialized(owner.id)).not.toBe(true);
    expect(fs.existsSync(authFile(hub.hubId))).toBe(stage === "checkpoint");
    rename.mockRestore();
    const store = new AuthStore(hub.hubId);
    expect(store.verifyAccessToken(legacy.accessToken).ok).toBe(true);
    expect(store.refresh(legacy.refreshToken, legacy.client.clientId).ok).toBe(true);
    expect(fs.readFileSync(legacy.file, "utf8")).toBe(legacy.contents);
    expect(fs.readdirSync(path.join(state, "hubs"))).toEqual([`${hub.hubId}.json`]);
    expect(initialized(owner.id)).toBe(true);
  });

  it.each(["different client", "different token", "foreign Hub"])("refuses a conflicting destination with %s without merging", (kind) => {
    const owner = new Workspace(root);
    const legacy = legacyAuthFixture(state, owner.id);
    const hub = resolveHub(owner);
    const expected = { version: 1, hubId: hub.hubId, clients: legacy.data.clients,
      tokens: legacy.data.tokens.map(({ workspaceId: _owner, ...token }) => ({ ...token, hubId: hub.hubId })) };
    if (kind === "different client") expected.clients = [{ ...legacy.client, clientId: "another-client" }];
    if (kind === "different token") expected.tokens[0].expiresAt++;
    if (kind === "foreign Hub") expected.hubId = resolveHub(new Workspace(other)).hubId;
    write(state, `auth/${hub.hubId}.json`, JSON.stringify(expected));
    const before = fs.readFileSync(authFile(hub.hubId), "utf8");
    expect(() => new AuthStore(hub.hubId)).toThrow(/AUTH_STATE_CONFLICT/);
    expect(fs.readFileSync(authFile(hub.hubId), "utf8")).toBe(before);
    expect(fs.readFileSync(legacy.file, "utf8")).toBe(legacy.contents);
    expect(initialized(owner.id)).not.toBe(true);
  });

  it("keeps two legacy owners' clients and access/refresh tokens isolated", () => {
    const a = new Workspace(root), b = new Workspace(other);
    const legacyA = legacyAuthFixture(state, a.id), legacyB = legacyAuthFixture(state, b.id);
    const hubA = resolveHub(a), hubB = resolveHub(b);
    const storeA = new AuthStore(hubA.hubId), storeB = new AuthStore(hubB.hubId);
    expect(storeA.verifyAccessToken(legacyA.accessToken).ok).toBe(true);
    expect(storeB.verifyAccessToken(legacyB.accessToken).ok).toBe(true);
    expect(storeA.verifyAccessToken(legacyB.accessToken).ok).toBe(false);
    expect(storeB.verifyAccessToken(legacyA.accessToken).ok).toBe(false);
    expect(storeA.getClient(legacyB.client.clientId)).toBeUndefined();
    expect(storeB.getClient(legacyA.client.clientId)).toBeUndefined();
    expect(storeA.refresh(legacyB.refreshToken, legacyB.client.clientId).ok).toBe(false);
    expect(storeB.refresh(legacyA.refreshToken, legacyA.client.clientId).ok).toBe(false);
  });

  it.each(["malformed", "foreign owner", "duplicate token"])("rejects %s legacy auth", (kind) => {
    const owner = new Workspace(root), hub = resolveHub(owner);
    const legacy = legacyAuthFixture(state, owner.id);
    if (kind === "foreign owner") legacy.data.tokens[0].workspaceId = new Workspace(other).id;
    if (kind === "duplicate token") legacy.data.tokens.push(legacy.data.tokens[0]);
    fs.writeFileSync(legacy.file, kind === "malformed" ? "{" : JSON.stringify(legacy.data));
    expect(() => new AuthStore(hub.hubId)).toThrow(/AUTH_STATE_CONFLICT/);
    expect(fs.existsSync(authFile(hub.hubId))).toBe(false);
  });

  it("requires a verified mapping and never reimports revoked tokens after the checkpoint", () => {
    const owner = new Workspace(root), hub = resolveHub(owner);
    const legacy = legacyAuthFixture(state, owner.id);
    const store = new AuthStore(hub.hubId);
    store.revokeAll();
    expect(new AuthStore(hub.hubId).verifyAccessToken(legacy.accessToken).ok).toBe(false);
    fs.unlinkSync(authFile(hub.hubId));
    expect(() => new AuthStore(hub.hubId)).toThrow(/Initialized Hub auth state is missing/);
    expect(fs.readFileSync(legacy.file, "utf8")).toBe(legacy.contents);
    fs.writeFileSync(hubMappingFile(owner.id), "{");
    expect(() => new AuthStore(hub.hubId)).toThrow(/HUB_STATE_INVALID/);
  });
});

function rotatedLegacy(owner: Workspace, original: ReturnType<typeof legacyAuthFixture>) {
  const current = legacyAuthFixture(state, owner.id, owner.root);
  current.data.clients = original.data.clients;
  for (const token of current.data.tokens) token.clientId = original.client.clientId;
  fs.writeFileSync(current.file, JSON.stringify(current.data));
  return { ...current, client: original.client, contents: fs.readFileSync(current.file, "utf8") };
}
function handoffFinalized(owner: Workspace) {
  return JSON.parse(fs.readFileSync(hubMappingFile(owner.id), "utf8")).authHandoffFinalized;
}

describe("quiescent legacy auth handoff", () => {
  it("replaces stale provisional tokens with current legacy credentials and never reimports after finalization", () => {
    const owner = new Workspace(root), hub = resolveHub(owner);
    const initial = legacyAuthFixture(state, owner.id, root);
    new AuthStore(hub.hubId);
    expect(initialized(owner.id)).toBe(true);
    expect(handoffFinalized(owner)).not.toBe(true);
    expect(() => new AuthStore(hub.hubId, { requireFinalized: true })).toThrow(/AUTH_HANDOFF_REQUIRED/);
    const current = rotatedLegacy(owner, initial);
    finalizeAuthHandoff(hub.hubId, owner);
    expect(handoffFinalized(owner)).toBe(true);
    expect(initialized(owner.id)).toBe(true);
    expect(JSON.parse(fs.readFileSync(authFile(hub.hubId), "utf8"))).toEqual({
      version: 1, hubId: hub.hubId, clients: current.data.clients,
      tokens: current.data.tokens.map(({ workspaceId: _owner, ...token }) => ({ ...token, hubId: hub.hubId })),
    });
    const store = new AuthStore(hub.hubId, { requireFinalized: true });
    expect(store.verifyAccessToken(current.accessToken).ok).toBe(true);
    expect(store.verifyAccessToken(initial.accessToken).ok).toBe(false);
    expect(store.refresh(initial.refreshToken, initial.client.clientId).ok).toBe(false);
    const rotated = store.refresh(current.refreshToken, current.client.clientId);
    expect(rotated.ok).toBe(true);
    expect(fs.readFileSync(current.file, "utf8")).toBe(current.contents);
    const finalized = fs.readFileSync(authFile(hub.hubId), "utf8");
    fs.writeFileSync(current.file, "{stale retained source");
    finalizeAuthHandoff(hub.hubId, owner);
    fs.unlinkSync(current.file);
    finalizeAuthHandoff(hub.hubId, owner);
    expect(fs.readFileSync(authFile(hub.hubId), "utf8")).toBe(finalized);
    expect(new AuthStore(hub.hubId).verifyAccessToken(current.accessToken).ok).toBe(true);
  });

  it("does not finalize if the legacy source changes while the final snapshot is copied", () => {
    const owner = new Workspace(root), hub = resolveHub(owner);
    const legacy = legacyAuthFixture(state, owner.id, root);
    new AuthStore(hub.hubId);
    const original = fs.renameSync;
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      original(from, to);
      if (String(to) === authFile(hub.hubId)) {
        legacy.data.tokens[0].expiresAt++;
        fs.writeFileSync(legacy.file, JSON.stringify(legacy.data));
      }
    });
    expect(() => finalizeAuthHandoff(hub.hubId, owner)).toThrow(/Legacy auth changed during finalization/);
    expect(handoffFinalized(owner)).not.toBe(true);
  });

  it.each(["copy", "checkpoint"])("retries an interrupted final %s without merging stale tokens", (stage) => {
    const owner = new Workspace(root), hub = resolveHub(owner);
    const initial = legacyAuthFixture(state, owner.id, root);
    new AuthStore(hub.hubId);
    const current = rotatedLegacy(owner, initial);
    const original = fs.renameSync;
    const blocked = stage === "copy" ? authFile(hub.hubId) : hubMappingFile(owner.id);
    const rename = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (String(to) === blocked) throw new Error("interrupted final handoff");
      return original(from, to);
    });
    expect(() => finalizeAuthHandoff(hub.hubId, owner)).toThrow(/interrupted final handoff/);
    expect(handoffFinalized(owner)).not.toBe(true);
    expect(fs.readFileSync(current.file, "utf8")).toBe(current.contents);
    rename.mockRestore();
    finalizeAuthHandoff(hub.hubId, owner);
    const store = new AuthStore(hub.hubId, { requireFinalized: true });
    expect(store.verifyAccessToken(current.accessToken).ok).toBe(true);
    expect(store.refresh(current.refreshToken, current.client.clientId).ok).toBe(true);
    expect(store.verifyAccessToken(initial.accessToken).ok).toBe(false);
    expect(store.refresh(initial.refreshToken, initial.client.clientId).ok).toBe(false);
    expect(handoffFinalized(owner)).toBe(true);
  });
});
