import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { z } from "zod";
import { type Config, JevError, readPrivate, writePrivate, privateFile } from "./state.js";
import { verify } from "./verify.js";

const bindingSchema = z.object({
  version: z.literal(1), service: z.literal("jev-mcp"), name: z.string(), hostname: z.string(),
  zoneId: z.string(), accountId: z.string(), tunnelId: z.string().uuid().nullable(),
}).strict();
const tunnelCredentials = z.object({ AccountTag: z.string(), TunnelID: z.string().uuid().nullable(), TunnelSecret: z.string() }).strict();

function tunnelConfiguration(config: Config, binding: z.infer<typeof bindingSchema>, credentialsFile: string): string {
  return `tunnel: ${binding.tunnelId}\ncredentials-file: ${JSON.stringify(credentialsFile)}\ningress:\n  - hostname: ${binding.hostname}\n    service: http://127.0.0.1:${config.port}\n    originRequest:\n      httpHostHeader: ${binding.hostname}\n  - service: http_status:404\n`;
}

export async function provisionTunnel(directory: string, config: Config, zoneName: string, name: string) {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!token) throw new JevError("Set CLOUDFLARE_API_TOKEN for tunnel provisioning only.");
  if (!/^[a-z0-9-]{1,63}$/.test(name)) throw new JevError("Invalid tunnel name.");
  const hostname = new URL(config.publicUrl).hostname;
  if (!hostname.endsWith(`.${zoneName}`)) throw new JevError("Hostname must be inside the explicit zone.");
  async function api<T>(route: string, method = "GET", body?: unknown): Promise<T> {
    const response = await fetch(`https://api.cloudflare.com/client/v4${route}`, {
      method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15_000), redirect: "error",
    });
    const data = await response.json() as { success: boolean; result: T };
    if (!response.ok || !data.success) throw new JevError(`Cloudflare operation failed (HTTP ${response.status}); saved ownership state retained.`);
    return data.result;
  }
  const zones = await api<Array<{ id: string; name: string; account: { id: string } }>>(`/zones?name=${encodeURIComponent(zoneName)}`);
  if (zones.length !== 1 || zones[0].name !== zoneName) throw new JevError("Cannot resolve the exact Cloudflare zone.");
  const zone = zones[0];
  const file = path.join(directory, "tunnel-state.json");
  const credentialsFile = path.join(directory, "tunnel-credentials.json");
  let binding: z.infer<typeof bindingSchema>;
  const dns = () => api<Array<{ id: string; type: string; name: string; content: string }>>(`/zones/${zone.id}/dns_records?name=${encodeURIComponent(hostname)}`);
  if (fs.existsSync(file)) {
    binding = readPrivate(file, bindingSchema);
    if (binding.name !== name || binding.hostname !== hostname || binding.zoneId !== zone.id || binding.accountId !== zone.account.id || !binding.tunnelId) {
      throw new JevError("Tunnel ownership conflict or uncertain create outcome; reconcile saved state explicitly.");
    }
    const remote = await api<{ id: string; name: string; deleted_at: string | null }>(`/accounts/${binding.accountId}/cfd_tunnel/${binding.tunnelId}`);
    const credentials = readPrivate(credentialsFile, tunnelCredentials);
    if (remote.id !== binding.tunnelId || remote.name !== name || remote.deleted_at || credentials.TunnelID !== binding.tunnelId || credentials.AccountTag !== binding.accountId) {
      throw new JevError("Saved tunnel ownership no longer matches Cloudflare.");
    }
  } else {
    const existing = await api<Array<{ id: string }>>(`/accounts/${zone.account.id}/cfd_tunnel?is_deleted=false&name=${encodeURIComponent(name)}`);
    if (existing.length || (await dns()).length || fs.existsSync(credentialsFile)) throw new JevError("Tunnel name, DNS or credentials conflict; existing resources were not changed.");
    binding = { version: 1, service: "jev-mcp", name, hostname, zoneId: zone.id, accountId: zone.account.id, tunnelId: null };
    writePrivate(file, binding);
    const tunnelSecret = randomBytes(32).toString("base64");
    writePrivate(credentialsFile, { AccountTag: zone.account.id, TunnelID: null, TunnelSecret: tunnelSecret });
    // Persist the intent before creation. An ambiguous failure is never retried as a new resource.
    const created = await api<{ id: string; name: string }>(`/accounts/${zone.account.id}/cfd_tunnel`, "POST", { name, tunnel_secret: tunnelSecret, config_src: "local" });
    if (created.name !== name || !z.string().uuid().safeParse(created.id).success) throw new JevError("Unexpected Cloudflare tunnel identity; intent retained.");
    writePrivate(credentialsFile, { AccountTag: zone.account.id, TunnelID: created.id, TunnelSecret: tunnelSecret });
    binding.tunnelId = created.id;
    writePrivate(file, binding);
  }
  const records = await dns();
  const target = `${binding.tunnelId}.cfargotunnel.com`;
  if (records.length) {
    if (records.length !== 1 || records[0].name !== hostname || records[0].type !== "CNAME" || records[0].content !== target) {
      throw new JevError("DNS ownership conflict; saved tunnel retained without changing DNS.");
    }
  } else {
    await api(`/zones/${zone.id}/dns_records`, "POST", { type: "CNAME", name: hostname, content: target, proxied: true, ttl: 1 });
  }
  const configuration = tunnelConfiguration(config, binding, credentialsFile);
  const configFile = path.join(directory, "tunnel.yml");
  if (fs.existsSync(configFile)) privateFile(configFile);
  fs.writeFileSync(configFile, configuration, { mode: 0o600 });
  return { hostname, tunnelName: name, tunnelId: binding.tunnelId, status: "provisioned; tunnel not started" };
}

export async function runTunnel(directory: string, config: Config, approvalSecret: string, signal?: AbortSignal): Promise<void> {
  // Authentication is checked against the running process every time, before public exposure.
  await verify(directory, `http://127.0.0.1:${config.port}`, approvalSecret);
  const binding = readPrivate(path.join(directory, "tunnel-state.json"), bindingSchema);
  const credentials = readPrivate(path.join(directory, "tunnel-credentials.json"), tunnelCredentials);
  if (!binding.tunnelId || binding.hostname !== new URL(config.publicUrl).hostname || credentials.TunnelID !== binding.tunnelId || credentials.AccountTag !== binding.accountId) {
    throw new JevError("Tunnel credentials do not match Jev ownership state.");
  }
  privateFile(path.join(directory, "tunnel.yml"));
  if (fs.readFileSync(path.join(directory, "tunnel.yml"), "utf8") !== tunnelConfiguration(config, binding, path.join(directory, "tunnel-credentials.json"))) {
    throw new JevError("Jev ingress configuration differs from its verified binding; tunnel was not exposed.");
  }
  signal?.throwIfAborted();
  const child = spawn("cloudflared", ["--no-autoupdate", "--config", path.join(directory, "tunnel.yml"), "tunnel", "run", binding.tunnelId], {
    stdio: "inherit", env: { PATH: process.env.PATH, HOME: process.env.HOME },
  });
  const stop = () => child.kill("SIGTERM");
  signal?.addEventListener("abort", stop, { once: true });
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("error", () => reject(new JevError("Cannot start cloudflared.")));
      child.once("exit", (code) => code === 0 ? resolve() : reject(new JevError("Jev tunnel stopped; inspect its independent log.")));
    });
  } finally { signal?.removeEventListener("abort", stop); process.off("SIGINT", stop); process.off("SIGTERM", stop); }
}
