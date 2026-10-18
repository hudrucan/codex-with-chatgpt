import { beforeEach, describe, expect, it, vi } from "vitest";

const { spawnSync } = vi.hoisted(() => ({ spawnSync: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(), spawnSync,
}));
import { pullFork } from "../../src/config/update.js";
import { ProcessCloudflaredAccount } from "../../src/tunnel/named-provision.js";

describe("Cloudflare naming conflicts", () => {
  beforeEach(() => { spawnSync.mockReset(); });

  it("does not treat an existing DNS record as a successful route", async () => {
    spawnSync.mockReturnValue({ status: 1, stdout: "", stderr: "record already exists" });
    const account = new ProcessCloudflaredAccount("test-cloudflared");
    await expect(account.routeDns("resource-id", "code.example.com")).rejects.toThrow(/TUNNEL_NAMING_CONFLICT.*code.example.com/);
  });

  it("does not adopt a tunnel created concurrently even if the error contains a UUID", async () => {
    spawnSync
      .mockReturnValueOnce({ status: 0, stdout: "[]", stderr: "" })
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "desk-c2c already exists: 11111111-1111-4111-8111-111111111111" });
    const account = new ProcessCloudflaredAccount("test-cloudflared");
    await expect(account.createTunnel("desk-c2c")).rejects.toThrow(/TUNNEL_NAMING_CONFLICT/);
  });
  it("does not delete a tunnel whose UUID/name no longer match", async () => {
    spawnSync.mockReturnValueOnce({ status: 0, stdout: JSON.stringify([{ id: "owned", name: "externally-renamed" }]), stderr: "" });
    await expect(new ProcessCloudflaredAccount("test-cloudflared").deleteTunnel({ id: "owned", name: "original" })).rejects.toThrow(/CONFLICT/);
    expect(spawnSync).toHaveBeenCalledTimes(1);
  });

  it("refuses an upstream checkout before any update pull", () => {
    spawnSync.mockReturnValueOnce({ status: 0, stdout: "git@github.com:XiaoDuoYa/codex-with-chatgpt.git", stderr: "" });
    expect(() => pullFork("/temporary-checkout")).toThrow(/UPDATE_ORIGIN_CONFLICT/);
    expect(spawnSync).toHaveBeenCalledTimes(1);
  });

  it("refuses dirty checkouts without stashing or pulling", () => {
    spawnSync.mockReturnValueOnce({ status: 0, stdout: "git@github.com:hudrucan/desk-c2c-hub.git" })
      .mockReturnValueOnce({ status: 0, stdout: " M README.md" });
    expect(() => pullFork("/temporary-checkout")).toThrow(/UPDATE_DIRTY_CHECKOUT/);
    expect(spawnSync).toHaveBeenCalledTimes(2);
  });

  it("pulls the current branch explicitly from the verified fork, ignoring other upstream remotes", () => {
    spawnSync.mockReturnValueOnce({ status: 0, stdout: "git@github.com:hudrucan/desk-c2c-hub.git" })
      .mockReturnValueOnce({ status: 0, stdout: "" })
      .mockReturnValueOnce({ status: 0, stdout: "main" })
      .mockReturnValueOnce({ status: 0, stdout: "Already up to date." });
    pullFork("/temporary-checkout");
    expect(spawnSync).toHaveBeenLastCalledWith("git", ["pull", "--ff-only", "origin", "main"], expect.objectContaining({ cwd: "/temporary-checkout", windowsHide: true }));
  });

});
