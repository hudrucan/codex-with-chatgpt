# Desk C2C Hub architecture

```text
ChatGPT MCP client → HTTPS tunnel → loopback bridge → owner's registered repos
                                     │
                              OAuth / pairing
                                     │
Codex Skill → local c2c CLI → authenticated local admin API
```

The Skill is a small control plane for setup/naming, connection binding,
verification and lifecycle. The MCP connection is the read-only data plane.
Successful setup/reconnect ends at `MCP READY`; there is no Project/session
management, execution recording or automatic planning/review protocol.

## Components

| Module | Responsibility |
| --- | --- |
| `bridge/` | Express assembly, loopback listener, port fallback, runtime discovery, local admin API |
| `mcp/` | Eight read-only tools and stateless Streamable HTTP transport |
| `auth/` | OAuth discovery, client registration, PKCE S256, token rotation/revocation; opaque tokens stored as hashes |
| `pairing/` | Expiring one-time pairing codes, attempt limits and rate limiting |
| `workspace/` | Canonical containment, sensitive-file/ignore rules, project detection, read/list/image/search/git |
| `tunnel/` | Quick/Named cloudflared processes, resource provisioning, rename rollback and ownership-checked DNS cleanup |
| `process/` | Daemon spawn/reuse and local admin requests |
| `lifecycle/` | Workspace operation locks, disconnect and ownership-checked destroy |
| `config/` | External state, display names, desired/bound endpoint, UI preferences and explicit fork update |
| `cli/` | `c2c` commands driving the bridge and lifecycle |
| `logger/` | Local diagnostics with credential redaction |

## Requests and identity

An MCP request passes bearer validation before the tool handler. Each tool
checks its scope, independently resolves a registered alias/ID within the startup
owner's `workspace-registries/<ownerWorkspaceId>.json`, then resolves paths within
that canonical root and applies bounds/ignore rules before returning data.
`list_workspaces` returns only that owner's aliases and IDs; there is no mutable
current workspace or cross-owner registry fallback. `read_image` returns bounded
validated image content; it never imports or writes media.

Authorization follows protected-resource discovery, OAuth server discovery,
client registration, authorization + pairing, and PKCE code exchange. Tokens
bind client and workspace identities. Refresh rotation and revocation are
unchanged. New grants advertise workspace.read, workspace.search, git.read and
offline_access; execution.read no longer represents a tool capability. Existing
tokens carrying that historical scope still work for their remaining core scopes.

The root-derived `workspaceId` remains stable through display-name changes.
A local external registration takes precedence over legacy `.c2c.json` `name`;
otherwise the root basename is used. Legacy loop-limit fields are ignored.
The listener prefers port 48765; runtime discovery distinguishes a matching
healthy bridge, a stopped process and uncertain state before automatic repair.

## Public connection and binding

Quick Tunnel addresses may change on restart. Named Tunnel UUID, chosen name,
zone and hostname are persisted outside the repo. An explicit naming conflict
never falls back to another name/address. In-place tunnel rename retains the
UUID; hostname migration and rollback verify CNAME targets.

Current desired endpoint/name and last verified ChatGPT binding are distinct.
The Skill checks exact plugin ID/name/URL, obtains a real `workspace_info` result,
then acknowledges with `connector bind`. Doctor keeps reconciliation pending
until that acknowledgement. It does not rely on chat history or saved sessions.

Disconnect revokes/stops while retaining resources. Destroy checks ownership,
uses verified browser-removal receipts, cleans recorded DNS/tunnel, and only
then removes workspace-local state. It retains failure receipts for retry.
See [lifecycle](lifecycle.md) for remote transaction boundaries and recovery.

## Compatibility

The CLI remains `c2c`, the service identity remains `c2c-bridge`, and the existing
OS state namespace remains `codex-with-chatgpt`. Existing connector names are
not regenerated; new default suggestions use Desk C2C Hub. Obsolete external
session/execution files are not loaded, exposed or migrated automatically.
Destroy retains targeted cleanup of those old workspace-keyed files.
