# Troubleshooting Codex with ChatGPT

For an existing setup start with `c2c doctor --json`. Use `--no-fix`
for read-only diagnosis. For a new setup, resolve names before a repairing
doctor or provisioning. Successful repair ends with real MCP verification,
`MCP READY`, and no follow-on workflow.

## Naming and identity

See [lifecycle](lifecycle.md) for naming precedence, restart requirements and
connector verification. A stopped bridge or expired URL is not a new setup;
reuse saved names and owned resource bindings.

On `HUB_NAME_RESTART_REQUIRED`, run
`c2c restart --tunnel --json` and rerun setup. For a Quick Tunnel,
check the new address and reconcile the owned ChatGPT plugin.

## Local process and tunnel diagnostics

| Diagnostic | Recovery |
| --- | --- |
| `TUNNEL_STATE_CONFLICT` / `ENDPOINT_STATE_CONFLICT` | Preserve the authoritative Hub file; verify its exact owner and format; never merge, reset or create replacement resources to bypass a conflict |
| `TUNNEL_STATE_BUSY` / `ENDPOINT_STATE_BUSY` | Verify no local writer is active before removing only the reported owner's state lock |
| `AUTH_STATE_CONFLICT` | Preserve Hub auth state; verify ownership and format before retrying, without merging or resetting credentials |
| `RUNTIME_STATE_INVALID` / uncertain runtime | Preserve state and verify Hub identity and PID; never stop or replace an unverified process |
| Bridge stopped | Doctor can start it; explicit `start --tunnel` also reconnects |
| `disconnected: true` | Intentional; reconnect only when requested |
| Bridge state unknown | Resolve the local uncertainty; never spawn another process or delete the plugin |
| Port occupied | Matching bridges are reused; otherwise the bridge chooses a free port |
| Sandbox/state-dir write failure | `c2c sandbox-allow --json`; use the permitted escalation flow if needed |
| cloudflared missing | Install from the vendor/package source, then retry |
| Custom cloudflared location | Set `C2C_CLOUDFLARED_PATH` to the executable's absolute path |
| QUIC repeatedly reconnects | Set `C2C_TUNNEL_PROTOCOL=http2` in the launch environment and explicitly restart |
| `TUNNEL_ROLLBACK_PENDING` | Rerun the named setup request to recover first; retain the journal |
| `DESTROY_PENDING` | Preserve state and follow the isolated [deprovisioning recovery reference](../skill/references/deprovision.md#interrupted-destroy) |
| `LIFECYCLE_BUSY` after a crash | Verify the lock's PID has exited before removing that specific lock |
| `HUB_STATE_BUSY` after a crash | Verify no Hub operation is running before removing only `hubs/.lock` |
| `HUB_STATE_INVALID` | Preserve state; inspect the exact Hub record before repair; do not merge or create replacement identities |
| `WORKSPACE_REGISTRY_BUSY` after a crash | Verify no registry writer is running before removing only `workspace-registries/<hubId>.json.lock` |

Use `c2c logs` for local diagnostics. Do not paste logs or credentials
into ChatGPT. Local state uses the OS app directory `codex-with-chatgpt`.

## Named Tunnel credentials

Account `cert.pem` and tunnel `<UUID>.json` are separate prerequisites. Follow
doctor's specific diagnostic and the [credential recovery reference](../skill/references/operations.md#named-tunnel-prerequisites).
Keep the configured hostname/UUID; do not recreate a tunnel to avoid recovery.

Tunnel rename and hostname DNS changes need an environment-only `CLOUDFLARE_API_TOKEN` scoped as
specified in [lifecycle](lifecycle.md). Do not extract tokens from certificates.

## ChatGPT connection errors

Inspect `chatgptRepair` previous/desired fields. Verify exact plugin ID, name
and Server URL before modifying an owned plugin. A title collision with a
foreign URL is not permission to delete it.

When a Quick URL changes, recreate only that owned plugin with the current
address. Avoid Reconnect on a dead URL. For an unchanged Named hostname,
repair local credentials/tunnel first; do not unnecessarily recreate the plugin.
A 401 with an unchanged URL can require reauthorization using a fresh pairing
code. Mint the code when the authorization form is ready; codes expire and
are one-time use.

For changed UI navigation, use [UI recovery](../skill/references/operations.md#chatgpt-ui-recovery).
For stale catalogs or reauthorization, complete the Skill's
[verification and binding](../skill/references/setup.md#verification-and-binding) using actual
MCP evidence. A local health check does not clear the pending binding.

### Audit callback reports `INSUFFICIENT_SCOPE`

Existing tokens keep their consented scopes; refreshing tokens or the tool catalog
does not add permissions. Reauthorize the existing connection once with the
[complete consent bundle](security.md#token--scope-design), then repeat the
Skill's [permission verification](../skill/references/setup.md#verification-and-binding).
Missing consent permissions block readiness. Preserve the Hub, connector and
tunnel; never edit OAuth URLs or token state to bypass consent.

## Reads and image access

`ACCESS_DENIED_SENSITIVE_FILE` is expected for `.env`, keys, credentials and
ignored paths. `.env.example` remains readable. Do not relax containment or
sensitive-file rules to make setup pass. `read_image` accepts supported bounded
workspace images; invalid signatures, active SVG and path escapes are rejected.
It does not import generated/downloaded media.

## Workspace selection

For selection errors, inspect `c2c workspace list --json` and call
`list_workspaces` through the intended connection. With multiple Hubs, use
`--hub <id>` from `c2c hub list --json`. `WORKSPACE_REQUIRED` asks for a registered
alias/ID on that call; no tool establishes a default workspace.
See [multi-repo access](multi-repo.md).
