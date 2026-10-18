/** Narrow API surface for resource renames and ownership-checked DNS cleanup.
 * Tokens stay in the environment; cloudflared account certificates are not parsed. */
export interface DnsRecord { id: string; name: string; type: string; content: string }

export class CloudflareApi {
  constructor(private readonly request: typeof fetch = fetch) {}

  private async call<T>(route: string, method = "GET", body?: unknown): Promise<T> {
    const token = process.env.CLOUDFLARE_API_TOKEN?.trim();
    if (!token) throw new Error("NEED_CLOUDFLARE_API_TOKEN: Rename/cleanup requires a scoped Cloudflare API token (Zone Read, DNS Edit; Tunnel Edit for tunnel rename). Existing setup does not require it.");
    const response = await this.request(`https://api.cloudflare.com/client/v4${route}`, {
      method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000), redirect: "error",
    });
    const data = await response.json() as { success: boolean; result: T };
    // Do not include provider responses, request headers, or credentials in errors.
    if (!response.ok || !data.success) throw new Error(`Cloudflare ${method} failed (${response.status}); saved state retained for retry.`);
    return data.result;
  }

  private async zone(name: string): Promise<{ id: string; account: { id: string } }> {
    const zones = await this.call<Array<{ id: string; name: string; account: { id: string } }>>(`/zones?name=${encodeURIComponent(name)}`);
    const matches = zones.filter((zone) => zone.name === name);
    if (matches.length !== 1) throw new Error(`OWNERSHIP_CONFLICT: Cannot resolve exact Cloudflare zone ${name}.`);
    return matches[0];
  }

  async dns(zoneName: string, hostname: string): Promise<DnsRecord | null> {
    const zone = await this.zone(zoneName);
    const rows = await this.call<DnsRecord[]>(`/zones/${zone.id}/dns_records?name=${encodeURIComponent(hostname)}`);
    const exact = rows.filter((record) => record.name === hostname);
    if (exact.length > 1) throw new Error(`OWNERSHIP_CONFLICT: Multiple DNS records for ${hostname}.`);
    return exact[0] ?? null;
  }

  async deleteDns(zoneName: string, hostname: string, tunnelId: string): Promise<void> {
    const zone = await this.zone(zoneName);
    const record = await this.dns(zoneName, hostname);
    if (!record) return;
    assertDnsOwnership(record, tunnelId);
    // Re-read the exact record immediately before deletion. Never delete by name alone.
    const current = await this.call<DnsRecord>(`/zones/${zone.id}/dns_records/${record.id}`);
    if (current.name !== hostname) throw new Error("OWNERSHIP_CONFLICT: DNS record changed during cleanup.");
    assertDnsOwnership(current, tunnelId);
    await this.call(`/zones/${zone.id}/dns_records/${record.id}`, "DELETE");
  }

  async renameTunnel(zoneName: string, tunnelId: string, expectedName: string, name: string): Promise<void> {
    const zone = await this.zone(zoneName);
    const route = `/accounts/${zone.account.id}/cfd_tunnel/${encodeURIComponent(tunnelId)}`;
    const tunnel = await this.call<{ id: string; name: string }>(route);
    if (tunnel.id !== tunnelId || tunnel.name !== expectedName) throw new Error("OWNERSHIP_CONFLICT: Tunnel binding changed before rename.");
    const renamed = await this.call<{ id: string; name: string }>(route, "PATCH", { name });
    if (renamed.id !== tunnelId || renamed.name !== name) throw new Error("OWNERSHIP_CONFLICT: Unexpected tunnel rename result.");
  }
}

export function assertDnsOwnership(record: DnsRecord, tunnelId: string): void {
  if (record.type !== "CNAME" || record.content.toLowerCase().replace(/\.$/, "") !== `${tunnelId.toLowerCase()}.cfargotunnel.com`) {
    throw new Error(`OWNERSHIP_CONFLICT: DNS ${record.name} does not point to the saved Tunnel ID.`);
  }
}
