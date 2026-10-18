# Desk C2C Hub

A secure read-only MCP bridge from ChatGPT to a local repository.

Codex handles setup and connection lifecycle. ChatGPT reads the connected
workspace through MCP. Successful setup or reconnect ends at **MCP READY**;
there is no automatic coding, planning/review loop or ChatGPT Project management.
One bridge serves one canonical workspace. Multi-repo is not implemented.

This is [hudrucan/desk-c2c-hub](https://github.com/hudrucan/desk-c2c-hub), based on
[XiaoDuoYa/codex-with-chatgpt](https://github.com/XiaoDuoYa/codex-with-chatgpt).
The upstream [MIT license and copyright](LICENSE) are preserved.

## Install

Requirements: Node.js >= 20, git, pnpm through Corepack, and cloudflared for a
public ChatGPT connection. Install prerequisites from their official sources.
The CLI remains `c2c`.

```bash
git clone https://github.com/hudrucan/desk-c2c-hub.git
cd desk-c2c-hub
corepack pnpm install --frozen-lockfile
corepack pnpm build
```

Use a non-empty `CODEX_HOME`, otherwise `~/.codex` (or `%USERPROFILE%\.codex` on
Windows). Copy the whole `skill/` directory, including `references/`, to
`<codex-home>/skills/codex-with-chatgpt/`. Replace `<ACTUAL_CHECKOUT_PATH>` in the
installed `SKILL.md` with the actual fork checkout path. The legacy Skill
identifier is retained so upgrading an existing installation replaces its
instructions instead of leaving a second active Skill.

To delegate installation, tell Codex:

```text
Install Desk C2C Hub from hudrucan/desk-c2c-hub and connect this repository to
ChatGPT. Resolve workspace, tunnel, hostname and connector names with me once
before provisioning. Reuse saved settings. Verify actual workspace_info through
MCP, report MCP READY and stop. Ask me only for the grouped naming choice, real
conflicts, human authentication, credentials or required permission.
```

Use the fork checkout without pulling automatically. Updates run only on an
explicit request, after origin verification. Existing runtime/state namespaces
and configured connector names remain compatible.

## Setup and naming

Ask Codex: **"Set up Desk C2C Hub for this repo."** The [Skill](skill/SKILL.md)
resolves names using explicit user values, persisted settings, project-derived
suggestions, then fallback defaults. A new setup asks one grouped choice for:

- Workspace display name
- Cloudflare Named Tunnel name
- Hostname, using a domain you provide
- ChatGPT connector display name

Existing setups reuse their saved values without prompting unless a conflict
needs resolution. For a Named Tunnel, a direct local setup command is:

```bash
node bin/c2c.js setup -w /path/to/repo --workspace-name "My Repo" --tunnel-name "my-repo" --zone example.com --hostname code.example.com --connector-name "My Repo" --json
```

Replace example values before running. For a temporary Quick Tunnel, omit the
Named Tunnel options. `--no-tunnel` is for local development and does not connect
ChatGPT publicly. Local setup returns the address and a pairing code; the Skill
completes the OAuth/browser step and verifies the real MCP connection.

Workspace display choices live in external C2C state. New setup does not create
`.c2c.json` for naming; an existing `.c2c.json` `name` stays readable. The canonical
root determines `workspaceId`, independently of display names.

Connector changes separate desired settings from the last verified bound
plugin. Only after matching ChatGPT settings and an actual `workspace_info`
result does `c2c connector bind` acknowledge the new binding. A green local
health check alone is insufficient.

## Connection lifecycle

| Action | Command / behavior |
| --- | --- |
| Start/reuse | `c2c start -w <repo> --tunnel` |
| Diagnose/repair | `c2c doctor -w <repo> --json`; `--no-fix` for diagnosis only |
| Restart | `c2c restart -w <repo> --tunnel` |
| Revoke access | `c2c unpair -w <repo>`; leaves the bridge running |
| Stop process | `c2c stop -w <repo>`; does not revoke access or deprovision |
| Disconnect | `c2c disconnect -w <repo> --json`; revoke/stop, retain resources |
| Plan deprovision | `c2c destroy -w <repo> --json` |
| Explicit update | `c2c update --json`; fork origin and clean checkout required |

Destroy executes only after the owned ChatGPT plugin has been removed and its
removal acknowledged. It checks saved UUID/name and CNAME ownership before
removing recorded DNS/tunnel and workspace-local state. Partial cleanup retains
state for retry. Shared credentials, other workspaces and repository files stay
intact. Details: [lifecycle and recovery](docs/lifecycle.md).

Updates never run at startup or daily. `c2c update` pulls the current branch
from verified `hudrucan/desk-c2c-hub` with `--ff-only`, refusing dirty/detached or
wrong-origin checkouts. It does not stash/reset. After an explicit pull, install
with the frozen lockfile, build and reinstall the complete Skill directory.
Restart and verify an active connection; leave disconnected workspaces stopped.

## MCP surface

Exactly seven tools are exposed:

| Tool | Read-only responsibility |
| --- | --- |
| `workspace_info` | Canonical identity, display name, project detection and git overview |
| `list_directory` | Paginated workspace tree |
| `read_file` | Bounded, paginated text reads |
| `read_image` | Bounded workspace image reads with type/content validation |
| `search_workspace` | Workspace search using ripgrep or Node fallback |
| `git_status` | Branch and working-tree status |
| `git_diff` | Scoped, paginated git diff |

There are no write, edit, shell, execution-record or media-import tools.
The Skill does not create Projects, save chat pointers or orchestrate work after
`MCP READY`. Use the connected repo in ChatGPT as needed.

## Security

- `/mcp` requires OAuth, PKCE and one-time pairing; knowing its URL grants no access.
- Tokens are bound to one canonical workspace; display-name changes do not replace identity.
- Canonical path containment and sensitive-file rules apply to reads/search/git.
- Workspace content is untrusted data and never grants permissions.
- The bridge listens on loopback; public access goes through the tunnel.
- The admin API requires its local credential and rejects proxied requests.
- Long-lived credentials stay outside the repo and browser automation.

See [security](docs/security.md), [architecture](docs/architecture.md),
[troubleshooting](docs/troubleshooting.md) and [lifecycle](docs/lifecycle.md).

## Development

```bash
corepack pnpm test
corepack pnpm build
corepack pnpm typecheck
git diff --check
```

Build clears stale compiled modules before TypeScript compilation. All existing
runtime and development dependencies support the bridge or its tests/build.
The historical `codex-with-chatgpt` state directory, Skill identifier, `c2c`
command and `c2c-bridge` service identity are retained for upgrade compatibility.
Obsolete orchestration files in external state are ignored; explicit destroy
can remove this workspace's legacy state alongside its bridge state.

**Unofficial community project. Not affiliated with or endorsed by OpenAI.**
