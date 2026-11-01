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
| Sandbox/state-dir or loopback `EPERM` | Use official terminal escalation; do not relax sandbox security to retry automatic delivery. Return the original handoff when delivery fails |
| cloudflared missing | Install from the vendor/package source, then retry |
| Custom cloudflared location | Set `C2C_CLOUDFLARED_PATH` to the executable's absolute path |
| QUIC repeatedly reconnects | Set `C2C_TUNNEL_PROTOCOL=http2` in the launch environment and explicitly restart |
| `TUNNEL_ROLLBACK_PENDING` | Rerun the named setup request to recover first; retain the journal |
| `DESTROY_PENDING` | Preserve state and follow the isolated [deprovisioning recovery reference](../skill/references/deprovision.md#interrupted-destroy) |
| `LIFECYCLE_BUSY` after a crash | Verify the lock's PID has exited before removing that specific lock |
| `HUB_STATE_BUSY` after a crash | Verify no Hub operation is running before removing only `hubs/.lock` |
| `HUB_STATE_ACCESS_DENIED` / `TUNNEL_STATE_ACCESS_DENIED` / `ENDPOINT_STATE_ACCESS_DENIED` | The OS denied creation of the state lock (`EPERM` or `EACCES`); use the permitted sandbox escalation or restore state-directory access. This does not indicate lock contention; do not delete locks to resolve it |
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
Skill's [connection verification](../skill/references/setup.md#verification-and-binding).
Missing consent permissions block automatic callback acceptance; return the
original handoff for manual audit. Preserve the Hub, connector and tunnel; never
edit OAuth URLs or token state to bypass consent.

## Windows automatic C2C

`auto=true` requires the user's conversation URL/ID supplied by Web and a local
configured C2C-owned private Edge profile. Each local controller starts/reuses it
and resolves its current CDP endpoint; thread environment sharing is unnecessary.
It uses CDP directly, without a browser REPL or selected-tab discovery. Missing input or
CDP access fails before source scanning or callback registration. Authentication
and challenge failures require user action, never a delivery retry. A reboot
loses pending callbacks and replay guards; pending tasks cannot resume.

The terminal controller uses raw TTY input and checksummed ASCII output frames;
pipes use JSONL. Keep the terminal at least 20 columns wide, including during
resizes, and retain complete tool output for `decodeTerminalOutput`. Resize before
prepare when possible: ConPTY can repaint an old frame during an in-flight resize.
Duplicate frames fail closed; a repainted prepare ticket is never a matching audit
receipt. The decoder reassembles wrapped digest/payload lines only inside a bounded frame and verifies
its byte length and checksum. Missing markers, altered bytes and narrower
terminals fail closed. Synthetic wrapping tests are separate from native ConPTY
tests using cmd/Windows PowerShell and local OAuth MCP. Neither proves a browser
send or ChatGPT audit; E2E still requires MCP `accepted:true` and a matching terminal
receipt. Windows CI uses the hosted Windows runner, not an LTSC/RDP certification.

A failed composer fill or pre-Enter check may leave a callback draft. Stop the
terminal attempt and inspect the draft manually; do not send it, reuse its ticket
or clear it automatically over user edits. `uncertain`/`sent` delivery means a
manual send may duplicate an existing message. See the
[sender failure rules](../skill/references/workflow-async.md#manual-fallback).

### Checkout, process and permissions

Check the selected Skill's bound checkout and `dist/c2c` build, including paths
with spaces. Editing another checkout does not update the installed Skill or
running Hub. Check known user/project Skill roots for duplicate discovery without
copying or replacing installations. Git ownership rejection is a real boundary:
do not add global `safe.directory` exceptions. CRLF-only byte changes can invalidate
an audit even when Git's normalized diff is empty. Unsupported junctions/links
and source over the 64 MiB fingerprint budget fail closed.

If a Hub is launched by an existing Scheduled Task, verify its configured user,
logon trigger/type and explicit state directory. Running under a different account
can select different state and cannot impersonate the original owner. This product
does not install a boot task or restore browser/terminal sessions. Inspect runtime
file ACLs with `Get-Acl -LiteralPath <runtime-file>` without printing file contents.
If Codex uses a separate sandbox SID, use the sender's official terminal escalation
for its single controller before prepare when required. Do not broaden the DACL
or retry a failed attempt to gain access.
For `STATE_ACL_UNAVAILABLE`, verify inbox Windows PowerShell/.NET and permission to
create an owner-only file; preserve existing state instead of weakening ACLs.
See [storage protection](security.md#storage).

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
