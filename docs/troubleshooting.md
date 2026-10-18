# Troubleshooting Desk C2C Hub

For an existing setup start with `c2c doctor -w <repo> --json`. Use `--no-fix`
for read-only diagnosis. For a new setup, resolve names before a repairing
doctor or provisioning. Successful repair ends with real MCP verification,
`MCP READY`, and no follow-on workflow.

## Naming and identity

The [Skill](../skill/SKILL.md#resolve-names-before-provisioning) uses explicit
values, saved configuration, project-derived suggestions and fallback defaults.
A new setup asks one grouped decision; existing setups reuse saved names unless
there is a genuine conflict. A stopped bridge or expired URL is not a new setup.

```bash
c2c setup -w <repo> --workspace-name "My Repo" --tunnel-name "my-repo" --zone example.com --hostname code.example.com --connector-name "My Repo" --json
```

Replace the example domain. Omit Named Tunnel options for a temporary Quick
Tunnel. `tunnel choose --mode named` also accepts name and hostname flags.

- `--workspace-name` writes external `workspaces/<workspaceId>.json`, never a
  naming-only repo file. It overrides legacy `.c2c.json` `name` without editing
  the file. `workspaceId` still derives from the canonical root.
- A running bridge captures the display name at startup. On
  `WORKSPACE_NAME_RESTART_REQUIRED`, run `c2c restart -w <repo> --tunnel --json`
  and rerun setup. Identity/tokens are retained; a Quick URL may change.
- Explicit tunnel name, then saved name, then `c2c-<workspaceId>` is the resource
  name precedence. A matching title without matching saved UUID is a conflict.
  Do not invent a suffix or switch connection types after an explicit conflict.
- Hostname precedence is explicit, saved, then suggested. Changing display name
  does not generate a new hostname. In-place tunnel rename keeps its UUID;
  hostname migration cleans only the old CNAME pointing to that UUID.
- `desiredConnectorName` is separate from bound `connectorName` / `boundMcpUrl`
  / `connectorId`. Repeated doctor calls keep an unreconciled change pending.
  Verify plugin settings and actual `workspace_info`, then `connector bind`.

See [lifecycle](lifecycle.md) for API permissions, rollback and ownership checks.

## Local process and tunnel diagnostics

| Diagnostic | Recovery |
| --- | --- |
| Bridge stopped | Doctor can start it; explicit `start --tunnel` also reconnects |
| `disconnected: true` | Intentional; reconnect only when requested |
| Bridge state unknown | Resolve the local uncertainty; never spawn another process or delete the plugin |
| Port occupied | Matching bridges are reused; otherwise the bridge chooses a free port |
| Sandbox/state-dir write failure | `c2c sandbox-allow --json`; use the permitted escalation flow if needed |
| cloudflared missing | Install from the vendor/package source, then retry |
| Custom cloudflared location | Set `C2C_CLOUDFLARED_PATH` to the executable's absolute path |
| QUIC repeatedly reconnects | Set `C2C_TUNNEL_PROTOCOL=http2` in the launch environment and explicitly restart |
| `TUNNEL_ROLLBACK_PENDING` | Rerun the named setup request to recover first; retain the journal |
| `DESTROY_PENDING` | Resolve the cleanup failure and retry `destroy --confirm`; do not reconfigure |
| `LIFECYCLE_BUSY` after a crash | Verify the lock's PID has exited before removing that specific lock |

Use `c2c logs -w <repo>` for local diagnostics. Do not paste logs or credentials
into ChatGPT. The OS state namespace stays `codex-with-chatgpt` for compatibility.

## Named Tunnel credentials

An account `cert.pem` and a tunnel `<UUID>.json` are different prerequisites.
Doctor distinguishes missing certificate, missing/unreadable credential, invalid
JSON and UUID mismatch without printing their contents. Keep the configured
hostname and UUID. Follow the diagnostic: `c2c tunnel login` for account login,
or restore the existing UUID's credential with cloudflared's `tunnel token
--cred-file` command when required. Do not recreate a tunnel to avoid recovery.

Rename/DNS cleanup needs an environment-only `CLOUDFLARE_API_TOKEN` scoped as
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

Use the in-app browser's visible Plugins/Manage/Add custom MCP server flow.
If a legacy deep link redirects without opening a form, inspect visible settings
rather than retrying guessed URLs. Human login, credentials or explicit consent
may require the user. Preserve the tab to resume the same setup.

Attach/select the exact plugin in a normal chat and require a real
`workspace_info` result matching local ID/name. If the chat's tool surface is
stale, use a new ordinary verification chat. Do not create a Project or save a
conversation pointer. A correct result plus `connector bind` and healthy doctor
clears the pending binding. Report `MCP READY` and stop.

## Reads and image access

`ACCESS_DENIED_SENSITIVE_FILE` is expected for `.env`, keys, credentials and
ignored paths. `.env.example` remains readable. Do not relax containment or
sensitive-file rules to make setup pass. `read_image` accepts supported bounded
workspace images; invalid signatures, active SVG and path escapes are rejected.
It does not import generated/downloaded media.

## Upgrade from the planning workflow

Rebuild and reinstall the whole Skill directory, including its shallow
references. The build clears obsolete compiled modules. Session/record/asset
commands and execution MCP tools are removed; the Skill never resumes an old
checkpoint or runs an orchestration loop. Existing external legacy data is
ignored rather than auto-migrated, and explicit destroy still cleans the
workspace-keyed legacy files. Existing auth, state namespace and connector
names are retained. New connector defaults use Desk C2C Hub.
