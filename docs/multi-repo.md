# Multi-repo access

One MCP connection can read multiple explicitly registered local repos. A stable
local Hub owns those grants, independently of every repo path.

## Register and remove workspaces

```bash
c2c workspace list --json
c2c workspace add /path/to/repo --alias backend
c2c workspace add /path/to/another-repo
c2c workspace remove backend
c2c workspace remove <workspaceId>
```

One configured Hub is selected automatically. With several Hubs, inspect
`c2c hub list --json` and pass `--hub <id>` to the command. No Hub returns
`HUB_NOT_CONFIGURED`; ambiguous selection returns `HUB_SELECTION_REQUIRED`.
A repo path never selects registry ownership.

Bare `c2c workspace -w <path> [--json]` inspects the repo without creating,
adopting or selecting a Hub. Setup registers its initial repo; starting a Hub
does not register or restore grants. Removing even the first repo persists
across restarts. Changes take effect on the next MCP call without restarting,
changing auth or touching tunnel/connector state. Disconnect retains grants.

## Identity and aliases

Roots are canonicalized with `realpath`. A root's `workspaceId` is a deterministic
hash of its canonical path; display names and aliases do not change that identity.

Default aliases are `<directory-slug>-<workspaceId>`, independent of registration
order, including repos with identical directory names. Explicit aliases contain
lowercase letters/digits separated by hyphens, at most 100 characters, and cannot
be a 12-character hexadecimal workspace ID. Alias conflicts fail without changing
grants. Re-adding a root preserves its alias unless `--alias` changes it.
Aliases are unique within a Hub's registry and may be reused by other Hubs.

## MCP selection

`list_workspaces` takes `{}` and returns safe aliases and IDs without local roots:

```json
{
  "workspaces": [
    { "workspaceId": "0123456789ab", "alias": "backend" }
  ]
}
```

The workspace tools accept an optional string `workspace` containing a registered
alias or ID from that connection's list. A local path is never a workspace selector.
For example:

```json
{ "workspace": "backend", "path": "src/index.ts" }
```

Each tool call independently reads the owner's registry and constructs the
selected workspace and its policies. No call establishes a current/open workspace.
If `workspace` is omitted and exactly one workspace is registered, it is selected.
If several are registered, `WORKSPACE_REQUIRED` returns a safe alias/ID list.
All selected roots retain canonical containment, sensitive-file and git policies;
see [security](security.md).

| Error | Meaning |
| --- | --- |
| `WORKSPACE_REQUIRED` | Multiple registrations exist; pass an alias or ID from `list_workspaces` |
| `WORKSPACE_NOT_FOUND` | Selector is not registered to this owner, or the registry is empty |
| `WORKSPACE_UNAVAILABLE` | Registered root is missing or its canonical identity has changed; re-register locally |
| `INVALID_WORKSPACE_ALIAS` | Alias violates the naming rules |
| `WORKSPACE_ALIAS_CONFLICT` | Another root already uses that alias in this owner's registry |
| `INVALID_WORKSPACE_OWNER` | Registry owner is not a valid Hub ID or does not match the configured Hub |
| `WORKSPACE_REGISTRY_INVALID` | Registry is unreadable, malformed or belongs to a different owner; access is denied |
| `WORKSPACE_REGISTRY_BUSY` | A local registry writer holds the owner's lock |

## MCP tools

| Tool | Read-only responsibility | Scope |
| --- | --- | --- |
| `list_workspaces` | Registered aliases and workspace IDs | `workspace.read` |
| `workspace_info` | Identity, display name, project detection and git overview | `workspace.read` |
| `list_directory` | Paginated workspace tree | `workspace.read` |
| `read_file` | Bounded, paginated text reads | `workspace.read` |
| `read_image` | Bounded, validated PNG, JPEG, GIF, WebP or SVG reads | `workspace.read` |
| `search_workspace` | Search using ripgrep or Node fallback | `workspace.search` |
| `git_status` | Branch and working-tree status | `git.read` |
| `git_diff` | Scoped git diff with byte-offset pagination | `git.read` |

## Registry storage

Hub identity lives in `hubs/<hubId>.json` in the external C2C state directory.
The ID is random and independent of repo paths and labels. Fresh setup may use
the first repo's display name as a suggestion; it creates no workspace-owner
mapping. For example:

```json
{
  "version": 1,
  "hubId": "hub-550e8400-e29b-41d4-a716-446655440000",
  "displayName": "My Hub",
  "createdAt": "2026-10-18T08:00:00.000Z"
}
```

`workspace-registries/<hubId>.json` stores the Hub's read grants. `C2C_STATE_DIR`
can override the state directory. No repository configuration is written.

```json
{
  "version": 2,
  "hubId": "hub-550e8400-e29b-41d4-a716-446655440000",
  "workspaces": [
    { "workspaceId": "0123456789ab", "alias": "backend", "root": "/canonical/local/repo" }
  ]
}
```

Registry ownership must match the running Hub. Writes use an exclusive local
lock and atomic replacement. Native stores never import old files or merge
other Hubs' grants. See [troubleshooting](troubleshooting.md) for explicit upgrade
and lock recovery. All connection resources and destroy receipts are Hub-owned.
