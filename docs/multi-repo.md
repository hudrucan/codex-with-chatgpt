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
or selecting a Hub. Setup registers its initial repo; starting a Hub
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
| `git_diff` | Scoped immutable diff snapshots with byte-offset pagination | `git.read` |
| `git_log` | Bounded HEAD commit history, optionally filtered by path | `git.read` |
| `git_show` | Bounded commit patch by full SHA | `git.read` |

`read_file` rejects files larger than **16 MiB (16,777,216 bytes)** with
`FILE_TOO_LARGE` before scanning lines; no partial content is returned. Files
within the limit retain line pagination and exact `totalLines`, with the existing
400-line default, 2,000-line maximum and response byte limits.

`list_directory` discovers at most `offset + limit + 2000` visible entries per
call, in deterministic directory-first traversal order. Depth is capped at 4 and
page size at 1,000. `truncated=false` means traversal finished at the requested
depth and `total` is exact. `truncated=true` means discovery stopped at the scan
budget: `total` counts only discovered entries and `hasMore` remains true.
Otherwise, `hasMore` indicates whether another page of discovered entries exists.
Ignored, sensitive and high-noise entries are omitted from visible results.

### Git history

`git_log` accepts `workspace`, optional literal workspace-relative `path`, and
`limit` (default 20, maximum 100). It returns `commits` in HEAD topology order,
newest first, and `hasMore`. Only commits with visible changes in scope are
listed. Each commit includes:

- `sha`: full commit SHA, usable with `git_show`.
- `subject`: Git's subject (`%s`, the first message paragraph), with control
  characters replaced by spaces, trimmed and limited to 256 UTF-8 bytes without
  splitting a character. `subjectTruncated` reports byte-limit truncation.
- `date`: committer date normalized to UTC ISO 8601; no author/committer identity
  or email is returned.
- `paths`: up to 20 unique, filtered workspace-relative changed paths within the
  requested scope. Paths longer than 512 UTF-8 bytes are omitted rather than
  shortened. `pathsTruncated` reports omitted visible paths due to these limits;
  it does not count sensitive paths. Merge paths include changes against each
  parent, matching the history inventory.

Metadata is read only for the selected visible commits, under the existing
16 MiB per-read budget and shared request deadline. Commit bodies, signatures,
notes and decorations are withheld. There is no pagination cursor; increase
`limit` up to the cap.

Subjects are untrusted free-form text and may contain credentials, sensitive
filenames or information unrelated to visible paths. A mixed public/private
commit still exposes its subject when it has a visible change. Path filtering,
control-character normalization and length limits do **not** redact secrets;
no automatic subject redaction or absolute safety guarantee is provided.
Keep secrets out of commit subjects when exposing repository history.

`git_show` requires `commit`, a full lowercase 40- or 64-character commit SHA;
branches, tags, abbreviated IDs and revision expressions are rejected.
Commits outside HEAD ancestry are rejected with `GIT_FAILED`, even if their
objects exist locally or in an alternate object store. Optional
`path` limits the patch to a literal workspace-relative file or directory.
`max_bytes` defaults to 64 KiB and permits 1–256 KiB. The response includes
`commit`, `comparison`, `diff`, exact `totalBytes`, `returnedBytes` and `truncated`.
The UTF-8 patch ends within the byte limit. There is no snapshot or continuation;
narrow `path` when truncated. Root commits compare against an empty tree
(`comparison="root"`); every other commit, including merges, compares against
its first parent (`comparison="first-parent"`). Only Git objects are read;
uncommitted working-tree contents are not included.

Both tools apply current sensitive-file rules and every recorded version of the
workspace's `.c2cignore` in history reachable from local refs, HEAD and the
requested commit. Policy files themselves are withheld. Paths associated with
sensitive or out-of-workspace paths through renames or identical blob copies
are withheld across all scanned revisions, including later sanitized edits.
Deletion/addition pairs in one commit are linked conservatively, protecting
rewritten renames even when Git detects no similarity. This can hide unrelated
files with shared content or additions made alongside a sensitive deletion.
Symlinks and submodules are withheld. Filtering is based on file policy and
provenance, not general secret detection inside otherwise permitted files.

At most two history reads run at once per Hub process; additional calls return
`GIT_HISTORY_BUSY` and can be retried. Each call has a 30-second deadline
including every Git subprocess. Inventory is
capped at 16 MiB, 10,000 commits and 50,000 change records; historical ignore
policies are limited to 100 distinct blobs of 64 KiB each. Generated patches
are capped at 16 MiB before response truncation. Exceeding these budgets returns
`GIT_HISTORY_TOO_LARGE` without partial content. Shallow or malformed history
returns `GIT_HISTORY_UNAVAILABLE`; missing objects, an unborn HEAD and Git process
failures return `GIT_FAILED`. Cancellation/deadline failures return `GIT_ABORTED`
or `GIT_TIMEOUT`. Workspace grants and current ignore policy are rechecked
before returning content; `GIT_HISTORY_POLICY_CHANGED` requires retrying.

### Diff snapshots

Start `git_diff` at `offset=0` without `snapshot_id`, using the registered
`workspace` and desired `mode` and `path`. The Hub generates the filtered diff
once and returns a `snapshotId`. Every continuation or retry must supply that
ID as `snapshot_id`, together with the same workspace, mode and path.

- `status="ready"`: read `diff`; when `hasMore=true`, continue at `nextOffset`.
  `totalBytes` is the exact snapshot size. Page size defaults to 64 KiB, with
  a 256 KiB maximum. Offsets count UTF-8 bytes.
- `status="preparing"`: no patch or byte counts are available yet. Wait
  `retryAfterMs`, then poll the same snapshot and offset. Preparation continues
  independently of the HTTP request; do not create another snapshot to poll.

For example, after a ready first page:

```json
{"workspace":"<workspace-id>","mode":"head","snapshot_id":"<returned-snapshotId>","offset":65536,"max_bytes":65536}
```

Use the actual `nextOffset`, which may be smaller than the requested page size
to preserve line and UTF-8 boundaries. Retrying a page returns the same bytes;
working-tree changes after preparation do not change subsequent pages. Start a
new snapshot to capture new edits. The capture itself reads the live working
tree; avoid editing it while `status="preparing"` if a single Git state is needed.

Snapshots are private runtime files outside registered repositories, scoped to
the running Hub, OAuth client, workspace, mode and path. Workspace registration,
Git scope and current ignore rules are checked on every call. Changes to
`.c2cignore` invalidate saved content. Snapshots expire after 10 minutes, are
lost on Hub restart, and the oldest completed snapshot can be evicted sooner
when capacity is reached. At most four snapshots (64 MiB each) are retained,
with two preparations at a time. Each Git process has a 30-second deadline;
the entire preparation has a two-minute deadline. HTTP calls wait at most
500 ms for preparation before returning `preparing`.

`DIFF_SNAPSHOT_UNAVAILABLE` requires starting a new snapshot at offset 0.
`DIFF_SNAPSHOT_REQUIRED` means a continuation omitted `snapshot_id`.
`DIFF_SNAPSHOT_POLICY_CHANGED` requires a fresh capture under the current policy.
`DIFF_SNAPSHOT_BUSY` means two preparations are active; retry shortly.
`GIT_TIMEOUT`, `GIT_FAILED`, `DIFF_TOO_LARGE` and `DIFF_SNAPSHOT_IO_ERROR` return
explicit tool errors without partial patches. A size error requires a narrower
path scope. An expired or invalid snapshot never silently reruns Git.

## ChatGPT Project bindings

Each Hub connector serves its registered workspaces. Projects and Hubs have a
**many-to-many** relationship; Project/repository membership
is **many-to-many**: Project A can reference frontend + backend, Project B can
reference backend + infra, and Project C can reference frontend. Membership is
routing/context metadata, not workspace ownership or an additional read grant.
A Project can combine any number of Hubs, and each Hub may appear in many Projects.
Its stable `g-p-...` ID identifies the Project independently within each Hub; URL
slugs and titles are labels. The same repo/root may be registered through several
Hubs with the same workspace ID. Routing is **connector + workspace ID**.

Select the exact Project URL on every Project command. Normal Hub selection
still uses single-Hub discovery or `--hub <id>` when needed:

```bash
c2c project status --project-url "<project-url>" --json
# Preview this Project with one additional registered workspace, without writing:
c2c project instructions --project-url "<project-url>" --workspace backend --json
# After applying the aggregate block and verifying MCP inside that Project:
c2c project bind --project-url "<project-url>" --workspace backend --instruction-hash <verified-hash> --json
# Remove only this membership, then preview and sync the remaining block:
c2c project unbind --project-url "<project-url>" --workspace backend --json
c2c project instructions --project-url "<project-url>" --json
c2c project bind --project-url "<project-url>" --instruction-hash <verified-hash> --json
```

Adding/removing a membership writes only the selected Hub/Project record. Other
Hubs' and Projects' records are untouched, even when they use the same Project
ID or workspace. `bind` adds idempotently when `--workspace` is supplied; without
it, it only acknowledges the
current aggregate. `unbind` does not remove the Hub's read grant or edit ChatGPT.
Its final removal retains an empty record for syncing an empty routing block.

Each generated block starts with `[codex-with-chatgpt hub="<hubId>"]` and ends with
`[/codex-with-chatgpt hub="<hubId>"]`. Both markers name the owning Hub; the block maps
human repo display names to workspace IDs through that Hub's verified connector.
It always requires explicit selectors, prohibits
using `list_workspaces()` to choose a repo, selects from the user's request/context,
and asks before reading ambiguous targets. Cross-repo work inspects each relevant
workspace through its own block's connector. Verify `workspace_info(workspace="<id>")`
through that connector before first use of each connector/workspace pair in a
conversation; reuse that verification unless a tool/connector error suggests a
binding change. A verification through one connector does not verify another.

Ordering and SHA-256 hashing are deterministic. The block names the verified
connector and directs ChatGPT to use it for the listed repositories. Membership,
repo display-name, Hub marker or verified connector-name changes affect the
semantic hash and require sync. Generated aliases, connector ID/MCP URL,
instruction version, runtime PID and port are
absent from the block. Connector metadata remains in CLI output for Skill
verification; ID/URL/PID/port changes do not change its semantic hash.
An unreconciled connector still blocks acknowledgement.

`status` reports `unbound`, `current`, `sync_required` or `stale`, with
`projectVerification: "not_checked"`. These are local metadata checks, never proof
of ChatGPT access. Unregistered IDs are excluded from the block and reported in
`staleWorkspaceIds`; explicitly remove those memberships by ID or re-register.
Unavailable roots and unverified connector state fail closed. Missing/inaccessible
Projects, ambiguous managed blocks, unconfirmed text and wrong MCP IDs require
resolution through the [Skill procedure](../skill/references/projects.md), without
replacement Projects/connectors. Preserve unrelated user instructions and replace
only the selected Hub's single exact managed block. Append a new Hub's block
without changing other blocks; removing a Hub's block preserves all others.
Reconnecting alone does not update Project instructions; apply the current
block, verify MCP access, and acknowledge its hash to complete sync.

External state uses one atomic record per `(hubId, projectId)` at
`project-bindings/<hubId>/<projectId>.json`. Each unique entry in `workspaceIds`
represents `(projectId, hubId, workspaceId)`; the same ID can occur in other Project
records and under other Hub IDs. Per-Hub lifecycle locks serialize bind/unbind
and destroy; Project operations do not scan or lock other Hubs' Project state.
The persisted format is:

```json
{
  "version": 2,
  "hubId": "hub-550e8400-e29b-41d4-a716-446655440000",
  "projectId": "g-p-6ad414a9a390819194cd6a676854de21",
  "projectUrl": "https://chatgpt.com/g/g-p-6ad414a9a390819194cd6a676854de21-desk-home/project",
  "workspaceIds": ["0123456789ab", "abcdef123456"],
  "instructionVersion": 4,
  "appliedInstructionHash": "<sha256-of-generated-block>",
  "updatedAt": "2026-10-18T14:00:00.000Z"
}
```

No chat URL, session/checkpoint state, credentials or repo contents are stored.
Hub/Project/URL/filename mismatches, duplicate membership IDs and symlinks fail
closed. Pending destroy blocks bind/unbind with `DESTROY_PENDING`. Destroy validates
and removes only the targeted Hub's local Project records, before its identity;
ChatGPT Projects and their Instructions are never automatically deleted.

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
other Hubs' grants. See [troubleshooting](troubleshooting.md) for state, lock
and runtime recovery. All connection resources and destroy receipts are Hub-owned.
