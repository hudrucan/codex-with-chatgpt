# Setup and connection lifecycle

A stable Hub ID owns the connection independently of registered repos.
A single configured Hub is selected automatically; multiple Hubs require
`--hub <id>`, available from `c2c hub list --json`.
Display names and additional read targets do not transfer ownership of OAuth
tokens, runtime state, connectors or tunnel UUIDs.

## Setup and naming

Ask Codex to set up Codex with ChatGPT using the [Skill](../skill/SKILL.md). It resolves
names from explicit user values, saved settings, project-derived suggestions
and defaults. New setups ask one grouped decision for the Hub display
name, tunnel name, hostname and connector name. Saved setups reuse their values
unless a conflict needs resolution.

For a fixed hostname, provide a domain configured in Cloudflare:

```bash
node bin/c2c.js setup -w /path/to/repo --hub-name "My Hub" --tunnel-name "my-repo" --zone example.com --hostname code.example.com --connector-name "My Repo" --json
```

Replace the example values. Omit Named Tunnel options for a temporary Quick
Tunnel. `--no-tunnel` is local development only and does not establish a public
ChatGPT connection. The Skill completes authorization and verifies actual MCP
results before reporting `MCP READY`.

Fresh setup creates an independent Hub and registers the selected repo. With
one healthy connected Hub, register another repo using `c2c workspace add`
and verify the returned registration ID with `workspace_info(workspace="<id>")`;
no new tunnel, connector or OAuth setup is needed.

`setup --workspace-name` changes only a repo label in external workspace state.
It does not rename or own the Hub. `setup --hub-name` changes the Hub display
name; `HUB_NAME_RESTART_REQUIRED` requires an explicit restart if the running
Hub captured a different label. No command writes repository configuration.

## Tunnel and hostname changes

Tunnel rename updates the saved UUID in place, retaining credentials and CNAME
target. Conflicting names, missing IDs or changed bindings fail without choosing
another name. Hostname changes verify the old CNAME's UUID and require the new
hostname to be free. Cleanup rechecks the exact DNS record before changing it.

A pending operation journal supports rollback. `TUNNEL_ROLLBACK_PENDING` requires
recovery by rerunning the named setup request before other changes; doctor does
not switch connection types to bypass it.

Account login uses cloudflared and its account certificate. Tunnel rename needs
an environment-only `CLOUDFLARE_API_TOKEN` with Zone Read and Cloudflare Tunnel
Write permissions for the relevant zone/account. Hostname DNS changes require
DNS Edit. Tokens are not extracted from certificates, persisted or printed.

## Connector verification

Endpoint state separates desired settings from the verified ChatGPT binding:

| Field | Meaning |
| --- | --- |
| `desiredConnectorName` | Selected connector name |
| `mcpUrl`, `publicUrl` | Desired connection addresses |
| `connectorName`, `boundMcpUrl`, `connectorId` | Verified plugin binding |
| `bindingVersion: 1` | Explicit desired/bound state format |

Inspect the exact plugin ID, name and Server URL. Verify
`workspace_info(workspace="<id>")` through the plugin using a currently registered
workspace ID, then acknowledge the observed binding:

```bash
c2c connector bind --name "<desired-name>" --mcp-url "<desired-url>" --connector-id "<observed-plugin-id>" --verified-workspace "<observed-workspace-id>" --json
```

The acknowledgement rejects stale name/URL/workspace values. It is a trusted
local receipt of observed MCP results. Setup and doctor do not advance binding
fields on their own; a local health check does not prove a ChatGPT binding.

## Reconnect and disconnect

| Command | Behavior |
| --- | --- |
| `start --tunnel` | Start or reuse the bridge and establish public access |
| `status --json` | Inspect connection state |
| `doctor --json` | Diagnose and repair; add `--no-fix` for diagnosis only |
| `restart --tunnel` | Explicitly restart and reconnect |
| `unpair` | Revoke tokens, retaining the running bridge |
| `stop` | Stop the bridge without revoking tokens or removing resources |
| `disconnect --json` | Revoke access, confirm shutdown and retain resources, configuration and registrations |

Run these commands with `c2c`. Doctor respects an intentional disconnect;
explicit setup/start/restart reconnects. Matching owned resources are reused.
Uncertain runtime state or ownership conflicts must be resolved before repair.
For diagnostics and lock recovery, see [troubleshooting](troubleshooting.md).

## Explicit updates

`c2c update --json` verifies the exact `hudrucan/codex-with-chatgpt` origin and a clean
branch checkout, then pulls with `--ff-only`. It does not stash or reset changes.
Build and reinstall the complete Skill directory after an update. Explicitly
restart and verify active connections; disconnected Hubs stay stopped.
Updates run only when requested.

Experimental resource removal is isolated in the
[Skill deprovisioning reference](../skill/references/deprovision.md); setup,
reconnect and repair do not invoke that workflow.
