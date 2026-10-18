# Multi-repo access

One MCP connection can read multiple explicitly registered local repos. A stable
local Hub owns those grants. The configured startup workspace resolves its Hub
through an explicit local mapping. Different legacy owners resolve different Hubs,
even in the same C2C state directory.

## Register and remove workspaces

```bash
c2c workspace list -w /path/to/hub-root --json
c2c workspace add /path/to/repo -w /path/to/hub-root --alias backend
c2c workspace add /path/to/another-repo -w /path/to/hub-root
c2c workspace remove backend -w /path/to/hub-root
c2c workspace remove <workspaceId> -w /path/to/hub-root
```

For these commands, `-w` selects the configured startup root used to resolve its
Hub, defaulting to the current directory. The repo to add is a separate positional path. Adding a repo
grants read access without starting another bridge or provisioning resources.
Bare `c2c workspace -w <path> [--json]` shows local identity and project information
without registering that path.

The bridge automatically registers its canonical startup root when it starts.
Registration changes take effect on the next tool call. Removing the startup
root revokes its grant too; starting that bridge again registers the root again.
Disconnect retains registrations. Grants do not transfer ownership of tokens,
tunnels, runtime state or connector bindings; those belong to the startup owner.
See [lifecycle](lifecycle.md) for connection operations.

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
`hubId` is an opaque random UUID with a `hub_` prefix, independent of repo paths
and display names. The initial display name uses the configured workspace's name;
resolving that connection again preserves the Hub's identity and display name.
The optional `legacyOwnerWorkspaceId` links an existing connection to its Hub.

```json
{
  "version": 1,
  "hubId": "hub_550e8400-e29b-41d4-a716-446655440000",
  "displayName": "My Hub",
  "createdAt": "2026-10-18T08:00:00.000Z",
  "legacyOwnerWorkspaceId": "abcdef012345"
}
```

`hub-mappings/<legacyOwnerWorkspaceId>.json` records the one-to-one connection
mapping and whether registry initialization completed:

```json
{
  "version": 1,
  "legacyOwnerWorkspaceId": "abcdef012345",
  "hubId": "hub_550e8400-e29b-41d4-a716-446655440000",
  "registryInitialized": true
}
```

`workspace-registries/<hubId>.json` stores the Hub's read grants, separately from
display names in `workspaces/`. `C2C_STATE_DIR` can override the state directory.
No repository configuration is written. Hub IDs remain internal: CLI owner
selection uses `-w`, and MCP selectors remain workspace aliases or IDs.

```json
{
  "version": 2,
  "hubId": "hub_550e8400-e29b-41d4-a716-446655440000",
  "workspaces": [
    { "workspaceId": "0123456789ab", "alias": "backend", "root": "/canonical/local/repo" }
  ]
}
```

The registry's Hub ID must match the configured connection's Hub mapping.
An owner-scoped `workspace-registries/<legacyOwnerWorkspaceId>.json` can be copied
only if its ownership metadata matches that exact owner. Aliases and grants are
preserved, and the source file is retained. Conflicting destination grants are
rejected rather than merged or overwritten. Initialization is checkpointed so
removed grants are not re-imported on later resolutions. An interrupted copy can
resume only when the destination matches the verified source.

Registries from other owners and the unowned `workspace-registry.json` are never
adopted. Missing Hub targets, malformed state, duplicate owner claims and
conflicting mappings deny access. Hub metadata and registration do not change
OAuth scopes, auth/runtime/tunnel/endpoint storage keys or connector bindings.
Resource cleanup remains keyed by the configured startup workspace.

Registry writes use an exclusive Hub-local `.lock` file and atomic replacement;
identity claims and adoption also hold `hub-mappings/.lock`. For leftover locks
or inaccessible state, follow
[troubleshooting](troubleshooting.md#local-process-and-tunnel-diagnostics).
