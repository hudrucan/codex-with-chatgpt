import path from "node:path";
import { getStateDir, readJsonIfExists, writeSecureJson } from "../config/paths.js";

export type TunnelPreference = "unset" | "quick" | "named";

export interface TunnelState {
  workspaceId: string;
  preference: TunnelPreference;
  askedAt?: string;
  provider?: "cloudflare-quick" | "cloudflare-named";
  tunnelName?: string;
  tunnelId?: string;
  hostname?: string;
  zone?: string;
  configuredAt?: string;
  fallbackReason?: string;
  pending?: { tunnelId?: string; tunnelName: string; hostname: string; zone: string; created: boolean };
}

export function tunnelStateFile(workspaceId: string): string {
  return path.join(getStateDir(), "tunnels", `${workspaceId}.json`);
}

export function readTunnelState(workspaceId: string): TunnelState {
  return (
    readJsonIfExists<TunnelState>(tunnelStateFile(workspaceId)) ?? {
      workspaceId,
      preference: "unset",
    }
  );
}

export function writeTunnelState(state: TunnelState): TunnelState {
  writeSecureJson(tunnelStateFile(state.workspaceId), state);
  return state;
}

export function needsTunnelChoice(state: TunnelState): boolean {
  return state.preference === "unset" || !state.askedAt;
}

export function isNamedTunnelReady(state: TunnelState): boolean {
  return (
    !state.pending && state.preference === "named" &&
    Boolean(state.tunnelName?.trim()) &&
    Boolean(state.hostname?.trim())
  );
}

export function namedTunnelBinding(state: TunnelState): { tunnelName: string; hostname: string } | null {
  if (state.pending) throw new Error("TUNNEL_ROLLBACK_PENDING: Recover the saved operation before starting another tunnel.");
  if (!isNamedTunnelReady(state) || !state.tunnelName || !state.hostname) return null;
  return { tunnelName: state.tunnelName, hostname: state.hostname };
}

export const TUNNEL_CHOICE_PROMPT = `Before connecting ChatGPT, choose a connection type.
Do you have a Cloudflare account and a domain already configured there?
- Yes: use a fixed hostname. Authorize Cloudflare once and add a subdomain; the connector usually survives restarts.
- No: use a temporary address. No account is needed and the features are the same, but the address may change after restart. Codex can recreate this project's connector; you may need to log in again.
Which do you prefer? For a fixed hostname, provide your domain (for example example.com).`;

export const NAMED_LOGIN_PROMPT =
  "A browser will open. Log in to Cloudflare, select your domain, and tell me when you are done.";

export const NAMED_FALLBACK_MESSAGE =
  "Using a temporary address this time. Features are unchanged, but future connection repairs may take longer. You can request a fixed hostname later.";

export const NAMED_REPAIR_MESSAGE =
  "The fixed hostname is currently unreachable. Log in to Cloudflare in the browser, select your domain, and tell me when you are done.";
