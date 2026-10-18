# Desk C2C Hub architecture

```text
ChatGPT MCP client → HTTPS tunnel → loopback bridge → owner's registered repos
                                     │
                              OAuth / pairing
                                     │
Codex Skill → local c2c CLI → authenticated local admin API
```

The Skill manages setup, naming, connection verification and lifecycle. MCP is
the read-only data plane. Successful setup or reconnect ends at `MCP READY`.

## Components

| Module | Responsibility |
| --- | --- |
| `bridge/` | Express assembly, loopback listener, port fallback, runtime discovery and local admin API |
| `mcp/` | Read-only tools and stateless Streamable HTTP transport |
| `auth/` | OAuth discovery, client registration, PKCE, token rotation/revocation and token hashes |
| `pairing/` | Expiring one-time pairing codes, attempt limits and rate limiting |
| `workspace/` | Owner-scoped registry, canonical containment, ignore rules, detection, reads, search and git |
| `tunnel/` | Quick/Named cloudflared processes, provisioning, naming and rollback |
| `process/` | Daemon spawn/reuse and local admin requests |
| `lifecycle/` | Workspace operation locks and connection lifecycle |
| `config/` | External state, display names, desired/bound endpoint, UI preferences and explicit updates |
| `cli/` | `c2c` commands driving the bridge and lifecycle |
| `logger/` | Local diagnostics with credential redaction |

## Request flow

Authorization follows protected-resource discovery, OAuth server discovery,
client registration, authorization with pairing, and PKCE code exchange.
An MCP request passes bearer validation before its tool handler checks the
required scope. Streamable HTTP uses a fresh server and transport per POST.

Workspace selection is independent on every call. The handler resolves a
registered alias or ID within the startup owner's registry, then applies the
selected workspace's path and content policies. See [multi-repo access](multi-repo.md)
for selectors and schemas, and [security](security.md) for authorization boundaries.

The canonical startup root determines the bridge's `workspaceId`. Its resource
identity is separate from display names and registered read targets. The listener
prefers port 48765 and falls back to a free port on collision. Runtime discovery
distinguishes a matching healthy bridge, a stopped process and uncertain state
before automatic repair.

## Public connection and binding

Quick Tunnel addresses may change on restart. Named Tunnel UUID, name, zone and
hostname are persisted outside the repo. Desired endpoint settings and the last
verified ChatGPT binding are stored separately. Doctor keeps reconciliation
pending until actual MCP verification and `connector bind` acknowledge the target.
See [lifecycle](lifecycle.md) for naming, reconnect and disconnect operations.

## Development checks

```bash
corepack pnpm test
corepack pnpm build
corepack pnpm typecheck
git diff --check
```

Source and tests are organized by feature. `tests/integration/` covers workflows
across features. `tests/helpers.ts` provides shared fixtures. Build replaces
compiled output from `src/`.
