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

## ChatGPT Project bindings

One Hub connector serves many workspaces, each with an optional single ChatGPT
Project binding. [Project instructions apply across its chats](https://learn.chatgpt.com/docs/projects).
The binding supplies durable workspace selection, without a separate connector
or any chat/task/session protocol. Workspace IDs are authoritative; aliases and
display names are labels.

```bash
c2c project status --workspace backend --json
c2c project instructions --workspace backend --json
# After applying exact instructions and verifying MCP inside the selected Project:
c2c project bind --workspace backend --project-url "<project-url>" --instruction-hash <verified-hash> --json
c2c project unbind --workspace backend --json
```

Hub selection follows the usual single-Hub discovery or explicit `--hub <id>`.
Project URLs must be HTTPS `chatgpt.com` Project landing URLs, such as
`https://chatgpt.com/g/g-p-6ad414a9a390819194cd6a676854de21-desk-home/project`,
without chat paths, queries or fragments. A title match is not Project identity.
The stable `g-p-...` ID can be bound to only one `(hubId, workspaceId)` across
all local Hubs, regardless of URL slug/title. Conflicts return
`PROJECT_BINDING_CONFLICT`; explicitly unbind before reassignment. Re-acknowledging
the same workspace's own Project is allowed. An exclusive Project-state lock
serializes cross-Hub checks and writes; malformed binding state fails closed.

`instructions` uses the registered workspace's ID, alias, display name and the
Hub's verified connector ID/name/bound URL. It requires a reconciled connector
binding and emits deterministic text plus its SHA-256 `instructionHash`.
Every workspace-scoped tool must use `workspace="<workspaceId>"`, starting with
`workspace_info` to confirm that exact identity. Metadata or instruction version
changes require explicit instruction sync. Runtime PID, port and restart time
are excluded; restoring the same MCP URL leaves instructions current.
The generated text and hash include these exact managed-block markers:

```text
--- BEGIN DESK C2C HUB WORKSPACE BINDING ---
...
--- END DESK C2C HUB WORKSPACE BINDING ---
```

The Skill preserves unrelated Project instructions and replaces only one exact
managed block. Multiple/ambiguous blocks require explicit resolution.

`status` reports local metadata only:

| Status | Meaning |
| --- | --- |
| `unbound` | Registered workspace has no saved Project acknowledgement |
| `current` | Saved instruction version/hash matches the current generated block |
| `sync_required` | Apply current instructions in the saved Project and verify MCP before acknowledging |
| `stale` | Workspace grant/root is unavailable, or the Hub connector is not verified/reconciled |

`projectVerification: "not_checked"` always distinguishes this local result from
ChatGPT verification. The Skill opens the exact saved Project, confirms the
instruction block and verifies MCP within it. For an unbound workspace it asks
once to choose an existing Project or create one; declining leaves it unbound.
For stale instructions it updates the same Project in place, preserving unrelated
user instructions. A missing/inaccessible Project, conflicting connector,
unconfirmed instruction block or mismatched MCP workspace stops the flow without
replacement resources. See the [Skill procedure](../skill/references/projects.md).

`bind` acknowledges completed UI/MCP verification; it does not modify ChatGPT or
prove access on its own. Its hash must equal the currently generated hash.
Removing a workspace retains its binding and never deletes a Project. Inspect
or unbind a removed registration using its exact stored workspace ID. Rebinding
requires explicit registration and fresh UI/MCP verification. `unbind` only
removes local acknowledgement, leaving the Project and its instructions intact.

External state at `project-bindings/<hubId>/<workspaceId>.json` is versioned,
Hub/workspace-scoped and atomically written with owner-only permissions:

```json
{
  "version": 1,
  "hubId": "hub-550e8400-e29b-41d4-a716-446655440000",
  "workspaceId": "0123456789ab",
  "projectUrl": "https://chatgpt.com/g/g-p-6ad414a9a390819194cd6a676854de21-desk-home/project",
  "instructionVersion": 1,
  "appliedInstructionHash": "<sha256-of-generated-instructions>",
  "updatedAt": "2026-10-18T14:00:00.000Z"
}
```

No conversation URL, task/checkpoint state, raw credentials or repo contents are
stored. Malformed or foreign binding files and symlinked state paths fail closed.
Project bindings never widen workspace grants or alter connection lifecycle.
Pending destroy receipts block bind/unbind with `DESTROY_PENDING`; read-only
diagnostics remain available. Hub destroy preflights this Hub's binding files
before remote deletion, rejects malformed/foreign/unexpected/symlinked state,
and removes validated local acknowledgements before Hub identity. Failures retain
the destroy receipt for retry. ChatGPT Projects and their Instructions are never
automatically deleted.

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
