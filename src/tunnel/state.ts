import path from "node:path";
import { z } from "zod";
import { getStateDir, readJsonIfExists } from "../config/paths.js";
import { hubIdSchema } from "../hub/store.js";
import { resourceFile, withHubResource } from "../hub/resource-state.js";

const fields = {
  preference: z.enum(["unset", "quick", "named"]),
  askedAt: z.string().datetime().optional(),
  provider: z.enum(["cloudflare-quick", "cloudflare-named"]).optional(),
  tunnelName: z.string().min(1).optional(),
  tunnelId: z.string().min(1).optional(),
  hostname: z.string().min(1).optional(),
  zone: z.string().min(1).optional(),
  configuredAt: z.string().datetime().optional(),
  fallbackReason: z.string().optional(),
  pending: z.object({ tunnelId: z.string().min(1).optional(), tunnelName: z.string().min(1),
    hostname: z.string().min(1), zone: z.string().min(1), created: z.boolean() }).strict().optional(),
};
const legacySchema = z.object({ workspaceId: z.string().regex(/^[a-f0-9]{12}$/), ...fields }).strict();
const schema = z.object({ version: z.literal(1), hubId: hubIdSchema, ...fields }).strict();
export type TunnelState = z.infer<typeof schema>;
export type TunnelPreference = TunnelState["preference"];

export function tunnelStateFile(hubId: string): string { return resourceFile("tunnel", hubId); }

function access<R>(hubId: string, operation: (current: TunnelState, save: (value: TunnelState) => TunnelState) => R): R {
  const empty: TunnelState = { version: 1, hubId, preference: "unset" };
  return withHubResource(hubId, "tunnel", schema, legacySchema, empty, operation);
}

export function readTunnelState(hubId: string): TunnelState { return access(hubId, (current) => current); }

export function writeTunnelState(state: Omit<TunnelState, "version"> & { version?: 1 }): TunnelState {
  return access(state.hubId, (_current, save) => save({ ...state, version: 1 }));
}

/** Read-only compatibility for the existing legacy destroy path. */
export function legacyTunnelStateFile(owner: string): string { return path.join(getStateDir(), "tunnels", `${owner}.json`); }
export function readLegacyTunnelState(owner: string): z.infer<typeof legacySchema> {
  return readJsonIfExists<z.infer<typeof legacySchema>>(legacyTunnelStateFile(owner)) ?? { workspaceId: owner, preference: "unset" };
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
