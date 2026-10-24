import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { provisionTunnel, runTunnel } from "../src/tunnel.js";
import { fixture } from "./fixtures.js";

const cleanups: Array<() => void> = [];
afterEach(() => { vi.unstubAllGlobals(); for (const cleanup of cleanups.splice(0)) cleanup(); });
const tunnelId = "12345678-1234-4234-8234-123456789012";

function setup(conflict: "name" | "dns" | "uncertain" | "none" = "none") {
  const f = fixture();
  cleanups.push(f.cleanup);
  vi.stubEnv("CLOUDFLARE_API_TOKEN", "test-cloudflare-token");
  cleanups.push(() => vi.unstubAllEnvs());
  let created = false;
  let routed = false;
  const request = vi.fn<typeof fetch>(async (url, init) => {
    const route = String(url);
    const method = init?.method ?? "GET";
    let result: unknown;
    if (route.includes("/zones?")) result = [{ id: "zone", name: "example.com", account: { id: "account" } }];
    else if (method === "POST" && route.endsWith("/cfd_tunnel")) {
      created = true;
      if (conflict === "uncertain") throw new Error("Network failure after dispatch");
      result = { id: tunnelId, name: "jev-test" };
    } else if (method === "POST" && route.endsWith("/dns_records")) { routed = true; result = {}; }
    else if (route.includes("/dns_records?")) result = conflict === "dns" ? [{ type: "CNAME", name: "jev.example.com", content: "unrelated.cfargotunnel.com" }]
      : routed ? [{ type: "CNAME", name: "jev.example.com", content: `${tunnelId}.cfargotunnel.com` }] : [];
    else if (route.endsWith(`/cfd_tunnel/${tunnelId}`)) result = { id: tunnelId, name: "jev-test", deleted_at: null };
    else result = conflict === "name" || created ? [{ id: tunnelId, name: "jev-test" }] : [];
    return Response.json({ success: true, result });
  });
  vi.stubGlobal("fetch", request);
  return { ...f, request };
}

it("creates only the explicit new tunnel/DNS and reuses only its saved exact binding", async () => {
  const f = setup();
  expect(await provisionTunnel(f.directory, f.config, "example.com", "jev-test")).toMatchObject({ tunnelId, hostname: "jev.example.com" });
  await provisionTunnel(f.directory, f.config, "example.com", "jev-test");
  expect(f.request.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(2);
  expect(f.request.mock.calls.every(([, init]) => !["DELETE", "PATCH", "PUT"].includes(init?.method ?? "GET"))).toBe(true);
  expect(fs.readFileSync(path.join(f.directory, "tunnel.yml"), "utf8")).toContain("http://127.0.0.1:49873");
});

it.each(["name", "dns"] as const)("refuses %s conflicts without adopting or changing resources", async (conflict) => {
  const f = setup(conflict);
  await expect(provisionTunnel(f.directory, f.config, "example.com", "jev-test")).rejects.toThrow("conflict");
  expect(f.request.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
});

it("retains create intent and credentials after an ambiguous failure, blocking duplicate creation", async () => {
  const f = setup("uncertain");
  await expect(provisionTunnel(f.directory, f.config, "example.com", "jev-test")).rejects.toThrow();
  expect(JSON.parse(fs.readFileSync(path.join(f.directory, "tunnel-state.json"), "utf8")).tunnelId).toBeNull();
  expect(JSON.parse(fs.readFileSync(path.join(f.directory, "tunnel-credentials.json"), "utf8")).TunnelSecret).toBeTruthy();
  await expect(provisionTunnel(f.directory, f.config, "example.com", "jev-test")).rejects.toThrow("uncertain");
  expect(f.request.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
});

it("never starts public exposure when the running endpoint fails authentication", async () => {
  const f = setup();
  f.request.mockImplementation(async () => Response.json({ accepted: true }));
  await expect(runTunnel(f.directory, f.config, f.credentials.approvalSecret)).rejects.toThrow("Authentication probe failed");
});
