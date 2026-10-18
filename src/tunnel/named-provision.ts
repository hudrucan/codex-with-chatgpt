import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findBinary } from "./detect.js";
import { hostnameSlug, suggestedNamedHostname } from "./hostname.js";
import { normalizeNamedTunnelHostname } from "./cloudflared-named.js";
import { CloudflareApi, assertDnsOwnership, type DnsRecord } from "./cloudflare-api.js";
import { userFacingName } from "../config/naming.js";
import {
  NAMED_FALLBACK_MESSAGE,
  readTunnelState,
  writeTunnelState,
  type TunnelState,
} from "./state.js";

const TUNNEL_ID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const TUNNEL_ID_FULL_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOGIN_TIMEOUT_MS = 5 * 60_000;
const COMMAND_TIMEOUT_MS = 45_000;
const MAX_CREDENTIAL_BYTES = 1024 * 1024;

export type NamedTunnelCredentialStatus =
  | "missing_tunnel_id"
  | "missing_account_certificate"
  | "missing_credentials"
  | "unreadable_credentials"
  | "invalid_credentials"
  | "mismatched_credentials"
  | "ready";

export interface NamedTunnelCredentialCheck {
  status: NamedTunnelCredentialStatus;
  /** Kept for local diagnostics and tests; callers must not serialize its contents. */
  credentialPath: string | null;
}

export interface ListedTunnel {
  id: string;
  name: string;
}

export interface CloudflaredAccount {
  hasCert(): boolean;
  login(): Promise<void>;
  listTunnels(): Promise<ListedTunnel[]>;
  createTunnel(name: string): Promise<ListedTunnel>;
  routeDns(tunnelName: string, hostname: string): Promise<void>;
  dns(zone: string, hostname: string): Promise<DnsRecord | null>;
  deleteDns(zone: string, hostname: string, tunnelId: string): Promise<void>;
  renameTunnel(zone: string, tunnelId: string, expectedName: string, name: string): Promise<void>;
  deleteTunnel(tunnel: ListedTunnel): Promise<void>;
}

export function cloudflaredCertPath(): string {
  const override = process.env.TUNNEL_ORIGIN_CERT?.trim();
  if (override) return override;
  return path.join(os.homedir(), ".cloudflared", "cert.pem");
}

export function hasCloudflaredCert(): boolean {
  try {
    return fs.statSync(cloudflaredCertPath()).isFile();
  } catch {
    return false;
  }
}

/**
 * Resolve the credential file cloudflared uses for a locally managed tunnel.
 * TUNNEL_CRED_FILE is the supported override; otherwise cloudflared's Windows
 * and Unix default directory is represented by ~/.cloudflared.
 */
export function cloudflaredCredentialPath(tunnelId: string): string | null {
  const normalized = tunnelId.trim();
  if (!TUNNEL_ID_FULL_RE.test(normalized)) return null;
  const override = process.env.TUNNEL_CRED_FILE?.trim();
  if (override) return path.resolve(override);
  return path.join(os.homedir(), ".cloudflared", `${normalized}.json`);
}

/**
 * Check the local prerequisites for running a named tunnel without exposing
 * credential contents. This is intentionally read-only: recovery belongs to
 * an explicit user action and is not part of doctor.
 */
export function inspectNamedTunnelCredentials(tunnelId?: string): NamedTunnelCredentialCheck {
  const credentialPath = cloudflaredCredentialPath(tunnelId ?? "");
  if (!credentialPath) return { status: "missing_tunnel_id", credentialPath: null };
  if (!hasCloudflaredCert()) return { status: "missing_account_certificate", credentialPath };

  let stat: fs.Stats;
  try {
    stat = fs.statSync(credentialPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      status: code === "ENOENT" || code === "ENOTDIR" ? "missing_credentials" : "unreadable_credentials",
      credentialPath,
    };
  }
  if (!stat.isFile() || stat.size > MAX_CREDENTIAL_BYTES) {
    return { status: "unreadable_credentials", credentialPath };
  }

  let raw: string;
  try {
    raw = fs.readFileSync(credentialPath, "utf8");
  } catch {
    return { status: "unreadable_credentials", credentialPath };
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return { status: "invalid_credentials", credentialPath };
    const record = parsed as { TunnelID?: unknown; TunnelSecret?: unknown };
    if (
      typeof record.TunnelID !== "string" ||
      !TUNNEL_ID_FULL_RE.test(record.TunnelID) ||
      typeof record.TunnelSecret !== "string" ||
      record.TunnelSecret.trim().length === 0
    ) {
      return { status: "invalid_credentials", credentialPath };
    }
    if (record.TunnelID.toLowerCase() !== tunnelId!.trim().toLowerCase()) {
      return { status: "mismatched_credentials", credentialPath };
    }
    return { status: "ready", credentialPath };
  } catch {
    return { status: "invalid_credentials", credentialPath };
  }
}

export function namedTunnelCredentialRepairMessage(status: NamedTunnelCredentialStatus): string {
  switch (status) {
    case "missing_account_certificate":
      return "The fixed hostname is missing its Cloudflare account certificate. Run cloudflared tunnel login, then c2c doctor.";
    case "missing_credentials":
      return "The fixed hostname is missing its tunnel credential file. Restore it with cloudflared tunnel token --cred-file \"%USERPROFILE%\\.cloudflared\\<TUNNEL-UUID>.json\" <TUNNEL-UUID>, then run c2c doctor.";
    case "unreadable_credentials":
      return "The tunnel credential file is unreadable or too large. Restore the correct UUID.json file and permissions, then run c2c doctor.";
    case "invalid_credentials":
      return "The tunnel credential file is not valid local tunnel JSON. Restore the correct file, then run c2c doctor.";
    case "mismatched_credentials":
      return "The tunnel credential does not match the saved Tunnel ID. Restore the matching UUID.json file, then run c2c doctor.";
    case "missing_tunnel_id":
      return "The fixed hostname's state is missing a Tunnel ID. Run c2c setup to restore the named tunnel state.";
    case "ready":
      return "Fixed-hostname credentials are ready.";
  }
}

export function parseTunnelList(output: string): ListedTunnel[] {
  const trimmed = output.trim();
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      const rows = Array.isArray(parsed) ? parsed : (parsed as { tunnels?: unknown }).tunnels;
      if (!Array.isArray(rows)) return [];
      return rows.flatMap((row) => {
        if (!row || typeof row !== "object") return [];
        const record = row as { id?: unknown; name?: unknown };
        if (typeof record.id !== "string" || typeof record.name !== "string") return [];
        return [{ id: record.id, name: record.name }];
      });
    } catch {
      // fall through to the table parser
    }
  }
  const found: ListedTunnel[] = [];
  for (const line of output.split(/\r?\n/)) {
    const id = line.match(TUNNEL_ID_RE)?.[0];
    if (!id) continue;
    const after = line.slice(line.indexOf(id) + id.length).trim();
    const name = after.split(/\s+/)[0];
    if (name && name !== "NAME") found.push({ id, name });
  }
  return found;
}

export function parseCreatedTunnel(output: string, name: string): ListedTunnel | null {
  const id = output.match(TUNNEL_ID_RE)?.[0];
  return id ? { id, name } : null;
}

export class TunnelNamingConflict extends Error {
  constructor(message: string) {
    super(`TUNNEL_NAMING_CONFLICT: ${message}`);
  }
}

export function normalizeTunnelName(value: string): string {
  const name = userFacingName(value, "Tunnel name");
  if (name.length > 128 || name.startsWith("-")) {
    throw new Error("INVALID_NAME: Tunnel name must be at most 128 characters and must not start with '-'.");
  }
  return name;
}

export class ProcessCloudflaredAccount implements CloudflaredAccount {
  constructor(private readonly binaryOverride?: string) {}

  private binary(): string {
    const bin = this.binaryOverride ?? findBinary("cloudflared");
    if (!bin) {
      throw new Error(
        "NEED_CLOUDFLARED: cloudflared is not installed. Install it first (macOS: brew install cloudflared)."
      );
    }
    return bin;
  }

  hasCert(): boolean {
    return hasCloudflaredCert();
  }

  async login(): Promise<void> {
    if (this.hasCert()) return;
    const bin = this.binary();
    await new Promise<void>((resolve, reject) => {
      const child = spawn(bin, ["tunnel", "login"], { stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      const collect = (chunk: Buffer): void => {
        output += chunk.toString("utf8");
      };
      child.stdout?.on("data", collect);
      child.stderr?.on("data", collect);
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error("Cloudflare login timed out"));
      }, LOGIN_TIMEOUT_MS);
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        if (this.hasCert()) {
          resolve();
          return;
        }
        reject(
          new Error(
            `Cloudflare login did not finish${code !== 0 ? ` (exit ${code})` : ""}${
              output.trim() ? `: ${output.trim().slice(0, 400)}` : ""
            }`
          )
        );
      });
    });
  }

  async listTunnels(): Promise<ListedTunnel[]> {
    const json = this.run(["tunnel", "list", "--output", "json"]);
    if (json.ok) {
      const parsed = parseTunnelList(json.stdout || json.stderr);
      if (parsed.length > 0 || (json.stdout || json.stderr).trim().startsWith("[")) return parsed;
    }
    const table = this.run(["tunnel", "list"]);
    if (!table.ok) throw new Error(table.stderr || table.stdout || "Unable to list Cloudflare tunnels");
    return parseTunnelList(`${table.stdout}\n${table.stderr}`);
  }

  async createTunnel(name: string): Promise<ListedTunnel> {
    const existing = (await this.listTunnels()).find((tunnel) => tunnel.name === name);
    if (existing) throw new TunnelNamingConflict(`Tunnel "${name}" already exists; its binding must be verified before reuse.`);
    const result = this.run(["tunnel", "create", name]);
    const created = result.ok ? parseCreatedTunnel(`${result.stdout}\n${result.stderr}`, name) : null;
    if (created) return created;
    if (/already exists/i.test(`${result.stdout}\n${result.stderr}`)) {
      throw new TunnelNamingConflict(`Tunnel "${name}" was created by another process. Retry after checking its binding.`);
    }
    throw new Error(result.stderr || result.stdout || `Unable to create tunnel ${name}`);
  }

  async routeDns(tunnelName: string, hostname: string): Promise<void> {
    const result = this.run(["tunnel", "route", "dns", tunnelName, hostname]);
    if (result.ok) return;
    if (/already exists|duplicate|exists as a cname/i.test(`${result.stdout}\n${result.stderr}`)) {
      throw new TunnelNamingConflict(`Hostname "${hostname}" already has a DNS route; it was not reassigned to "${tunnelName}".`);
    }
    throw new Error(result.stderr || result.stdout || `Unable to route ${hostname}`);
  }

  private readonly api = new CloudflareApi();

  dns(zone: string, hostname: string): Promise<DnsRecord | null> {
    return this.api.dns(zone, hostname);
  }

  deleteDns(zone: string, hostname: string, tunnelId: string): Promise<void> {
    return this.api.deleteDns(zone, hostname, tunnelId);
  }

  renameTunnel(zone: string, id: string, expectedName: string, name: string): Promise<void> {
    return this.api.renameTunnel(zone, id, expectedName, name);
  }

  async deleteTunnel(tunnel: ListedTunnel): Promise<void> {
    const rows = await this.listTunnels();
    const current = rows.find((row) => row.id === tunnel.id);
    if (!current) {
      if (rows.some((row) => row.name === tunnel.name)) throw new TunnelNamingConflict("Saved tunnel name now belongs to a different ID.");
      return;
    }
    if (current.name !== tunnel.name) throw new TunnelNamingConflict("Saved tunnel ID now has a different name.");
    const result = this.run(["tunnel", "delete", tunnel.id]);
    if (!result.ok) throw new Error("Tunnel deletion failed; state retained. Stop active tunnel connections and retry.");
  }

  private run(args: string[]): { ok: boolean; stdout: string; stderr: string } {
    const result = spawnSync(this.binary(), args, {
      encoding: "utf8",
      timeout: COMMAND_TIMEOUT_MS,
      windowsHide: true,
    });
    return {
      ok: result.status === 0,
      stdout: (result.stdout ?? "").trim(),
      stderr: (result.stderr ?? "").trim(),
    };
  }
}

export interface ProvisionNamedResult {
  ok: boolean;
  state: TunnelState;
  fallback: boolean;
  userMessage?: string;
  error?: string;
}

export async function provisionNamedTunnel(opts: {
  hubId: string;
  hubName: string;
  zone?: string;
  hostname?: string;
  tunnelName?: string;
  account?: CloudflaredAccount;
}): Promise<ProvisionNamedResult> {
  const account = opts.account ?? new ProcessCloudflaredAccount();
  let previous = readTunnelState(opts.hubId);
  if (previous.hubId !== opts.hubId) return { ok: false, state: previous, fallback: false, error: "OWNERSHIP_CONFLICT: Saved tunnel belongs to another Hub." };
  if (previous.pending) {
    try {
      previous = await rollbackNamedTunnel(previous, account);
    } catch (error) {
      return { ok: false, state: previous, fallback: false, error: `TUNNEL_ROLLBACK_PENDING: ${(error as Error).message}` };
    }
  }
  let hostname: string;
  let tunnelName: string;
  let zone: string;
  try {
    zone = normalizeNamedTunnelHostname(opts.zone ?? previous.zone ?? "");
    tunnelName = normalizeTunnelName(opts.tunnelName ?? previous.tunnelName ?? hostnameSlug(opts.hubName, opts.hubId));
    hostname = normalizeNamedTunnelHostname(
      opts.hostname ?? previous.hostname ?? suggestedNamedHostname(zone, opts.hubName, opts.hubId)
    );
    if (hostname !== zone && !hostname.endsWith(`.${zone}`)) {
      throw new Error(`INVALID_HOSTNAME: "${hostname}" must belong to "${zone}".`);
    }
  } catch (error) {
    return { ok: false, state: previous, fallback: false, error: (error as Error).message };
  }

  let staged: TunnelState | undefined;
  try {
    if (!account.hasCert()) await account.login();
    const tunnels = await account.listTunnels();
    const owned = previous.tunnelId ? tunnels.find((tunnel) => tunnel.id === previous.tunnelId) : undefined;
    const existing = tunnels.find((tunnel) => tunnel.name === tunnelName);
    if (existing && existing.id !== previous.tunnelId) {
      throw new TunnelNamingConflict(`Tunnel "${tunnelName}" exists but does not match this Hub's saved Tunnel ID.`);
    }
    if (previous.tunnelId && (!owned || owned.name !== previous.tunnelName)) {
      throw new TunnelNamingConflict("Saved tunnel is missing or no longer matches its saved name. Restore the existing resource before retrying.");
    }
    const changedHost = Boolean(owned && (previous.hostname !== hostname || previous.zone !== zone));
    const changedName = Boolean(owned && owned.name !== tunnelName);
    if (changedHost || changedName) {
      if (!previous.zone || !previous.hostname) throw new Error("OWNERSHIP_CONFLICT: Legacy tunnel needs its saved zone and hostname before rename.");
      const oldDns = await account.dns(previous.zone, previous.hostname);
      if (!oldDns) throw new Error("OWNERSHIP_CONFLICT: Saved DNS route is missing before rename.");
      assertDnsOwnership(oldDns, owned!.id);
      if (changedHost && await account.dns(zone, hostname)) throw new TunnelNamingConflict(`Hostname "${hostname}" already has a DNS record.`);
    }
    if (owned && !changedHost && !changedName && previous.preference === "named") return { ok: true, state: previous, fallback: false };
    // Write intent before remote mutations. In-place rename retains the UUID and
    // credentials, so a DNS failure can never orphan a replacement tunnel.
    staged = writeTunnelState({ ...previous, pending: {
      tunnelId: owned?.id, tunnelName, hostname, zone, created: !owned,
    } });
    const tunnel = owned ?? await account.createTunnel(tunnelName);
    staged = writeTunnelState({ ...staged, pending: { ...staged.pending!, tunnelId: tunnel.id } });
    if (tunnel.name !== (owned?.name ?? tunnelName)) throw new TunnelNamingConflict("Cloudflare returned an unexpected tunnel name.");
    if (changedName) await account.renameTunnel(previous.zone!, tunnel.id, owned!.name, tunnelName);
    if (!owned || changedHost) await account.routeDns(tunnel.id, hostname);
    if (changedHost) await account.deleteDns(previous.zone!, previous.hostname!, tunnel.id);
    const state = writeTunnelState({
      hubId: opts.hubId, preference: "named", askedAt: new Date().toISOString(),
      provider: "cloudflare-named", tunnelName, tunnelId: tunnel.id, hostname, zone,
      configuredAt: new Date().toISOString(),
    });
    return { ok: true, state, fallback: false };
  } catch (error) {
    if (staged) {
      try { await rollbackNamedTunnel(staged, account); }
      catch (rollbackError) {
        return { ok: false, state: readTunnelState(opts.hubId), fallback: false,
          error: `TUNNEL_ROLLBACK_PENDING: ${(error as Error).message}; ${(rollbackError as Error).message}` };
      }
    }
    if (staged || error instanceof TunnelNamingConflict || opts.tunnelName !== undefined || opts.hostname !== undefined || previous.tunnelName) {
      return { ok: false, state: previous, fallback: false, error: (error as Error).message };
    }
    return fallbackState(opts.hubId, "provision_failed", (error as Error).message);
  }
}

/** Retry rollback before accepting another provisioning request. Never forget a
 * partially completed remote operation, even when cleanup also fails. */
export async function rollbackNamedTunnel(state: TunnelState, account: CloudflaredAccount): Promise<TunnelState> {
  if (JSON.stringify(readTunnelState(state.hubId)) !== JSON.stringify(state)) {
    throw new Error("TUNNEL_STATE_CONFLICT: Rollback must match the owning Hub's persisted journal.");
  }
  const pending = state.pending;
  if (!pending) return state;
  if (!pending.tunnelId) throw new Error(`Creation outcome for "${pending.tunnelName}" is uncertain; verify Cloudflare ownership manually before recovery.`);
  const rows = await account.listTunnels();
  const current = rows.find((row) => row.id === pending.tunnelId);
  if (current && current.name !== pending.tunnelName && current.name !== state.tunnelName) throw new Error("OWNERSHIP_CONFLICT: Pending tunnel was renamed externally.");
  if (pending.created || pending.hostname !== state.hostname || pending.zone !== state.zone) {
    await account.deleteDns(pending.zone, pending.hostname, pending.tunnelId);
  }
  if (pending.created) await account.deleteTunnel({ id: pending.tunnelId, name: pending.tunnelName });
  else {
    if (!current) throw new Error("OWNERSHIP_CONFLICT: Original tunnel disappeared during rollback.");
    if (current.name !== state.tunnelName) await account.renameTunnel(state.zone!, current.id, current.name, state.tunnelName!);
    const dns = await account.dns(state.zone!, state.hostname!);
    if (dns) assertDnsOwnership(dns, current.id);
    else await account.routeDns(current.id, state.hostname!);
  }
  const { pending: _pending, ...previous } = state;
  return writeTunnelState(previous);
}

export function chooseQuickTunnel(hubId: string, fallbackReason?: string): TunnelState {
  const previous = readTunnelState(hubId);
  if (previous.pending) throw new Error("TUNNEL_ROLLBACK_PENDING: Resolve the pending operation before switching connection type.");
  return writeTunnelState({
    ...previous,
    hubId,
    preference: "quick",
    askedAt: new Date().toISOString(),
    provider: "cloudflare-quick",
    fallbackReason,
  });
}

function fallbackState(hubId: string, reason: string, error: string): ProvisionNamedResult {
  const state = chooseQuickTunnel(hubId, reason);
  return {
    ok: true,
    state,
    fallback: true,
    userMessage: NAMED_FALLBACK_MESSAGE,
    error,
  };
}
