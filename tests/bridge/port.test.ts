import { fixtureHub, fixtureAuthFile } from "../helpers.js";
import { describe, it, expect } from "vitest";
import path from "node:path";
import { startBridge } from "../../src/bridge/server.js";
import { probeBridge } from "../../src/bridge/runtime.js";
import { makeTmpDir, cleanup, write, isolateStateDir } from "../helpers.js";

describe("port collision handling", () => {
  it("falls back to a free port when the preferred one is taken", async () => {
    isolateStateDir();
    const rootA = makeTmpDir("port-a");
    const rootB = makeTmpDir("port-b");
    write(rootA, "a.txt", "a");
    write(rootB, "b.txt", "b");
    const preferred = 47000 + Math.floor(Math.random() * 1000);

    const bridgeA = await startBridge({
      hubId: fixtureHub(rootA).hubId,
      port: preferred,
      persistRuntime: false,
      authStoreFile: fixtureAuthFile(fixtureHub(rootA).hubId, path.join(makeTmpDir("auth"), "a.json")),
    });
    const bridgeB = await startBridge({
      hubId: fixtureHub(rootB).hubId,
      port: preferred,
      persistRuntime: false,
      authStoreFile: fixtureAuthFile(fixtureHub(rootB).hubId, path.join(makeTmpDir("auth"), "b.json")),
    });

    expect(bridgeA.port).toBe(preferred);
    expect(bridgeB.port).not.toBe(preferred);
    expect(bridgeB.port).toBeGreaterThan(0);

    // Health identifies each Hub, so callers can detect reuse.
    const healthA = await probeBridge(bridgeA.port);
    const healthB = await probeBridge(bridgeB.port);
    expect(healthA?.hubId).toBe(bridgeA.hubId);
    expect(healthB?.hubId).toBe(bridgeB.hubId);
    expect(healthA?.hubId).not.toBe(healthB?.hubId);

    await bridgeA.close();
    await bridgeB.close();
    cleanup(rootA);
    cleanup(rootB);
  });

  it("refuses to bind non-loopback hosts", async () => {
    const root = makeTmpDir("port-c");
    write(root, "c.txt", "c");
    await expect(
      startBridge({ hubId: fixtureHub(root).hubId, host: "0.0.0.0", persistRuntime: false })
    ).rejects.toThrow(/loopback/);
    cleanup(root);
  });
});
