# Desk C2C Hub

A secure read-only MCP bridge from ChatGPT to a local repository.

Codex handles setup and connection lifecycle. ChatGPT reads the connected
workspace through MCP. Successful setup or reconnect ends at **MCP READY**;
there is no automatic coding, planning/review loop or ChatGPT Project management.
Each bridge retains one canonical startup owner and can read additional local
repos explicitly registered to that owner.

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

## Registered workspaces (phase 1)

One existing MCP connection can read multiple explicitly registered local repos:

```bash
c2c workspace list -w /path/to/hub-root --json
c2c workspace add /path/to/repo -w /path/to/hub-root --alias backend
c2c workspace add /path/to/another-repo -w /path/to/hub-root
c2c workspace remove backend -w /path/to/hub-root
c2c workspace remove <workspaceId> -w /path/to/hub-root
```

The bridge automatically registers its canonical startup root. Adding a repo
only grants read access; it does not start another bridge or provision resources.
For these subcommands, `-w` selects the canonical bridge startup root (the owner);
the repo to add is a separate positional path. If `-w` is omitted, the current
directory selects the owner. Each owner's registrations are isolated even when
multiple bridges use the same local C2C state directory. Aliases are unique
within an owner's registry, and can be reused by different owners.
Removing a registration takes effect on the next tool call, including removal
of the startup root. Starting that bridge again registers its root again.
The existing `c2c workspace -w <path> [--json]` command still shows local identity
and project info without registering the path.

`workspace-registries/<ownerWorkspaceId>.json` lives in the external C2C state
directory (overridden by `C2C_STATE_DIR`), separately from saved display names
in `workspaces/`. Its owner must match the bridge's startup workspace ID:

```json
{
  "version": 1,
  "ownerWorkspaceId": "abcdef012345",
  "workspaces": [
    { "workspaceId": "0123456789ab", "alias": "backend", "root": "/canonical/local/repo" }
  ]
}
```

The earlier unowned `workspace-registry.json` is ignored, left intact and never
automatically migrated: its grants cannot be safely attributed to a bridge owner.
Existing single-repo connectors therefore gain no access to another owner's repos.

No repository configuration is written. IDs retain the existing canonical-root
hash. Default aliases are `<directory-slug>-<workspaceId>`, independent of add
order, including repos with identical directory names. Explicit aliases use
lowercase letters/digits separated by hyphens, at most 100 characters, and cannot
be a 12-digit hexadecimal workspace ID. Conflicts fail without modifying grants.
Re-adding a root preserves its alias unless `--alias` explicitly changes it.
Local registry writes use an exclusive `.lock` file and atomic replacement.
If a writer crashes leaving a lock, verify no registry writer is running before
removing only that owner's `workspace-registries/<ownerWorkspaceId>.json.lock`.

MCP `list_workspaces` takes `{}` and returns
`{ "workspaces": [{ "workspaceId": "0123456789ab", "alias": "backend" }] }`.
All seven existing workspace tools accept an optional string `workspace` input,
with their existing arguments and success outputs unchanged. For example:
`read_file({ "workspace": "backend", "path": "src/index.ts" })`.
The selector accepts only a registered alias or ID, never a local path.

Each tool call independently reloads the registry and constructs the selected
Workspace and its policies. With one registration, omission selects that repo.
With multiple registrations, omission returns `WORKSPACE_REQUIRED` and a safe
`workspaces` alias/ID list. Unknown selectors or an empty registry return
`WORKSPACE_NOT_FOUND`; missing/replaced canonical roots return
`WORKSPACE_UNAVAILABLE`. No call establishes an open/current workspace.

OAuth scopes, token ownership, tunnel/runtime ownership, connector binding and
Skill setup remain unchanged in this phase. Existing
credentials on the connection authorize the applicable read scopes across the
explicit grants in that connection owner's registry. Registry removal only
revokes that read grant; connection/resource lifecycle commands still operate
on the original workspace. Disconnect retains the registry. Destroy removes only
that owner's registry at the final successful local cleanup; partial or failed
destroy retains it for recovery. Other owners' registries and the unowned legacy
registry remain untouched.

## MCP surface

Eight read-only tools are exposed:

| Tool | Read-only responsibility |
| --- | --- |
| `list_workspaces` | Registered aliases and workspace IDs, without local roots |
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
- Tokens remain bound to the bridge startup identity; applicable read scopes cover only workspaces explicitly registered to that owner. Display-name changes do not replace identity.
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
