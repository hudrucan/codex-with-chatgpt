import { z } from "zod";
import { PRODUCT_NAME } from "../version.js";
import { hubIdSchema } from "../hub/store.js";
import { inspectHubResource, resourceFile, withHubResource } from "../hub/resource-state.js";
import { userFacingName } from "./naming.js";

export const CHATGPT_DEVELOPER_MODE_URL = "https://chatgpt.com/#settings/Security";
export const CHATGPT_PLUGINS_URL = "https://chatgpt.com/plugins";
export const CHATGPT_CREATE_CONNECTOR_URL =
  "https://chatgpt.com/settings/plugins-settings";

export const DEFAULT_CONNECTOR_NAME = PRODUCT_NAME;

const fields = {
  port: z.number().int().min(0).max(65535),
  publicUrl: z.string().nullable(),
  mcpUrl: z.string().nullable(),
  connectorName: z.string().optional(),
  desiredConnectorName: z.string().optional(),
  boundMcpUrl: z.string().nullable().optional(),
  connectorId: z.string().optional(),
  bindingVersion: z.literal(1),
  disconnected: z.boolean().optional(),
  savedAt: z.string().datetime(),
};
export const endpointSchema = z.object({ version: z.literal(1), hubId: hubIdSchema, ...fields }).strict();
const emptySchema = z.object({ version: z.literal(1), hubId: hubIdSchema, empty: z.literal(true) }).strict();
export const endpointStateSchema = z.union([endpointSchema, emptySchema]);
export type LastEndpoint = z.infer<typeof endpointSchema>;
type EndpointBinding = Omit<LastEndpoint, "version" | "hubId">;

export function endpointFile(hubId: string): string { return resourceFile("endpoint", hubId); }

export function readLastEndpoint(hubId: string): LastEndpoint | null {
  return withHubResource(hubId, "endpoint", endpointStateSchema,
    (current) => "empty" in current ? null : current);
}

export function inspectLastEndpoint(hubId: string): LastEndpoint | null {
  const current = inspectHubResource(hubId, "endpoint", endpointStateSchema);
  return "empty" in current ? null : current;
}

export function writeLastEndpoint(endpoint: Omit<LastEndpoint, "savedAt" | "version"> & { version?: 1; savedAt?: string }): LastEndpoint {
  return withHubResource(endpoint.hubId, "endpoint", endpointStateSchema,
    (_current, save) => endpointSchema.parse(save({ ...endpoint, version: 1, savedAt: new Date().toISOString() })));
}

export function normalizePublicUrl(url: string): string {
  return url.trim().replace(/\/+$/, "").toLowerCase();
}

export function mcpUrlFromPublic(publicUrl: string | null | undefined): string | null {
  if (!publicUrl) return null;
  const base = normalizePublicUrl(publicUrl).replace(/\/mcp$/, "");
  return `${base}/mcp`;
}

/** Classify endpoint changes; `update` requires explicit connector reconciliation. */
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
 * A new Hub uses its display label.
 */
export function connectorNameFor(opts: {
  hubName: string;
  previousName?: string | null;
  explicitName?: string;
}): string {
  if (opts.explicitName !== undefined) return userFacingName(opts.explicitName, "Connector name");
  if (opts.previousName?.trim()) return opts.previousName.trim();
  return `${DEFAULT_CONNECTOR_NAME} · ${sanitizeConnectorLabel(opts.hubName)}`;
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
    hubName: opts.hubName,
    previousName: previous?.desiredConnectorName ?? previous?.connectorName,
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
  return `This Hub's ChatGPT connection needs reconciliation for "${connectorName}". I will verify its saved ID and address before any rename or delete; other Hubs' connections stay unchanged.`;
}

export function boundConnector(endpoint: EndpointBinding | null): { name: string; mcpUrl: string; id?: string } | null {
  if (!endpoint) return null;
  const url = endpoint.boundMcpUrl;
  if (!url) return null;
  if (!endpoint.connectorName) throw new Error("CONNECTOR_BINDING_CONFLICT: Bound connector name is missing.");
  return { name: endpoint.connectorName, mcpUrl: url, id: endpoint.connectorId };
}

export function connectorReconciliation(endpoint: EndpointBinding | null) {
  const bound = boundConnector(endpoint);
  const name = endpoint?.desiredConnectorName ?? endpoint?.connectorName ?? DEFAULT_CONNECTOR_NAME;
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
      opts.name !== (endpoint.desiredConnectorName ?? endpoint.connectorName) ||
      !endpoint.mcpUrl || normalizePublicUrl(opts.mcpUrl) !== normalizePublicUrl(endpoint.mcpUrl)) {
    throw new Error("CONNECTOR_BINDING_CONFLICT: Verification does not match the current desired name and endpoint.");
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(opts.connectorId)) throw new Error("INVALID_CONNECTOR_ID");
  return writeLastEndpoint({ ...endpoint, bindingVersion: 1, connectorName: opts.name,
    boundMcpUrl: endpoint.mcpUrl, connectorId: opts.connectorId });
}
