import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { cloudflared } from "../src/cloudflared-command.js";
import { provisionTunnel } from "../src/tunnel.js";
import { writePrivate } from "../src/state.js";
import { fixture } from "./fixtures.js";

vi.mock("../src/cloudflared-command.js", () => ({ cloudflared: vi.fn(), cloudflaredEnvironment: () => ({}) }));
const cleanups: Array<() => void> = [];
afterEach(() => { vi.resetAllMocks(); for (const cleanup of cleanups.splice(0)) cleanup(); });
const tunnelId = "12345678-1234-4234-8234-123456789012";

function setup(conflict: "name" | "dns" | "uncertain" | "identity" | "deleted" | "none" = "none") {
  const f = fixture();
  cleanups.push(f.cleanup);
  let created = conflict === "name";
  vi.mocked(cloudflared).mockImplementation(async (args) => {
    if (args[0] === "list") return JSON.stringify(created ? [{ id: tunnelId, name: "jev-test", deleted_at: "0001-01-01T00:00:00Z" }] : null);
    if (args[0] === "create") {
      created = true;
      if (conflict === "uncertain") throw new Error("Create result unknown");
      writePrivate(path.join(f.directory, "tunnel-credentials.json"), {
        AccountTag: "account", TunnelID: conflict === "identity" ? "22345678-1234-4234-8234-123456789012" : tunnelId,
        TunnelSecret: "test-tunnel-secret",
        Endpoint: "",
      });
      return JSON.stringify({ id: tunnelId, name: "jev-test", deleted_at: conflict === "deleted" ? "2026-01-01T00:00:00Z" : "0001-01-01T00:00:00Z" });
    }
    if (conflict === "dns") throw new Error("DNS conflict");
    return "";
  });
  return f;
}

it("provisions via cloudflared without an API token and reuses only its exact verified identity", async () => {
  const f = setup();
  const request = vi.spyOn(globalThis, "fetch");
  try {
    expect(await provisionTunnel(f.directory, f.config, "example.com", "jev-test", "cloudflared")).toMatchObject({ tunnelId });
    await provisionTunnel(f.directory, f.config, "example.com", "jev-test", "cloudflared");
    expect(vi.mocked(cloudflared).mock.calls.filter(([args]) => args[0] === "create")).toHaveLength(1);
    expect(vi.mocked(cloudflared).mock.calls.filter(([args]) => args[0] === "route").map(([args]) => args)).toEqual([
      ["route", "dns", tunnelId, "jev.example.com"], ["route", "dns", tunnelId, "jev.example.com"],
    ]);
    expect(request).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(f.directory, "tunnel.yml"), "utf8")).toContain("http_status:404");
  } finally { request.mockRestore(); }
});

it("refuses an existing tunnel name without creating or routing anything", async () => {
  const f = setup("name");
  await expect(provisionTunnel(f.directory, f.config, "example.com", "jev-test", "cloudflared")).rejects.toThrow("conflict");
  expect(vi.mocked(cloudflared).mock.calls.every(([args]) => args[0] === "list")).toBe(true);
  expect(fs.existsSync(path.join(f.directory, "tunnel-state.json"))).toBe(false);
});

it.each(["--help", "-jev", "jev space"])("rejects the invalid CLI tunnel name %s before running cloudflared", async (name) => {
  const f = setup();
  await expect(provisionTunnel(f.directory, f.config, "example.com", name, "cloudflared")).rejects.toThrow("Invalid tunnel name");
  expect(cloudflared).not.toHaveBeenCalled();
  expect(fs.existsSync(path.join(f.directory, "tunnel-state.json"))).toBe(false);
});

it.each(["uncertain", "identity", "deleted"] as const)("retains create intent after %s creation and refuses a second create", async (conflict) => {
  const f = setup(conflict);
  await expect(provisionTunnel(f.directory, f.config, "example.com", "jev-test", "cloudflared")).rejects.toThrow();
  expect(JSON.parse(fs.readFileSync(path.join(f.directory, "tunnel-state.json"), "utf8")).tunnelId).toBeNull();
  await expect(provisionTunnel(f.directory, f.config, "example.com", "jev-test", "cloudflared")).rejects.toThrow("uncertain");
  expect(vi.mocked(cloudflared).mock.calls.filter(([args]) => args[0] === "create")).toHaveLength(1);
});

it("retains a created tunnel after a DNS conflict without overwriting DNS or publishing ingress", async () => {
  const f = setup("dns");
  await expect(provisionTunnel(f.directory, f.config, "example.com", "jev-test", "cloudflared")).rejects.toThrow("DNS conflict");
  expect(JSON.parse(fs.readFileSync(path.join(f.directory, "tunnel-state.json"), "utf8")).tunnelId).toBe(tunnelId);
  expect(fs.existsSync(path.join(f.directory, "tunnel-credentials.json"))).toBe(true);
  expect(fs.existsSync(path.join(f.directory, "tunnel.yml"))).toBe(false);
  expect(vi.mocked(cloudflared).mock.calls.every(([args]) => !args.includes("--overwrite-dns"))).toBe(true);
});
