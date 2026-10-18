import { normalizeNamedTunnelHostname } from "./cloudflared-named.js";

/** DNS-safe Hub label; use an internal identity fallback only when no ASCII label exists. */
export function hostnameSlug(displayName: string, internalId: string): string {
  const ascii = displayName
    .normalize("NFKD")
    .replace(/[^\x00-\x7F]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30);
  const label = ascii || `hub-${internalId.replace(/^hub-/, "").replace(/-/g, "").slice(0, 8)}`;
  return `c2c-${label}`;
}

export function suggestedNamedHostname(
  zone: string,
  displayName: string,
  internalId: string
): string {
  const zoneHost = normalizeNamedTunnelHostname(zone);
  return `${hostnameSlug(displayName, internalId)}.${zoneHost}`;
}

export function parseZoneInput(input: string): string | null {
  const trimmed = input.trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, "").replace(/\.$/, "");
  if (!trimmed) return null;
  try {
    return normalizeNamedTunnelHostname(trimmed);
  } catch {
    return null;
  }
}
