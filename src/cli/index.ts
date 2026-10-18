import { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startBridge } from "../bridge/server.js";
import { findBridgeObservation, findLiveBridge, type RuntimeState } from "../bridge/runtime.js";
import { adminFetch, ensureBridge, stopBridge } from "../process/daemon.js";
import { Workspace } from "../workspace/manager.js";
import { resolveHub } from "../hub/store.js";
import { WorkspaceRegistry } from "../workspace/registry.js";
import { AuthStore } from "../auth/store.js";
import { detectTunnelBinaries } from "../tunnel/detect.js";
import {
  chooseQuickTunnel,
  hasCloudflaredCert,
  inspectNamedTunnelCredentials,
  namedTunnelCredentialRepairMessage,
  ProcessCloudflaredAccount,
  provisionNamedTunnel,
  normalizeTunnelName,
} from "../tunnel/named-provision.js";
import { normalizeNamedTunnelHostname } from "../tunnel/cloudflared-named.js";
import { parseZoneInput, suggestedNamedHostname } from "../tunnel/hostname.js";
import {
  isNamedTunnelReady,
  NAMED_LOGIN_PROMPT,
  NAMED_REPAIR_MESSAGE,
  needsTunnelChoice,
  readTunnelState,
  TUNNEL_CHOICE_PROMPT,
} from "../tunnel/state.js";
import { Logger } from "../logger/index.js";
import { getStateDir } from "../config/paths.js";
import { saveWorkspaceDisplayName, userFacingName } from "../config/naming.js";
import { ensureSandboxAllowlist, getCodexConfigPath, isStateDirAllowlisted } from "../config/sandbox-allow.js";
import { mergeUiPrefs, readUiPrefs, SETUP_MODES, type SetupMode } from "../config/ui-prefs.js";
import {
  DEFAULT_CONNECTOR_NAME,
  CHATGPT_CREATE_CONNECTOR_URL,
  CHATGPT_DEVELOPER_MODE_URL,
  CHATGPT_PLUGINS_URL,
  connectorReconciliation,
  confirmConnectorBinding,
  boundConnector,
  connectorNameFor,
  mcpUrlFromPublic,
  normalizePublicUrl,
  persistWorkspaceEndpoint,
  readLastEndpoint,
  reclaimUserMessage,
} from "../config/endpoint.js";
import { pullFork, verifyForkOrigin } from "../config/update.js";
import { acquireWorkspaceLock, destroyWorkspace, disconnectWorkspace, lifecycleFile } from "../lifecycle/workspace.js";
import { PRODUCT_NAME, VERSION } from "../version.js";

// Leave child options with their subcommand (workspace and workspace add share -w).
const program = new Command().enablePositionalOptions();

const say = (msg: string): void => {
  process.stdout.write(msg + "\n");
};
const check = (msg: string): void => say(`✓ ${msg}`);
const cross = (msg: string): void => say(`✗ ${msg}`);

function resolveWorkspace(option?: string): string {
  return path.resolve(option ?? process.cwd());
}

function tunnelChoicePayload(workspace: Workspace, zoneHint?: string): Record<string, unknown> {
  const state = readTunnelState(workspace.id);
  const zone = parseZoneInput(zoneHint ?? "") ?? state.zone ?? null;
  return {
    ok: true,
    needsChoice: needsTunnelChoice(state),
    preference: state.preference,
    loggedIn: hasCloudflaredCert(),
    namedReady: isNamedTunnelReady(state),
    zone,
    tunnelName: state.tunnelName ?? null,
    hostname: state.hostname ?? null,
    suggestedHostname: zone ? suggestedNamedHostname(zone, workspace.name, workspace.id) : null,
    userPrompt: needsTunnelChoice(state) ? TUNNEL_CHOICE_PROMPT : undefined,
    loginPrompt: NAMED_LOGIN_PROMPT,
    fallbackReason: state.fallbackReason,
  };
}

function trySandboxAllow():
  | { ok: true; added: boolean; alreadyAllowed: boolean; stateDir: string; configPath: string }
  | { ok: false; added: false; alreadyAllowed: false; error: string } {
  try {
    const result = ensureSandboxAllowlist();
    return { ok: true, ...result };
  } catch (error) {
    return { ok: false, added: false, alreadyAllowed: false, error: (error as Error).message };
  }
}

interface TunnelStartResponse {
  url?: string;
  error?: string;
  message?: string;
}

interface PairingResponse {
  code: string;
  expiresAt: number;
}

interface AdminInfo {
  hubId?: string;
  workspaceId: string;
  workspaceName: string;
  workspaceRoot: string;
  port: number;
  publicUrl: string | null;
  tunnel: { running: boolean; url: string | null; provider: string };
  tokenCount: number;
  pairingActive: boolean;
  pid: number;
  startedAt: string;
}

async function ensureBridgeAndTunnel(
  workspaceRoot: string,
  opts: { tunnel: boolean }
): Promise<{ runtime: RuntimeState; info: AdminInfo; mcpUrl: string | null }> {
  const { runtime } = await ensureBridge(workspaceRoot);
  let info = await adminFetch<AdminInfo>(runtime, "GET", "/admin/info");
  const configuredName = new Workspace(workspaceRoot).name;
  if (info.workspaceName !== configuredName) {
    throw new Error(
      `WORKSPACE_NAME_RESTART_REQUIRED: Running name "${info.workspaceName}" differs from configured name "${configuredName}". ` +
      "Run c2c restart (with --tunnel to restore the public connection), then retry setup. Auth and workspace identity are retained."
    );
  }
  let mcpUrl: string | null = info.publicUrl ? `${info.publicUrl}/mcp` : null;
  if (opts.tunnel && !info.publicUrl) {
    const binaries = detectTunnelBinaries();
    if (!binaries.cloudflared) {
      throw new Error(
        "NEED_CLOUDFLARED: cloudflared is not installed. Install it first (macOS: brew install cloudflared)."
      );
    }
    const result = await adminFetch<TunnelStartResponse>(runtime, "POST", "/admin/tunnel/start", 90_000);
    if (!result.url) throw new Error(result.message ?? "Tunnel start failed");
    info = await adminFetch<AdminInfo>(runtime, "GET", "/admin/info");
    mcpUrl = `${result.url}/mcp`;
  }
  return { runtime, info, mcpUrl };
}

program
  .name("c2c")
  .description(`${PRODUCT_NAME} — Secure read-only workspace access for ChatGPT.`)
  .version(VERSION, "-v, --version")
  .configureHelp({ sortSubcommands: true });

let releaseLifecycleLock: (() => void) | undefined;
program.hook("preAction", (_command, action) => {
  const name = action.name();
  if (!["setup", "start", "restart", "doctor", "choose", "bind", "disconnect", "unpair", "destroy"].includes(name)) return;
  const workspace = new Workspace(resolveWorkspace(action.opts().workspace));
  releaseLifecycleLock = acquireWorkspaceLock(workspace.id);
  if (["start", "restart", "bind"].includes(name) && readTunnelState(workspace.id).pending) throw new Error("TUNNEL_ROLLBACK_PENDING: Recover the named setup operation first.");
  if (name !== "destroy" && fs.existsSync(lifecycleFile(workspace.id))) throw new Error("DESTROY_PENDING: Finish destroy before starting or reconciling this workspace.");
});
program.hook("postAction", () => { releaseLifecycleLock?.(); releaseLifecycleLock = undefined; });
process.on("exit", () => { releaseLifecycleLock?.(); });

/** Machine-wide commands ignore `-w` so a Skill that always passes it cannot crash them. */
function acceptUnusedWorkspaceOption(command: Command): Command {
  return command.option("-w, --workspace <path>", "ignored; this command is machine-wide");
}

// ---------------------------------------------------------------- serve (internal)

program
  .command("serve", { hidden: true })
  .description("Run the bridge in the foreground (internal)")
  .requiredOption("--workspace <path>")
  .option("--port <port>", "preferred port")
  .action(async (opts: { workspace: string; port?: string }) => {
    const logger = new Logger({ name: "bridge", console: true });
    const bridge = await startBridge({
      workspaceRoot: resolveWorkspace(opts.workspace),
      port: opts.port ? parseInt(opts.port, 10) : undefined,
      logger,
    });
    const shutdown = (): void => {
      void bridge.close().then(() => process.exit(0));
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    say(`bridge ready on ${bridge.localBaseUrl()} (workspace ${bridge.workspace.name})`);
  });

// ---------------------------------------------------------------- start

program
  .command("start")
  .description("Start (or reuse) the bridge for this workspace")
  .option("-w, --workspace <path>", "workspace root (defaults to current directory)")
  .option("--tunnel", "also establish the secure public connection", false)
  .option("--json", "machine-readable output", false)
  .action(async (opts: { workspace?: string; tunnel: boolean; json: boolean }) => {
    const root = resolveWorkspace(opts.workspace);
    try {
      const { runtime, info, mcpUrl } = await ensureBridgeAndTunnel(root, { tunnel: opts.tunnel });
      const previous = readLastEndpoint(info.workspaceId);
      const connectorName = persistWorkspaceEndpoint({
        workspaceId: info.workspaceId, workspaceName: info.workspaceName, port: runtime.port,
        publicUrl: info.publicUrl ?? previous?.publicUrl ?? null,
        mcpUrl: mcpUrl ?? previous?.mcpUrl ?? null,
      });
      if (opts.json) {
        say(JSON.stringify({ ok: true, port: runtime.port, workspaceId: info.workspaceId, mcpUrl, connectorName }));
        return;
      }
      check(`Workspace detected(${info.workspaceName})`);
      check("Workspace Bridge started");
      if (mcpUrl) check("Secure connection established");
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

// ---------------------------------------------------------------- setup

interface SetupOptions {
  workspace?: string;
  workspaceName?: string;
  connectorName?: string;
  tunnelName?: string;
  hostname?: string;
  zone?: string;
  tunnel: boolean;
  json: boolean;
}

async function configureSetupNames(root: string, opts: SetupOptions): Promise<void> {
  if (opts.connectorName !== undefined) userFacingName(opts.connectorName, "Connector name");
  if (opts.tunnelName !== undefined) normalizeTunnelName(opts.tunnelName);
  if (opts.hostname !== undefined) normalizeNamedTunnelHostname(opts.hostname);
  const configureNamed = opts.tunnelName !== undefined || opts.hostname !== undefined || opts.zone !== undefined || Boolean(readTunnelState(new Workspace(root).id).pending);
  if (configureNamed && !opts.tunnel) {
    throw new Error("NAMING_CONFLICT: Named tunnel options cannot be combined with --no-tunnel.");
  }
  let workspace = new Workspace(root);
  if (opts.workspaceName !== undefined) {
    saveWorkspaceDisplayName(workspace, opts.workspaceName);
    workspace = new Workspace(root);
  }
  if (!configureNamed) return;
  const previous = readTunnelState(workspace.id);
  const result = await provisionNamedTunnel({
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    tunnelName: opts.tunnelName,
    hostname: opts.hostname,
    zone: opts.zone,
  });
  if (!result.ok || result.fallback) throw new Error(result.error ?? "Named tunnel provisioning failed.");
  if (previous.preference !== result.state.preference || previous.tunnelName !== result.state.tunnelName || previous.hostname !== result.state.hostname) {
    if (await findLiveBridge(resolveHub(workspace).hubId)) {
      await stopBridge(root);
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  }
}

program
  .command("setup")
  .description("First-time setup: bridge + secure connection + pairing code")
  .option("-w, --workspace <path>")
  .option("--no-tunnel", "local-only setup (development)")
  .option("--workspace-name <name>", "save the local display name in external C2C workspace state")
  .option("--connector-name <name>", "save the exact ChatGPT connector display name")
  .option("--tunnel-name <name>", "Cloudflare Named Tunnel resource name (uses the saved zone unless --zone is given)")
  .option("--hostname <hostname>", "fixed hostname (uses the saved zone unless --zone is given)")
  .option("--zone <domain>", "Cloudflare domain; provision a named tunnel")
  .option("--json", "machine-readable output", false)
  .action(async (opts: SetupOptions) => {
    const root = resolveWorkspace(opts.workspace);
    try {
      if (!opts.json) {
        say(PRODUCT_NAME);
        say("");
        say("Connecting ChatGPT...");
        say("");
      }
      await configureSetupNames(root, opts);
      const sandbox = trySandboxAllow();
      const { runtime, info, mcpUrl } = await ensureBridgeAndTunnel(root, { tunnel: opts.tunnel });
      const previousEndpoint = readLastEndpoint(info.workspaceId);
      const connectorName = persistWorkspaceEndpoint({
        workspaceId: info.workspaceId,
        workspaceName: info.workspaceName,
        port: runtime.port,
        publicUrl: mcpUrl ? info.publicUrl : previousEndpoint?.publicUrl ?? null,
        mcpUrl: mcpUrl ?? previousEndpoint?.mcpUrl ?? null,
        connectorName: opts.connectorName,
      });
      const pairingResult = await adminFetch<PairingResponse>(runtime, "POST", "/admin/pairing");
      const tunnelState = readTunnelState(info.workspaceId);
      if (opts.json) {
        say(
          JSON.stringify({
            ok: true,
            workspaceId: info.workspaceId,
            workspaceName: info.workspaceName,
            ...connectorReconciliation(readLastEndpoint(info.workspaceId)),
            mcpUrl: mcpUrl ?? `http://127.0.0.1:${runtime.port}/mcp`,
            local: mcpUrl === null,
            pairingCode: pairingResult.code,
            pairingExpiresAt: pairingResult.expiresAt,
            sandbox,
            tunnel: {
              mode: isNamedTunnelReady(tunnelState) ? "named" : "quick",
              name: tunnelState.tunnelName ?? null,
              hostname: tunnelState.hostname ?? null,
              fallback: Boolean(tunnelState.fallbackReason),
            },
          })
        );
        return;
      }
      check(`Workspace detected(${info.workspaceName})`);
      check("Workspace Bridge started");
      if (mcpUrl) check("Secure connection established");
      say("");
      say(`Connection address: ${mcpUrl ?? `http://127.0.0.1:${runtime.port}/mcp`}`);
      say(`Pairing code: ${pairingResult.code}(${Math.round((pairingResult.expiresAt - Date.now()) / 60000)} minutes remaining)`);
      say("");
      say("Next: add this address in ChatGPT connector settings (OAuth), then enter the pairing code on the authorization page.");
      say("The Codex Skill completes this step automatically.");
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

const connectorCmd = program.command("connector").description("Acknowledge verified ChatGPT-side reconciliation");
connectorCmd.command("bind")
  .option("-w, --workspace <path>")
  .requiredOption("--name <name>")
  .requiredOption("--mcp-url <url>")
  .requiredOption("--connector-id <id>", "exact plugin ID observed in ChatGPT settings")
  .requiredOption("--verified-workspace <id>", "workspace_info ID observed through this connector")
  .option("--json", "machine-readable output", false)
  .action((opts: { workspace?: string; name: string; mcpUrl: string; connectorId: string; verifiedWorkspace: string; json: boolean }) => {
    try {
      const workspace = new Workspace(resolveWorkspace(opts.workspace));
      if (workspace.id !== opts.verifiedWorkspace) throw new Error("CONNECTOR_BINDING_CONFLICT: workspace_info belongs to another workspace.");
      const bound = confirmConnectorBinding(workspace.id, opts);
      if (opts.json) say(JSON.stringify({ ok: true, ...connectorReconciliation(bound) }));
      else check("Committed the verified ChatGPT connector binding");
    } catch (error) { handleCliError(error, opts.json); }
  });

// ---------------------------------------------------------------- stop / restart

program
  .command("stop")
  .description("Stop the bridge for this workspace")
  .option("-w, --workspace <path>")
  .action(async (opts: { workspace?: string }) => {
    const stopped = await stopBridge(resolveWorkspace(opts.workspace));
    if (stopped) check("Bridge stopped");
    else say("No bridge is running.");
  });

program
  .command("restart")
  .description("Restart the bridge for this workspace")
  .option("-w, --workspace <path>")
  .option("--tunnel", "re-establish the secure public connection", false)
  .option("--json", "machine-readable output", false)
  .action(async (opts: { workspace?: string; tunnel: boolean; json: boolean }) => {
    const root = resolveWorkspace(opts.workspace);
    await stopBridge(root);
    await new Promise((resolve) => setTimeout(resolve, 500));
    try {
      const { runtime, info, mcpUrl } = await ensureBridgeAndTunnel(root, { tunnel: opts.tunnel });
      const previous = readLastEndpoint(info.workspaceId);
      const connectorName = persistWorkspaceEndpoint({
        workspaceId: info.workspaceId,
        workspaceName: info.workspaceName,
        port: runtime.port,
        publicUrl: mcpUrl ? info.publicUrl : previous?.publicUrl ?? null,
        mcpUrl: mcpUrl ?? previous?.mcpUrl ?? null,
      });
      if (opts.json) {
        say(JSON.stringify({ ok: true, workspaceId: info.workspaceId, workspaceName: info.workspaceName, connectorName, mcpUrl }));
        return;
      }
      check(`Bridge restarted(${info.workspaceName})`);
      if (mcpUrl) check(`Secure connection established`);
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

// ---------------------------------------------------------------- status

program
  .command("status")
  .description("Show bridge status for this workspace")
  .option("-w, --workspace <path>")
  .option("--json", "machine-readable output", false)
  .action(async (opts: { workspace?: string; json: boolean }) => {
    const root = resolveWorkspace(opts.workspace);
    const workspace = new Workspace(root);
    const observation = await findBridgeObservation(resolveHub(workspace).hubId);
    if (observation.state === "unknown") {
      if (opts.json) {
        say(JSON.stringify({ ok: false, running: null, state: "unknown", reason: observation.reason }));
      } else {
        cross(`Bridge state is uncertain (${observation.reason}); it was not treated as stopped.`);
      }
      return;
    }
    if (observation.state === "stopped") {
      if (opts.json) say(JSON.stringify({ ok: false, running: false }));
      else say("Bridge is not running. Use `c2c start` to start it.");
      return;
    }
    const runtime = observation.runtime;
    const info = await adminFetch<AdminInfo>(runtime, "GET", "/admin/info");
    if (opts.json) {
      say(JSON.stringify({
        ok: true, running: true, ...info,
        configuredWorkspaceName: workspace.name,
        workspaceNameRestartRequired: workspace.name !== info.workspaceName,
      }));
      return;
    }
    say(PRODUCT_NAME);
    say("");
    check(`Workspace: ${info.workspaceName}`);
    check(`Bridge: running (port ${info.port})`);
    if (info.tunnel.running && info.tunnel.url) check(`Secure connection: ${info.tunnel.url}/mcp`);
    else say("· Secure connection: disabled (local mode)");
    say(`· Authorized connection: ${info.tokenCount > 0 ? "yes" : "no"}`);
  });

// ---------------------------------------------------------------- doctor

program
  .command("doctor")
  .description("Diagnose and auto-repair the connection")
  .option("-w, --workspace <path>")
  .option("--no-fix", "diagnose only, do not repair")
  .option("--json", "machine-readable output", false)
  .action(async (opts: { workspace?: string; fix: boolean; json: boolean }) => {
    const root = resolveWorkspace(opts.workspace);
    const report: Record<string, { ok: boolean; detail?: string }> = {};
    const results: string[] = [];

    // Node
    const nodeMajor = parseInt(process.versions.node.split(".")[0], 10);
    report.node = { ok: nodeMajor >= 20, detail: `v${process.versions.node}` };

    // Codex sandbox writable_roots (so later chats do not need elevation)
    if (opts.fix) {
      const sandbox = trySandboxAllow();
      if (sandbox.ok) {
        report.sandbox = { ok: true, detail: sandbox.alreadyAllowed ? "already allowlisted" : "added to allowlist" };
        if (sandbox.added) results.push("Added the local settings directory to the Codex sandbox allowlist");
      } else {
        report.sandbox = { ok: false, detail: sandbox.error };
      }
    } else {
      try {
        const configPath = getCodexConfigPath();
        const allowed =
          fs.existsSync(configPath) && isStateDirAllowlisted(fs.readFileSync(configPath, "utf8"), getStateDir());
        report.sandbox = allowed ? { ok: true, detail: "already allowlisted" } : { ok: false, detail: "not allowlisted" };
      } catch (error) {
        report.sandbox = { ok: false, detail: (error as Error).message };
      }
    }

    // Workspace
    let workspace: Workspace | null = null;
    try {
      workspace = new Workspace(root);
      report.workspace = { ok: true, detail: workspace.name };
    } catch (error) {
      report.workspace = { ok: false, detail: (error as Error).message };
    }

    if (workspace && readLastEndpoint(workspace.id)?.disconnected) {
      if (opts.json) say(JSON.stringify({ report, repairs: [], disconnected: true, chatgptRepair: { needed: false }, namedRepair: { needed: false } }));
      else say("Intentionally disconnected. Run c2c setup or c2c start --tunnel to reconnect; resources were retained.");
      return;
    }
    if (workspace && readTunnelState(workspace.id).pending) {
      handleCliError(new Error("TUNNEL_ROLLBACK_PENDING: Rerun the named setup request to recover; doctor will not start a different tunnel."), opts.json);
      return;
    }
    // Bridge
    let runtime: RuntimeState | null = null;
    let bridgeUnknown = false;
    let workspaceNameRestartRequired = false;
    if (workspace) {
      const observation = await findBridgeObservation(resolveHub(workspace).hubId);
      if (observation.state === "healthy") {
        runtime = observation.runtime;
      } else if (observation.state === "unknown") {
        bridgeUnknown = true;
        report.bridge = { ok: false, detail: `State is uncertain (${observation.reason}); automatic repair was skipped` };
      } else if (opts.fix) {
        try {
          runtime = (await ensureBridge(root)).runtime;
          results.push("Started the bridge automatically");
        } catch (error) {
          report.bridge = { ok: false, detail: (error as Error).message };
        }
      }
      if (runtime) report.bridge = { ok: true, detail: `port ${runtime.port}` };
      else report.bridge = report.bridge ?? { ok: false, detail: "not running" };
    }

    // MCP local reachability (401 without token means MCP + auth both work)
    if (runtime) {
      try {
        const response = await fetch(`http://127.0.0.1:${runtime.port}/mcp`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }),
        });
        report.mcp = { ok: response.status === 401, detail: `Unauthorized request returned ${response.status}` };
        report.oauth = { ok: response.status === 401 };
      } catch (error) {
        report.mcp = { ok: false, detail: (error as Error).message };
      }
    }

    // Tunnel + remote reachability. If this workspace once had a public URL,
    // a full quit reclaims it — restore a tunnel and tell the Skill to update
    // the existing ChatGPT connector (never treat that as "local mode").
    const lastEndpoint = workspace ? readLastEndpoint(workspace.id) : null;
    const connectorName = workspace
      ? connectorNameFor({
          workspaceName: workspace.name,
          workspaceId: workspace.id,
          previousName: lastEndpoint?.desiredConnectorName ?? lastEndpoint?.connectorName,
          hadEndpointBefore: Boolean(lastEndpoint),
        })
      : DEFAULT_CONNECTOR_NAME;
    const tunnelState = workspace ? readTunnelState(workspace.id) : null;
    const namedReady = tunnelState ? isNamedTunnelReady(tunnelState) : false;
    const namedCredential = namedReady ? inspectNamedTunnelCredentials(tunnelState?.tunnelId) : null;
    const namedCredentialFailure = Boolean(namedCredential && namedCredential.status !== "ready");
    let namedRepair: { needed: boolean; userMessage?: string } = { needed: false };
    let chatgptRepair: {
      needed: boolean;
      reason?: string;
      connectorAction: "none" | "create" | "update";
      connectorName: string;
      previousConnectorName?: string | null;
      connectorId?: string | null;
      userMessage?: string;
      mcpUrl: string | null;
      previousMcpUrl: string | null;
      pairingCode?: string;
      pairingExpiresAt?: number;
      pages: {
        developerMode: string;
        plugins: string;
        createConnector: string;
      };
    } = {
      ...connectorReconciliation(lastEndpoint),
      connectorName,
      mcpUrl: lastEndpoint?.mcpUrl ?? null,
      previousMcpUrl: boundConnector(lastEndpoint)?.mcpUrl ?? null,
      pages: {
        developerMode: CHATGPT_DEVELOPER_MODE_URL,
        plugins: CHATGPT_PLUGINS_URL,
        createConnector: CHATGPT_CREATE_CONNECTOR_URL,
      },
    };

    if (runtime) {
      let info = await adminFetch<AdminInfo>(runtime, "GET", "/admin/info");
      workspaceNameRestartRequired = workspace !== null && info.workspaceName !== workspace.name;
      if (workspaceNameRestartRequired) {
        report.workspaceName = {
          ok: false,
          detail: `WORKSPACE_NAME_RESTART_REQUIRED: Running name "${info.workspaceName}", configured name "${workspace!.name}". Run c2c restart --tunnel to apply it; auth and workspace identity are retained.`,
        };
      }
      if (namedReady && !namedCredentialFailure && opts.fix && !workspaceNameRestartRequired && info.tunnel.provider !== "cloudflare-named") {
        await stopBridge(root);
        await new Promise((resolve) => setTimeout(resolve, 400));
        try {
          runtime = (await ensureBridge(root)).runtime;
          info = await adminFetch<AdminInfo>(runtime, "GET", "/admin/info");
          results.push("Switched to the fixed-hostname connection");
        } catch (error) {
          report.tunnel = { ok: false, detail: (error as Error).message };
        }
      }
      const expectedPublic = Boolean(lastEndpoint?.publicUrl) || namedReady;
      let currentUrl = info.publicUrl ?? info.tunnel.url;
      let healthy = false;
      if (currentUrl) {
        try {
          const response = await fetch(`${currentUrl}/health`, { signal: AbortSignal.timeout(8000) });
          healthy = response.ok;
        } catch {
          healthy = false;
        }
      }

      if ((!currentUrl || !healthy) && !namedCredentialFailure && opts.fix && (expectedPublic || info.tunnel.running)) {
        try {
          const binaries = detectTunnelBinaries();
          if (!binaries.cloudflared) {
            report.tunnel = { ok: false, detail: "NEED_CLOUDFLARED" };
          } else {
            const started = await adminFetch<TunnelStartResponse>(runtime, "POST", "/admin/tunnel/start", 90_000);
            if (started.url) {
              const previousUrl = lastEndpoint?.publicUrl;
              currentUrl = started.url;
              healthy = true;
              info = await adminFetch<AdminInfo>(runtime, "GET", "/admin/info");
              const sameAddress =
                previousUrl && normalizePublicUrl(previousUrl) === normalizePublicUrl(started.url);
              results.push(sameAddress ? "Restored the secure connection" : "Restored the secure connection (address changed)");
            }
          }
        } catch (error) {
          report.tunnel = { ok: false, detail: (error as Error).message };
        }
      }

      if (namedCredentialFailure && namedCredential) {
        report.tunnel = {
          ok: false,
          detail: `NAMED_TUNNEL_CREDENTIAL_${namedCredential.status.toUpperCase()}`,
        };
        namedRepair = {
          needed: true,
          userMessage: namedTunnelCredentialRepairMessage(namedCredential.status),
        };
      } else if (currentUrl && healthy) {
        report.tunnel = { ok: true, detail: currentUrl };
        const nextMcp = mcpUrlFromPublic(currentUrl);

        const boundName = nextMcp
          ? persistWorkspaceEndpoint({
              workspaceId: info.workspaceId,
              workspaceName: info.workspaceName,
              port: runtime.port,
              publicUrl: currentUrl,
              mcpUrl: nextMcp,
              previous: lastEndpoint,
            })
          : connectorName;
        const reconcile = connectorReconciliation(readLastEndpoint(info.workspaceId));
        const action = reconcile.connectorAction;
        chatgptRepair = {
          ...chatgptRepair,
          ...reconcile,
          needed: reconcile.needed,
          reason: action === "update" ? (reconcile.previousConnectorName !== reconcile.connectorName ? "name_changed" : "address_reclaimed") : undefined,
          connectorAction: action,
          connectorName: boundName,
          userMessage: action === "update" ? reclaimUserMessage(boundName) : undefined,
          mcpUrl: nextMcp,
          previousMcpUrl: reconcile.previousMcpUrl,
        };
        if (action === "update") {
          results.push(`The connection address changed; update "${boundName}"`);
        }
      } else if (namedReady) {
        report.tunnel = report.tunnel ?? { ok: false, detail: "NAMED_TUNNEL_DOWN" };
        namedRepair = { needed: true, userMessage: NAMED_REPAIR_MESSAGE };
      } else if (expectedPublic) {
        report.tunnel = report.tunnel ?? { ok: false, detail: "Secure connection was not restored" };
        chatgptRepair = {
          ...chatgptRepair,
          needed: true,
          reason: "address_reclaimed",
          connectorAction: "update",
          connectorName,
          userMessage: reclaimUserMessage(connectorName),
          mcpUrl: null,
        };
      } else if (!currentUrl) {
        report.tunnel = { ok: true, detail: "disabled (local mode)" };
      } else {
        report.tunnel = { ok: false, detail: "Public address is unreachable" };
      }
    } else if (bridgeUnknown) {
      report.tunnel = report.tunnel ?? { ok: false, detail: "Bridge state is uncertain; connector repair was skipped" };
    } else if (namedCredentialFailure && namedCredential) {
      report.tunnel = {
        ok: false,
        detail: `NAMED_TUNNEL_CREDENTIAL_${namedCredential.status.toUpperCase()}`,
      };
      namedRepair = {
        needed: true,
        userMessage: namedTunnelCredentialRepairMessage(namedCredential.status),
      };
    } else if (namedReady) {
      report.tunnel = { ok: false, detail: "NAMED_TUNNEL_DOWN" };
      namedRepair = { needed: true, userMessage: NAMED_REPAIR_MESSAGE };
    } else if (lastEndpoint?.publicUrl) {
      report.tunnel = { ok: false, detail: "Secure connection is not running" };
      chatgptRepair = {
        ...chatgptRepair,
        needed: true,
        reason: "address_reclaimed",
        connectorAction: "update",
        connectorName,
        userMessage: reclaimUserMessage(connectorName),
      };
    }

    if (opts.json) {
      say(JSON.stringify({ report, repairs: results, chatgptRepair, namedRepair, workspaceNameRestartRequired }));
      const hasFailures =
        Object.values(report).some((value) => !value.ok) || chatgptRepair.needed || namedRepair.needed;
      if (hasFailures) process.exitCode = 1;
      return;
    }
    say(`${PRODUCT_NAME} Doctor`);
    say("");
    const labels: Record<string, string> = {
      node: "Node.js",
      sandbox: "Sandbox",
      workspace: "Workspace",
      workspaceName: "Workspace display name",
      bridge: "Bridge",
      mcp: "MCP",
      oauth: "OAuth",
      tunnel: "Tunnel",
    };
    let allOk = true;
    for (const [key, value] of Object.entries(report)) {
      const label = labels[key] ?? key;
      if (value.ok) check(`${label}${value.detail ? `(${value.detail})` : ""}`);
      else {
        cross(`${label}${value.detail ? `: ${value.detail}` : ""}`);
        allOk = false;
      }
    }
    for (const repair of results) say(`· ${repair}`);
    say("");
    if (namedRepair.needed && namedRepair.userMessage) {
      say(namedRepair.userMessage);
      say("");
    }
    if (chatgptRepair.needed && chatgptRepair.userMessage) {
      say(chatgptRepair.userMessage);
      if (chatgptRepair.mcpUrl) say(`New connection address: ${chatgptRepair.mcpUrl}`);
      if (chatgptRepair.pairingCode) say(`Pairing code: ${chatgptRepair.pairingCode}`);
      say("");
    }
    say(
      allOk && !chatgptRepair.needed && !namedRepair.needed
        ? "Everything looks good."
        : chatgptRepair.needed
          ? "Local setup is ready. Delete and recreate this connection in ChatGPT."
          : namedRepair.needed
            ? "Resolve the fixed-hostname diagnostic above first."
            : "Some issues remain. Try `c2c restart --tunnel`."
    );
    if (!allOk || namedRepair.needed) process.exitCode = 1;
  });

// ---------------------------------------------------------------- pair / unpair

program
  .command("pair")
  .description("Generate a fresh pairing code")
  .option("-w, --workspace <path>")
  .option("--json", "machine-readable output", false)
  .action(async (opts: { workspace?: string; json: boolean }) => {
    try {
      const { runtime } = await ensureBridge(resolveWorkspace(opts.workspace));
      const pairing = await adminFetch<PairingResponse>(runtime, "POST", "/admin/pairing");
      if (opts.json) say(JSON.stringify({ ok: true, pairingCode: pairing.code, expiresAt: pairing.expiresAt }));
      else {
        say(`Pairing code: ${pairing.code}`);
        say(`(${Math.round((pairing.expiresAt - Date.now()) / 60000)} minutes remaining; one-time use)`);
      }
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

program
  .command("unpair")
  .description("Revoke ChatGPT's access to this workspace immediately")
  .option("-w, --workspace <path>")
  .action(async (opts: { workspace?: string }) => {
    const root = resolveWorkspace(opts.workspace);
    const workspace = new Workspace(root);
    const observation = await findBridgeObservation(resolveHub(workspace).hubId);
    if (observation.state === "unknown") throw new Error("LIFECYCLE_BUSY: Cannot verify the bridge before revoking access.");
    if (observation.state === "healthy") {
      await adminFetch(observation.runtime, "POST", "/admin/revoke-all");
    } else {
      // bridge not running: revoke directly in the persisted store
      new AuthStore(resolveHub(workspace).hubId).revokeAll();
    }
    check("Revoked ChatGPT access to this project (all tokens revoked)");
  });

program.command("disconnect")
  .description("Revoke access and stop this workspace; keep connector, DNS, tunnel and saved configuration")
  .option("-w, --workspace <path>")
  .option("--json", "machine-readable output", false)
  .action(async (opts: { workspace?: string; json: boolean }) => {
    try {
      await disconnectWorkspace(resolveWorkspace(opts.workspace));
      if (opts.json) say(JSON.stringify({ ok: true, disconnected: true, resourcesRetained: true }));
      else check("Disconnected; connector, DNS, tunnel and configuration retained");
    } catch (error) { handleCliError(error, opts.json); }
  });

program.command("destroy")
  .description("Plan or explicitly deprovision owned resources after ChatGPT connector deletion")
  .option("-w, --workspace <path>")
  .option("--confirm", "execute the verified destruction plan", false)
  .option("--connector-removed <id>", "receipt: exact owned plugin ID removed in ChatGPT")
  .option("--desired-connector-absent", "receipt: no plugin remains for the pending desired name and URL", false)
  .option("--json", "machine-readable output", false)
  .action(async (opts: { workspace?: string; confirm: boolean; connectorRemoved?: string; desiredConnectorAbsent: boolean; json: boolean }) => {
    try {
      const result = await destroyWorkspace(resolveWorkspace(opts.workspace), opts);
      if (opts.json) say(JSON.stringify(result));
      else say(JSON.stringify(result, null, 2));
    } catch (error) { handleCliError(error, opts.json); }
  });

// ---------------------------------------------------------------- logs / workspace

program
  .command("logs")
  .description("Show recent bridge logs")
  .option("-w, --workspace <path>")
  .option("-n, --lines <n>", "number of lines", "50")
  .option("--verbose", "include debug detail", false)
  .action((opts: { workspace?: string; lines: string; verbose: boolean }) => {
    const workspace = new Workspace(resolveWorkspace(opts.workspace));
    const candidates = [
      path.join(getStateDir(), "logs", "bridge.log"),
      path.join(getStateDir(), "logs", `bridge-${resolveHub(workspace).hubId}.out.log`),
      path.join(getStateDir(), "logs", `bridge-${workspace.id}.out.log`),
    ];
    let shown = false;
    for (const file of candidates) {
      if (!fs.existsSync(file)) continue;
      const lines = fs.readFileSync(file, "utf8").trim().split("\n");
      const filtered = opts.verbose ? lines : lines.filter((line) => !line.includes(" DEBUG "));
      say(filtered.slice(-parseInt(opts.lines, 10)).join("\n"));
      shown = true;
    }
    if (!shown) say("No logs yet.");
  });

const workspaceCmd = program
  .command("workspace")
  .enablePositionalOptions()
  .description("Show workspace identity or manage the external read-access registry")
  .option("-w, --workspace <path>")
  .option("--json", "machine-readable output", false)
  .action((opts: { workspace?: string; json: boolean }) => {
    const workspace = new Workspace(resolveWorkspace(opts.workspace));
    const project = workspace.detectProject();
    const data = { workspaceId: workspace.id, name: workspace.name, root: workspace.root, ...project };
    if (opts.json) say(JSON.stringify(data));
    else {
      say(`Workspace: ${data.name}(${data.workspaceId})`);
      say(`Type: ${data.projectType}  Languages: ${data.languages.join(", ") || "-"}`);
      say(`Path: ${data.root}`);
    }
  });

function ownerRegistry(option?: string): WorkspaceRegistry {
  const owner = new Workspace(resolveWorkspace(option ?? workspaceCmd.opts().workspace));
  return WorkspaceRegistry.forWorkspace(owner);
}

workspaceCmd.command("list")
  .description("List local workspaces registered to this bridge owner")
  .option("-w, --workspace <path>", "bridge owner root (defaults to current directory)")
  .option("--json", "machine-readable output", false)
  .action((opts: { workspace?: string; json: boolean }) => {
    try {
      const workspaces = ownerRegistry(opts.workspace).list();
      if (opts.json) say(JSON.stringify({ workspaces }));
      else for (const entry of workspaces) say(`${entry.alias} (${entry.workspaceId}) ${entry.root}`);
    } catch (error) { handleCliError(error, opts.json); }
  });

workspaceCmd.command("add <path>")
  .description("Grant this bridge owner read access to a canonical local workspace")
  .option("-w, --workspace <path>", "bridge owner root (defaults to current directory)")
  .option("--alias <alias>", "unique lowercase alias; defaults to directory name plus workspace ID")
  .option("--json", "machine-readable output", false)
  .action((repoPath: string, opts: { workspace?: string; alias?: string; json: boolean }) => {
    try {
      const entry = ownerRegistry(opts.workspace).add(resolveWorkspace(repoPath), opts.alias);
      if (opts.json) say(JSON.stringify({ ok: true, ...entry }));
      else check(`Registered ${entry.alias} (${entry.workspaceId}): ${entry.root}`);
    } catch (error) { handleCliError(error, opts.json); }
  });

workspaceCmd.command("remove <alias-or-id>")
  .description("Remove workspace read access without changing connection resources")
  .option("-w, --workspace <path>", "bridge owner root (defaults to current directory)")
  .option("--json", "machine-readable output", false)
  .action((selector: string, opts: { workspace?: string; json: boolean }) => {
    try {
      const entry = ownerRegistry(opts.workspace).remove(selector);
      if (opts.json) say(JSON.stringify({ ok: true, ...entry }));
      else check(`Removed ${entry.alias} (${entry.workspaceId})`);
    } catch (error) { handleCliError(error, opts.json); }
  });

// ---------------------------------------------------------------- sandbox-allow (Codex writable_roots, macOS + Windows)

acceptUnusedWorkspaceOption(
  program
    .command("sandbox-allow")
    .description("Add the local settings directory to the Codex sandbox allowlist")
    .option("--json", "machine-readable output", false)
)
  .action((opts: { json: boolean }) => {
    const result = trySandboxAllow();
    if (opts.json) {
      say(JSON.stringify(result));
      if (!result.ok) process.exitCode = 1;
      return;
    }
    if (!result.ok) {
      cross(`Could not write the Codex sandbox allowlist: ${result.error}`);
      process.exitCode = 1;
      return;
    }
    if (result.alreadyAllowed) check("Sandbox allowlist is ready; future chats do not need elevation");
    else check("Added the local settings directory to the Codex sandbox allowlist; future chats do not need elevation");
  });

// ---------------------------------------------------------------- update-check (explicit requests only)

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function runGit(args: string[]): { ok: boolean; stdout: string } {
  const result = spawnSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 8000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    windowsHide: true,
  });
  return { ok: result.status === 0, stdout: (result.stdout ?? "").trim() };
}

acceptUnusedWorkspaceOption(
  program
    .command("update-check")
    .description("Check GitHub for a newer version (real check at most once per local day)")
    .option("--force", "check even if already checked today", false)
    .option("--json", "machine-readable output", false)
)
  .action((opts: { force: boolean; json: boolean }) => {
    try { verifyForkOrigin(runGit); }
    catch (error) { handleCliError(error, opts.json); return; }
    const file = path.join(getStateDir(), "update-check.json");
    const today = new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD in local tz
    let last: { date?: string; updateAvailable?: boolean } = {};
    try {
      last = JSON.parse(fs.readFileSync(file, "utf8")) as typeof last;
    } catch {
      /* first run */
    }

    const emit = (data: {
      checked: boolean;
      updateAvailable: boolean;
      localCommit?: string;
      remoteCommit?: string;
      note?: string;
    }): void => {
      if (opts.json) say(JSON.stringify({ ok: true, version: VERSION, ...data }));
      else if (data.updateAvailable) say(`Update available (local ${data.localCommit?.slice(0, 7)} -> remote ${data.remoteCommit?.slice(0, 7)}).`);
      else say(data.note ?? "Already up to date.");
    };

    if (!opts.force && last.date === today) {
      emit({ checked: false, updateAvailable: last.updateAvailable ?? false, note: "Already checked for updates today." });
      return;
    }

    const local = runGit(["rev-parse", "HEAD"]);
    const remote = runGit(["ls-remote", "origin", "HEAD"]);
    if (!local.ok || !remote.ok || !remote.stdout) {
      // Offline or not a git checkout: skip quietly and retry tomorrow-ish (do not
      // record the date so a transient failure does not suppress an explicit retry).
      emit({ checked: false, updateAvailable: false, note: "Could not check updates (offline or not a git installation); skipped." });
      return;
    }
    const remoteCommit = remote.stdout.split(/\s/)[0];
    const updateAvailable = remoteCommit !== local.stdout;
    fs.mkdirSync(getStateDir(), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ date: today, updateAvailable, remoteCommit }), { mode: 0o600 });
    emit({ checked: true, updateAvailable, localCommit: local.stdout, remoteCommit });
  });

acceptUnusedWorkspaceOption(program.command("update").description("Explicitly fast-forward this fork after checking origin and a clean checkout")
  .option("--json", "machine-readable output", false))
  .action((opts: { json: boolean }) => {
    try {
      pullFork(repoRoot);
      if (opts.json) say(JSON.stringify({ ok: true, next: "Build the checkout and reinstall the Skill before restarting bridges." }));
      else check("Pulled hudrucan/desk-c2c-hub; build and reinstall the Skill to finish updating");
    } catch (error) { handleCliError(error, opts.json); }
  });

// ---------------------------------------------------------------- setup preferences

const prefsCmd = program
  .command("prefs")
  .description("Remember ChatGPT developer mode and setup choice for this machine");

acceptUnusedWorkspaceOption(
  prefsCmd
    .command("get", { isDefault: true })
    .description("Show remembered ChatGPT setup choices (not per workspace)")
    .option("--json", "machine-readable output", false)
)
  .action((opts: { json: boolean }) => {
    const prefs = readUiPrefs();
    if (opts.json) {
      say(JSON.stringify({ ok: true, ...prefs }));
      return;
    }
    say(prefs.developerModeEnabled ? "Developer mode: remembered as enabled" : "Developer mode: not remembered yet");
    if (prefs.setupMode === "auto") say("Setup mode: automatic (preview)");
    else if (prefs.setupMode === "manual") say("Setup mode: guided manual");
    else say("Setup mode: not selected");
  });

acceptUnusedWorkspaceOption(
  prefsCmd
    .command("set")
    .description("Save a ChatGPT setup choice for this machine")
    .option("--developer-mode", "remember that ChatGPT developer mode is on", false)
    .option("--setup-mode <mode>", "auto (preview) or manual")
    .option("--json", "machine-readable output", false)
)
  .action((opts: { developerMode: boolean; setupMode?: string; json: boolean }) => {
    try {
      const modeRaw = opts.setupMode?.trim().toLowerCase();
      if (modeRaw && !SETUP_MODES.includes(modeRaw as SetupMode)) {
        throw new Error(`setup-mode must be one of ${SETUP_MODES.join(", ")}`);
      }
      if (!opts.developerMode && !modeRaw) {
        throw new Error("nothing to save: pass --developer-mode and/or --setup-mode");
      }
      const prefs = mergeUiPrefs({
        developerModeEnabled: opts.developerMode ? true : undefined,
        setupMode: modeRaw as SetupMode | undefined,
      });
      if (opts.json) {
        say(JSON.stringify({ ok: true, ...prefs }));
        return;
      }
      if (opts.developerMode) check("Remembered Developer mode as enabled");
      if (modeRaw === "auto") check("Remembered setup mode: automatic (preview)");
      if (modeRaw === "manual") check("Remembered setup mode: guided manual");
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

const tunnelCmd = program.command("tunnel").description("Choose or inspect the public connection for this workspace");

tunnelCmd
  .command("status", { isDefault: true })
  .description("Show whether this workspace still needs a one-time connection choice")
  .option("-w, --workspace <path>")
  .option("--zone <domain>", "optional domain, used to preview the stable hostname")
  .option("--json", "machine-readable output", false)
  .action((opts: { workspace?: string; zone?: string; json: boolean }) => {
    try {
      const workspace = new Workspace(resolveWorkspace(opts.workspace));
      const payload = tunnelChoicePayload(workspace, opts.zone);
      if (opts.json) {
        say(JSON.stringify(payload));
        return;
      }
      if (payload.needsChoice) say(TUNNEL_CHOICE_PROMPT);
      else if (payload.namedReady) check(`Fixed hostname: ${payload.hostname}`);
      else say("Currently using a temporary address.");
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

tunnelCmd
  .command("choose")
  .description("Remember quick vs named, and provision a named hostname when asked")
  .requiredOption("--mode <mode>", "quick or named")
  .option("-w, --workspace <path>")
  .option("--zone <domain>", "Cloudflare domain for a named hostname")
  .option("--hostname <hostname>", "override the default c2c-<project>.<zone>")
  .option("--tunnel-name <name>", "Cloudflare Named Tunnel resource name (otherwise keep the saved name)")
  .option("--json", "machine-readable output", false)
  .action(async (opts: { mode: string; workspace?: string; zone?: string; hostname?: string; tunnelName?: string; json: boolean }) => {
    const root = resolveWorkspace(opts.workspace);
    try {
      const workspace = new Workspace(root);
      const mode = opts.mode.trim().toLowerCase();
      const previous = readTunnelState(workspace.id);
      if (mode === "quick") {
        if (opts.tunnelName !== undefined || opts.hostname !== undefined) {
          throw new Error("NAMING_CONFLICT: A Quick Tunnel cannot use a custom tunnel name or hostname.");
        }
        const state = chooseQuickTunnel(workspace.id);
        if (await findLiveBridge(resolveHub(workspace).hubId)) {
          if (previous.preference === "named") await stopBridge(root);
        }
        const payload = { ...tunnelChoicePayload(workspace), state };
        if (opts.json) say(JSON.stringify(payload));
        else check("Selected a temporary address");
        return;
      }
      if (mode !== "named") {
        throw new Error("mode must be quick or named");
      }
      const zone = parseZoneInput(opts.zone ?? previous.zone ?? "");
      if (!zone) {
        const payload = {
          ok: false,
          need: "zone",
          userMessage: "Provide the domain already configured in Cloudflare, for example example.com",
          loginPrompt: NAMED_LOGIN_PROMPT,
        };
        if (opts.json) {
          say(JSON.stringify(payload));
          return;
        }
        say(payload.userMessage);
        return;
      }
      if (!opts.json) say(NAMED_LOGIN_PROMPT);
      const result = await provisionNamedTunnel({
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        zone,
        hostname: opts.hostname,
        tunnelName: opts.tunnelName,
      });
      if (!result.ok) {
        handleCliError(new Error(result.error ?? "Named tunnel provisioning failed."), opts.json);
        return;
      }
      const changed = previous.preference !== result.state.preference || previous.tunnelName !== result.state.tunnelName || previous.hostname !== result.state.hostname;
      if (changed && await findLiveBridge(resolveHub(workspace).hubId)) await stopBridge(root);
      const payload = {
        ...tunnelChoicePayload(workspace),
        ok: result.ok,
        fallback: result.fallback,
        userMessage: result.userMessage,
        error: result.error,
        state: result.state,
      };
      if (opts.json) {
        say(JSON.stringify(payload));
        return;
      }
      if (result.fallback) say(result.userMessage ?? "");
      else check(`Fixed hostname ready: ${result.state.hostname}`);
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

acceptUnusedWorkspaceOption(
  tunnelCmd
    .command("login")
    .description("Open the Cloudflare login window used by a named hostname")
    .option("--json", "machine-readable output", false)
)
  .action(async (opts: { json: boolean }) => {
    try {
      if (!opts.json) say(NAMED_LOGIN_PROMPT);
      const account = new ProcessCloudflaredAccount();
      await account.login();
      const payload = { ok: true, loggedIn: hasCloudflaredCert() };
      if (opts.json) say(JSON.stringify(payload));
      else check("Logged in to Cloudflare");
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

function handleCliError(error: unknown, json: boolean): void {
  const message = error instanceof Error ? error.message : String(error);
  if (json) {
    say(JSON.stringify({ ok: false, error: message }));
  } else if (message.startsWith("NEED_CLOUDFLARED")) {
    say("One action is needed:");
    say("");
    say("The secure connection component cloudflared is not installed.");
    say("On macOS, run: brew install cloudflared");
    say("Try again after completing that step.");
  } else {
    cross(message);
  }
  process.exitCode = 1;
}

program.parseAsync(process.argv).catch((error: Error) => {
  handleCliError(error, process.argv.includes("--json"));
  process.exit(1);
});
