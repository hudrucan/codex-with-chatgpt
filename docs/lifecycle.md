# Naming and resource lifecycle

The canonical workspace root determines `workspaceId`. Display names never key
OAuth tokens, runtime state, or Cloudflare tunnel UUIDs. This remains one bridge,
one workspace and one connector; MCP remains read-only.

## Local display names

`setup --workspace-name <name>` writes only external C2C state:
`workspaces/<workspaceId>.json` contains `workspaceId`, canonical `workspaceRoot`
and `displayName`. Resolution is external local override, then legacy
`.c2c.json` `name`, then root basename. Other `.c2c.json` settings remain readable.
Setup does not create or edit repository files for naming. A display-name change
requires an explicit bridge restart; auth and root identity survive.

## Tunnel and hostname rename

Tunnel rename updates the saved Cloudflare UUID in place, retaining credentials
and CNAME target. It does not create a replacement tunnel. Conflicting names,
missing IDs or externally changed bindings fail without choosing another name.

Hostname rename verifies the old CNAME targets the saved UUID and the new name
has no existing DNS record. It routes the new name, then deletes only the old
owned CNAME. Neither unrelated A/AAAA records nor a CNAME to another UUID may be
overwritten/deleted. Cleanup rereads the exact record ID immediately before delete.

An external tunnel-state `pending` journal records intent before mutations.
Failure rolls back the new DNS/name and restores the old DNS if necessary. A
failed rollback retains its journal and returns `TUNNEL_ROLLBACK_PENDING`.
Rerun the named setup request to retry rollback before applying the request.
Doctor cannot silently switch to a different tunnel while this is pending.
Quick selection retains saved Named Tunnel ownership fields for later destroy.

Initial setup still uses `cloudflared` and the existing account certificate.
Rename/ownership-checked DNS cleanup additionally requires an environment-only
`CLOUDFLARE_API_TOKEN`, scoped to the relevant zone/account:

- Zone Read and DNS Edit for DNS lookup/removal.
- Cloudflare Tunnel Write (or the equivalent Cloudflare One connector write
  permission) for in-place tunnel rename.

No token is persisted or printed; the account certificate is not parsed to
extract API credentials. No new package dependency is required.
Cloudflare references: [rename tunnel](https://developers.cloudflare.com/api/resources/zero_trust/subresources/tunnels/subresources/cloudflared/methods/edit/)
and [delete DNS record](https://developers.cloudflare.com/api/resources/dns/subresources/records/methods/delete/).

## Connector transaction

Endpoint state distinguishes:

| Field | Meaning |
| --- | --- |
| `desiredConnectorName` | Setup-selected name, reused on rerun/restart/doctor |
| `mcpUrl`, `publicUrl` | Current desired service address |
| `connectorName`, `boundMcpUrl`, `connectorId` | Last verified ChatGPT plugin binding |
| `bindingVersion: 1` | Explicit desired/bound state format |

Legacy endpoint records are read as their previous binding without renaming.
Setup/doctor never advance the bound fields on their own. A failed or interrupted
browser reconcile stays pending across repeated doctor calls. Inspect the saved
plugin ID, name and Server URL before modifying that plugin. Verify settings,
authorize if required, call `workspace_info` through the desired plugin and
check the canonical workspace ID. Only then acknowledge:

```bash
c2c connector bind -w <workspace> --name "<desired-name>" --mcp-url "<desired-url>" --connector-id "<observed-plugin-id>" --verified-workspace "<observed-workspace-id>" --json
```

The acknowledgement checks the current desired name/URL/workspace. It is a
trusted local agent receipt of observed ChatGPT results, not independent browser
attestation. Never fabricate it. After bind and a healthy doctor check, report
`MCP READY` and stop; no Project/session metadata is managed.

## Disconnect and destroy

`c2c unpair` retains its original token-revocation-only behavior.
`c2c disconnect` revokes access, confirms bridge shutdown, and retains connector,
DNS, tunnel and naming state. Doctor respects `disconnected`; explicit
setup/start/restart reconnects. Stopping/revoking never deprovisions resources.

`c2c destroy --json` produces a read-only plan with ownership checks. The Skill
then verifies the exact bound plugin ID/name/Server URL in ChatGPT and deletes
only that plugin (or verifies that exact ID is already absent). Legacy bindings
without a plugin ID require verified `connector bind` before deletion. Inspect
any pending desired name/URL too, so partial browser setup is not forgotten.
Execute only after those UI actions:

```bash
c2c destroy -w <workspace> --confirm --connector-removed <bound-plugin-id> --json
```

Add `--desired-connector-absent` only when an unreconciled desired plugin has
been verified absent or its owned partial plugin has been removed. Omit the
bound-plugin flag when the plan has no bound connector. These local flags are
agent receipts, not direct ChatGPT API calls; runtime cannot independently
prove a browser deletion. The Skill must enforce those ownership checks.

Destroy retains a receipt before revoke/stop, then rechecks/removes owned DNS,
deletes the exact UUID/name without forcing active connections, and finally
removes only that workspace's auth/runtime/endpoint/tunnel/registration and
daemon log. For upgrades, it also cleans obsolete workspace-keyed session and
execution files; no active feature reads or writes them. Failure retains state and receipt;
retry `destroy --confirm`. Other setup commands are blocked during destroy.
Shared credentials, global prefs/logs, other workspaces, repository configuration
and ChatGPT Project/chat history are not removed.

## Failure boundaries

- Lifecycle CLI commands serialize per workspace. A crash leaves a lock; verify
  the recorded PID is gone before removing that specific lock file. No automatic
  age-based lock takeover or resource adoption.
- Cloudflare does not provide a transaction spanning tunnel/DNS/local state.
  A create response lost before receiving its UUID has an uncertain outcome:
  intent retains the requested name, but automatic adoption/deletion is unsafe.
  Verify the created UUID/account ownership manually before restoring the journal.
  Missing API credentials can likewise leave a tracked cleanup pending.
- External dashboard edits can race checks. DNS/tunnel IDs and targets are
  rechecked, but there is no cross-service conditional-delete guarantee. Stop on
  conflicts; never use a force-delete or force DNS overwrite to bypass them.
- Connector deletion/recreation can succeed before the local acknowledgement.
  Reconcile by exact observed plugin ID/name/URL, then verify MCP and bind;
  never treat a green local health check as proof of a ChatGPT binding.
- Destroy cannot discover undocumented historical resources absent from saved
  state, or other DNS aliases manually attached to a tunnel. Inspect those
  manually; the command only removes its recorded hostname/UUID.
