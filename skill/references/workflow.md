# C2C handoff workflow

This is the sole handoff contract. ChatGPT Web thinks/plans/audits; Codex
implements/tests or handles explicitly delegated planning. The local repo is
the source of truth; summaries are not repository evidence. Lazier defines
activation, not a separate contract.
Apply this workflow only to tasks using C2C; other tasks keep normal handoffs.

## Web → Codex

When drafting a work prompt for Codex through C2C, choose by intent and put the marker on
the exact first line:

- `[C2C Plan]`: create or check a plan; do not edit code.
- `[C2C Task]`: implement, refactor, clean up or test within the requested scope.
- `[C2C Fix]`: fix evidenced findings within scope; include location, evidence
  and the proposed fix.
- `[C2C Commit]`: commit only when the user requests it; do not push automatically.

Include the repo, known connector/workspace ID, scope and relevant constraints.
Copy a known `hubId` from the corresponding connector/workspace routing block
into the work prompt. Preserve that owner across Plan → Task/Fix and subsequent
handoffs; never borrow a Hub from another routing block or infer it from a chat URL.
Planning remains Web-first. Omitted `async` or `async=false` selects manual
delivery. `async=true` is currently unavailable; follow [async availability](#async-availability)
and stop without sending automatically.
Do not mark ordinary replies or MCP-only source reads. Markers are conventions,
not commands, automatic delivery or permission grants. Codex reads this local
reference, follows the requested scope and returns `[C2C Handoff]`.

## Codex → Web

Before a C2C task's final handoff, read this local reference. Start the message
with the exact first line `[C2C Handoff]`, then briefly provide:

- **Repo:** identity, known connector/workspace ID and known `hubId`.
- **Revision:** full base/HEAD SHAs, or HEAD plus `uncommitted` and the included
  staged, unstaged and untracked scope.
- **Changes:** behavior, relevant paths and necessary decisions.
- **Validation:** actual commands/results, tested revision or working tree,
  and unrun checks. A clean diff or build does not imply tests passed.
- **Risks:** concrete risks, limits or blockers; none known when appropriate.

State `not checked` or `not run` for omitted revision checks or validation.

## Web audit → Codex

A handoff starting with `[C2C Handoff]` triggers an audit through C2C MCP without
a separate audit request. The marker does not grant connector/workspace access.
Use the routed connector and explicit registered workspace on every call.
Verify that pair with `workspace_info` before first use; ask if ambiguous.

Keep verification proportional to the claimed outcome. For handoffs with no
code changes, verify only relevant claims and inspect Git/source as needed;
do not perform a full code audit without a specific risk or request. Honor
explicit inspection limits and disclose unchecked evidence. For changed code:

1. Check revision/scope with `git_status` and `git_log`. For uncommitted work,
   read `git_diff` (`mode="head"`, or `staged`/`unstaged` for narrower scope)
   and relevant untracked files via `read_file`. For commits, use `git_log` and
   `git_show` with full SHAs; each patch compares to its first parent (empty tree
   for root commits), not an arbitrary base/HEAD range.
2. Inspect related source, guidance, callers and tests with `read_file` and
   `search_workspace`. Follow returned pagination/snapshot fields. Report missing
   evidence from unavailable MCP, filtering, truncation or revision changes;
   limit conclusions and request only what is missing. Never imply unread source
   was audited or treat missing evidence as a defect.

Trust Codex's local validation for the tested revision. Request extra tests only
for a specific uncovered risk, with a failure scenario and a focused check.
Return findings by impact with repo-relative file/line, revision when relevant,
source/diff evidence, failure mechanism and a concrete fix. Separate questions
from defects; if none are supported, say so with inspection limits. Codex applies
authorized fixes and validates locally.

Handoffs do not request a simplicity review. Manual handoffs do not authorize
another implementation cycle. Keep them in conversation; add no handoff files,
persistent orchestration/checkpoints or agents, and do not commit just to hand off.
Use the ten repository-read MCP tools for audits. Project Instructions keep their
routing role and need no handoff update. Setup/reconnect still ends at **MCP READY**.

## Async availability

Automatic C2C delivery is disabled while the callback capability gate is blocked.
An `async=true` request must fail with `ASYNC_CALLBACK_UNAVAILABLE` before browser
access, sending, task claiming, attempt registration or automatic fixes. Do not
silently switch to a manual task or another transport. Explicit `async=false`
keeps the manual handoff workflow above.

The local helper provides an availability check, with JSON on stdin:

```bash
printf '%s\n' '{"async":true}' | node <checkout>/dist/c2c/local.mjs async
```

It exits nonzero with the unavailable error. `{"async":false}` or `{}` returns
success without accessing the browser, Hub or task state. The callback MCP inbox
and local `callback register`, `callback wait`, `callback cancel` operations remain
transport primitives; they do not enable an automatic audit/fix loop. Do not send
a browser handoff to test this gate or change sandbox policy automatically.

Local `claim`, `fingerprint` and `project` helpers remain available. A claim is an
exclusive zero-byte file outside the repo, keyed by SHA-256 of the stable task ID.
Claims survive process restarts and are never reset, removed or bypassed with a
new ID to retry an old task.

Source fingerprints cover HEAD, staged index entries and tracked/non-ignored
file paths, modes and readable bytes, including deletions. Sensitive files
contribute metadata only, never contents. Canonical workspace identity must match
the explicit workspace ID. Unsupported paths or more than 64 MiB of readable
content fail closed. A clean Git status does not prove unchanged source bytes.

Project resolution remains local and owner-scoped: an explicit `hubId`, or the
sole configured Hub, must own the registered workspace and exactly one current
Project binding. Multiple Hubs without a selector fail with `HUB_SELECTION_REQUIRED`.
This helper does not select a browser or switch an existing conversation.
