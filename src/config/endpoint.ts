import path from "node:path";
import { getStateDir, readJsonIfExists, writeSecureJson } from "./paths.js";
import { userFacingName } from "./naming.js";

export const CHATGPT_DEVELOPER_MODE_URL = "https://chatgpt.com/#settings/Security";
export const CHATGPT_PLUGINS_URL = "https://chatgpt.com/plugins";
export const CHATGPT_CREATE_CONNECTOR_URL =
  "https://chatgpt.com/settings/plugins-settings";

export const DEFAULT_CONNECTOR_NAME = "Desk C2C Hub";
export const LEGACY_CONNECTOR_NAME = "Codex with ChatGPT";

export interface LastEndpoint {
  workspaceId: string;
  port: number;
  publicUrl: string | null;
  mcpUrl: string | null;
  /** Last successfully reconciled ChatGPT binding (legacy field name). */
  connectorName?: string;
  desiredConnectorName?: string;
  boundMcpUrl?: string | null;
  connectorId?: string;
  bindingVersion?: 1;
  disconnected?: boolean;
  savedAt: string;
}

export function endpointFile(workspaceId: string): string {
  return path.join(getStateDir(), "endpoints", `${workspaceId}.json`);
}

export function readLastEndpoint(workspaceId: string): LastEndpoint | null {
  return readJsonIfExists<LastEndpoint>(endpointFile(workspaceId));
}

export function writeLastEndpoint(endpoint: Omit<LastEndpoint, "savedAt">): LastEndpoint {
  const saved: LastEndpoint = { ...endpoint, savedAt: new Date().toISOString() };
  writeSecureJson(endpointFile(saved.workspaceId), saved);
  return saved;
}

export function normalizePublicUrl(url: string): string {
  return url.trim().replace(/\/+$/, "").toLowerCase();
}

export function mcpUrlFromPublic(publicUrl: string | null | undefined): string | null {
  if (!publicUrl) return null;
  const base = normalizePublicUrl(publicUrl).replace(/\/mcp$/, "");
  return `${base}/mcp`;
}

/** What the Skill should do to THIS workspace's ChatGPT connector.
 *  `update` means the public address changed: Delete the old connector
 *  in ChatGPT, then create it again. Never click Reconnect (the old
 *  URL is dead and hangs on "This site cannot be reached"). */
export function connectorAction(
  previousMcpUrl: string | null | undefined,
  nextMcpUrl: string | null | undefined
): "none" | "create" | "update" {
  if (!nextMcpUrl) return "none";
  if (!previousMcpUrl) return "create";
  return normalizePublicUrl(previousMcpUrl) === normalizePublicUrl(nextMcpUrl) ? "none" : "update";
}

export function sanitizeConnectorLabel(name: string, workspaceId: string): string {
  const cleaned = name.replace(/[^\p{L}\p{N}._\- ]+/gu, "").replace(/\s+/g, " ").trim();
  return cleaned.slice(0, 40) || workspaceId.slice(0, 6);
}

/**
 * Names persist until explicitly changed by the user.
 * A workspace already recorded without a title stays on the original
 * "Codex with ChatGPT" name. A new workspace gets a distinct title.
 */
export function connectorNameFor(opts: {
  workspaceName: string;
  workspaceId: string;
  previousName?: string | null;
  hadEndpointBefore: boolean;
  explicitName?: string;
}): string {
  if (opts.explicitName !== undefined) return userFacingName(opts.explicitName, "Connector name");
  if (opts.previousName?.trim()) return opts.previousName.trim();
  if (opts.hadEndpointBefore) return LEGACY_CONNECTOR_NAME;
  return `${DEFAULT_CONNECTOR_NAME} · ${sanitizeConnectorLabel(opts.workspaceName, opts.workspaceId)}`;
}

/** Names survive address rotation, local-only setup, and display-name changes. */
export function persistWorkspaceEndpoint(opts: {
  workspaceId: string;
  workspaceName: string;
  port: number;
  publicUrl: string | null;
  mcpUrl: string | null;
  connectorName?: string;
  previous?: LastEndpoint | null;
}): string {
  const previous = opts.previous === undefined ? readLastEndpoint(opts.workspaceId) : opts.previous;
  const connectorName = connectorNameFor({
    workspaceName: opts.workspaceName,
    workspaceId: opts.workspaceId,
    previousName: previous?.desiredConnectorName ?? previous?.connectorName,
    hadEndpointBefore: Boolean(previous),
    explicitName: opts.connectorName,
  });
  const bound = boundConnector(previous);
  writeLastEndpoint({
    ...previous,
    workspaceId: opts.workspaceId,
    port: opts.port,
    publicUrl: opts.publicUrl,
    mcpUrl: opts.mcpUrl,
    desiredConnectorName: connectorName,
    connectorName: bound?.name,
    boundMcpUrl: bound?.mcpUrl ?? null,
    bindingVersion: 1,
    disconnected: false,
  });
  return connectorName;
}

export function reclaimUserMessage(connectorName: string): string {
  return `This project's ChatGPT connection needs reconciliation for "${connectorName}". I will verify its saved ID and address before any rename or delete; other projects' connections stay unchanged.`;
}

export function boundConnector(endpoint: LastEndpoint | null): { name: string; mcpUrl: string; id?: string } | null {
  if (!endpoint) return null;
  const url = endpoint.bindingVersion === 1 ? endpoint.boundMcpUrl : endpoint.mcpUrl;
  if (!url) return null;
  return { name: endpoint.connectorName ?? LEGACY_CONNECTOR_NAME, mcpUrl: url, id: endpoint.connectorId };
}

export function connectorReconciliation(endpoint: LastEndpoint | null) {
  const bound = boundConnector(endpoint);
  const name = endpoint?.desiredConnectorName ?? endpoint?.connectorName ?? (endpoint ? LEGACY_CONNECTOR_NAME : DEFAULT_CONNECTOR_NAME);
  const action = connectorAction(bound?.mcpUrl, endpoint?.mcpUrl);
  const renamed = Boolean(bound && bound.name !== name);
  return {
    needed: action !== "none" || renamed,
    connectorAction: renamed ? "update" as const : action,
    connectorName: name,
    previousConnectorName: bound?.name ?? null,
    connectorId: bound?.id ?? null,
    previousMcpUrl: bound?.mcpUrl ?? null,
    mcpUrl: endpoint?.mcpUrl ?? null,
  };
}

/** Explicit acknowledgement from the Skill after ChatGPT-side settings AND
 * workspace_info verification. Setup/restart/doctor never call this function. */
export function confirmConnectorBinding(workspaceId: string, opts: { name: string; mcpUrl: string; connectorId: string }): LastEndpoint {
  const endpoint = readLastEndpoint(workspaceId);
  if (!endpoint || endpoint.workspaceId !== workspaceId ||
      opts.name !== (endpoint.desiredConnectorName ?? endpoint.connectorName ?? LEGACY_CONNECTOR_NAME) ||
      !endpoint.mcpUrl || normalizePublicUrl(opts.mcpUrl) !== normalizePublicUrl(endpoint.mcpUrl)) {
    throw new Error("CONNECTOR_BINDING_CONFLICT: Verification does not match the current desired name and endpoint.");
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(opts.connectorId)) throw new Error("INVALID_CONNECTOR_ID");
  return writeLastEndpoint({ ...endpoint, bindingVersion: 1, connectorName: opts.name,
    boundMcpUrl: endpoint.mcpUrl, connectorId: opts.connectorId });
}
