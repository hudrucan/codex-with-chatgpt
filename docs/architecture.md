# Desk C2C Hub architecture

```text
ChatGPT MCP client → HTTPS tunnel → loopback bridge → Hub's registered repos
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
| `hub/` | Independent identity, deterministic discovery and explicit selection |
| `workspace/` | Hub-scoped registry, canonical containment, ignore rules, detection, reads, search and git |
| `project/` | Optional Hub-scoped Project memberships, many-to-many workspace routing and deterministic instructions |
| `tunnel/` | Quick/Named cloudflared processes, provisioning, naming and rollback |
| `process/` | Daemon spawn/reuse and local admin requests |
| `lifecycle/` | Hub operation locks, resource receipts and connection lifecycle |
| `config/` | External state, display names, desired/bound endpoint, UI preferences and explicit updates |
| `cli/` | `c2c` commands driving the bridge and lifecycle |
| `logger/` | Local diagnostics with credential redaction |

## Request flow

Authorization follows protected-resource discovery, OAuth server discovery,
client registration, authorization with pairing, and PKCE code exchange.
An MCP request passes bearer validation before its tool handler checks the
required scope. Streamable HTTP uses a fresh server and transport per POST.

Workspace selection is independent on every call. The handler resolves a
registered alias or ID within the configured Hub's registry, then applies the
selected workspace's path and content policies. See [multi-repo access](multi-repo.md)
for selectors and schemas, and [security](security.md) for authorization boundaries.

A random, persistent `hub-<uuid>` identifies the Hub independently of repos.
Zero configured Hubs require setup; one is selected automatically; multiple Hubs
require an exact `--hub` selector. OAuth clients/tokens, pairing, runtime,
tunnel/endpoint bindings, lifecycle receipts and registry grants belong to the Hub.
A repo is an explicit read grant and can be removed without changing resources.
No original repo path is needed to start, stop or inspect the Hub.

The listener prefers port 48765 and falls back to a free port on collision.
Runtime discovery reads only `runtime/<hubId>.json` and distinguishes healthy,
stopped and uncertain processes before repair. Runtime reads only Hub-owned
state and stores no workspace identity or root. A bridge can run with zero or
more registered repos; hot registration changes leave its health, admin metadata
and process identity unchanged. MCP selection remains stateless.

## Public connection and binding

Quick Tunnel addresses may change on restart. Named Tunnel UUID, name, zone and
hostname are persisted outside the repo. Desired endpoint settings and the last
verified ChatGPT binding are stored separately. Doctor keeps reconciliation
pending until actual MCP verification from a workspace registered to the Hub and
`connector bind` acknowledge the exact connector ID, name and endpoint.
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
