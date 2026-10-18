import path from "node:path";
import { z } from "zod";
import { hubIdSchema } from "../hub/store.js";
import { resourceFile, withHubResource } from "../hub/resource-state.js";
import { getStateDir, readJsonIfExists } from "./paths.js";
import { userFacingName } from "./naming.js";

export const CHATGPT_DEVELOPER_MODE_URL = "https://chatgpt.com/#settings/Security";
export const CHATGPT_PLUGINS_URL = "https://chatgpt.com/plugins";
export const CHATGPT_CREATE_CONNECTOR_URL =
  "https://chatgpt.com/settings/plugins-settings";

export const DEFAULT_CONNECTOR_NAME = "Desk C2C Hub";
export const LEGACY_CONNECTOR_NAME = "Codex with ChatGPT";

const fields = {
  port: z.number().int().min(0).max(65535),
  publicUrl: z.string().nullable(),
  mcpUrl: z.string().nullable(),
  connectorName: z.string().optional(),
  desiredConnectorName: z.string().optional(),
  boundMcpUrl: z.string().nullable().optional(),
  connectorId: z.string().optional(),
  bindingVersion: z.literal(1).optional(),
  disconnected: z.boolean().optional(),
  savedAt: z.string().datetime(),
};
const legacySchema = z.object({ workspaceId: z.string().regex(/^[a-f0-9]{12}$/), ...fields }).strict();
const schema = z.object({ version: z.literal(1), hubId: hubIdSchema, ...fields }).strict();
const emptySchema = z.object({ version: z.literal(1), hubId: hubIdSchema, empty: z.literal(true) }).strict();
const stateSchema = z.union([schema, emptySchema]);
export type LastEndpoint = z.infer<typeof schema>;
const fieldsSchema = z.object(fields);
type EndpointBinding = z.infer<typeof fieldsSchema>;

export function endpointFile(hubId: string): string { return resourceFile("endpoint", hubId); }

export function readLastEndpoint(hubId: string): LastEndpoint | null {
  return withHubResource(hubId, "endpoint", stateSchema, legacySchema, { version: 1, hubId, empty: true },
    (current) => "empty" in current ? null : current);
}

export function writeLastEndpoint(endpoint: Omit<LastEndpoint, "savedAt" | "version"> & { version?: 1; savedAt?: string }): LastEndpoint {
  return withHubResource(endpoint.hubId, "endpoint", stateSchema, legacySchema, { version: 1, hubId: endpoint.hubId, empty: true },
    (_current, save) => schema.parse(save({ ...endpoint, version: 1, savedAt: new Date().toISOString() })));
}

/** Read-only compatibility for the existing legacy destroy path. */
export function legacyEndpointFile(owner: string): string { return path.join(getStateDir(), "endpoints", `${owner}.json`); }
export function readLegacyEndpoint(owner: string): z.infer<typeof legacySchema> | null {
  return readJsonIfExists<z.infer<typeof legacySchema>>(legacyEndpointFile(owner));
}

export function normalizePublicUrl(url: string): string {
  return url.trim().replace(/\/+$/, "").toLowerCase();
}

export function mcpUrlFromPublic(publicUrl: string | null | undefined): string | null {
  if (!publicUrl) return null;
  const base = normalizePublicUrl(publicUrl).replace(/\/mcp$/, "");
  return `${base}/mcp`;
}

/** What the Skill should do to this Hub's ChatGPT connector.
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

export function sanitizeConnectorLabel(name: string): string {
  const cleaned = name.replace(/[^\p{L}\p{N}._\- ]+/gu, "").replace(/\s+/g, " ").trim();
  return cleaned.slice(0, 40) || "Hub";
}

/**
 * Names persist until explicitly changed by the user.
 * An existing binding without a title keeps its default name.
 * A new Hub uses its display label.
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
  return `${DEFAULT_CONNECTOR_NAME} · ${sanitizeConnectorLabel(opts.workspaceName)}`;
}

/** Names survive address rotation, local-only setup, and display-name changes. */
export function persistHubEndpoint(opts: {
  hubId: string;
  hubName: string;
  port: number;
  publicUrl: string | null;
  mcpUrl: string | null;
  connectorName?: string;
  previous?: LastEndpoint | null;
}): string {
  const previous = opts.previous === undefined ? readLastEndpoint(opts.hubId) : opts.previous;
  if (previous && previous.hubId !== opts.hubId) throw new Error("CONNECTOR_BINDING_CONFLICT: Endpoint belongs to another Hub.");
  const connectorName = connectorNameFor({
    workspaceName: opts.hubName,
    workspaceId: opts.hubId,
    previousName: previous?.desiredConnectorName ?? previous?.connectorName,
    hadEndpointBefore: Boolean(previous),
    explicitName: opts.connectorName,
  });
  const bound = boundConnector(previous);
  writeLastEndpoint({
    ...previous,
    hubId: opts.hubId,
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

export function boundConnector(endpoint: EndpointBinding | null): { name: string; mcpUrl: string; id?: string } | null {
  if (!endpoint) return null;
  const url = endpoint.bindingVersion === 1 ? endpoint.boundMcpUrl : endpoint.mcpUrl;
  if (!url) return null;
  return { name: endpoint.connectorName ?? LEGACY_CONNECTOR_NAME, mcpUrl: url, id: endpoint.connectorId };
}

export function connectorReconciliation(endpoint: EndpointBinding | null) {
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
 * registered workspace_info verification. Setup/restart/doctor never call this function. */
export function confirmConnectorBinding(hubId: string, opts: { name: string; mcpUrl: string; connectorId: string }): LastEndpoint {
  const endpoint = readLastEndpoint(hubId);
  if (!endpoint || endpoint.hubId !== hubId ||
      opts.name !== (endpoint.desiredConnectorName ?? endpoint.connectorName ?? LEGACY_CONNECTOR_NAME) ||
      !endpoint.mcpUrl || normalizePublicUrl(opts.mcpUrl) !== normalizePublicUrl(endpoint.mcpUrl)) {
    throw new Error("CONNECTOR_BINDING_CONFLICT: Verification does not match the current desired name and endpoint.");
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(opts.connectorId)) throw new Error("INVALID_CONNECTOR_ID");
  return writeLastEndpoint({ ...endpoint, bindingVersion: 1, connectorName: opts.name,
    boundMcpUrl: endpoint.mcpUrl, connectorId: opts.connectorId });
}
