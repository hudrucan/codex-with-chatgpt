# C2C handoff workflow

This is the sole handoff contract. ChatGPT Web thinks/plans/audits; Codex
implements/tests. The local repo is the source of truth; summaries are not
repository evidence. Lazier defines activation, not a separate contract.
Apply this workflow only to tasks using C2C; other tasks keep normal handoffs.

## Codex → Web

Before a C2C task's final handoff, read this local reference. Start the message
with the exact first line `[C2C Handoff]`, then briefly provide:

- **Repo:** identity and known connector/workspace ID.
- **Revision:** full base/HEAD SHAs, or HEAD plus `uncommitted` and the included
  staged, unstaged and untracked scope.
- **Changes:** behavior, relevant paths and necessary decisions.
- **Validation:** actual commands/results, tested revision or working tree,
  and unrun checks. A clean diff or build does not imply tests passed.
- **Risks:** concrete risks, limits or blockers; none known when appropriate.

## Web audit → Codex

A handoff starting with `[C2C Handoff]` triggers an audit through C2C MCP without
a separate audit request. The marker does not grant connector/workspace access:

1. Use the routed connector and explicit registered workspace on every call.
   Verify that pair with `workspace_info` before first use; ask if ambiguous.
2. Check revision/scope with `git_status` and `git_log`. For uncommitted work,
   read `git_diff` (`mode="head"`, or `staged`/`unstaged` for narrower scope)
   and relevant untracked files via `read_file`. For commits, use `git_log` and
   `git_show` with full SHAs; each patch compares to its first parent (empty tree
   for root commits), not an arbitrary base/HEAD range.
3. Inspect related source, guidance, callers and tests with `read_file` and
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

Handoffs do not request a simplicity review or authorize another implementation
cycle. Keep them in conversation; add no handoff files, state, agents or
orchestration, and do not commit just to hand off. Use the existing ten read-only
MCP tools. Project Instructions keep their routing role and need no handoff
update. Setup/reconnect still ends at **MCP READY**.
