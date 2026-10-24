# Web C2C audit

Load with the [common contract](workflow.md) for Web audits; reuse already-read,
still-valid guidance in this session. Direct repository audits/planning may also
use C2C; the handoff marker gates only automatic handoff audits.

A handoff starting with `[C2C Handoff]` triggers an audit through C2C MCP without
a separate audit request. The marker does not grant connector/workspace access.
Use the routed connector and explicit registered workspace on every call,
including a separate audit of each repository in a multi-repo handoff.
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
Return concise findings by impact with repo-relative file/line, revision when relevant,
source/diff evidence, failure mechanism and a concrete fix. Separate questions
from defects; if none are supported, say so with inspection limits. Codex applies
authorized fixes and validates locally.

Handoffs do not request a simplicity review. Manual handoffs do not authorize
another implementation cycle. Keep them in conversation; add no handoff files,
persistent orchestration/checkpoints or agents, and do not commit just to hand off.
Use the ten repository-read MCP tools for audits. Project Instructions keep their
routing role and need no handoff update. Setup/reconnect still ends at **MCP READY**.

## Manual result

When appropriate, include one ready-to-copy next prompt: `[C2C Fix]` for supported
in-scope findings, or `[C2C Commit]` when no findings/evidence gaps remain and
verified Git status shows audited uncommitted changes. Preserve C2C identity,
revision, scope, constraints, relevant context and unrelated work; forbid pushing.
With clean Git status, confirm completion without a prompt. Drafting never sends,
implements, commits or pushes. An already-selected `async=true` stays async.

## Async callback result

For a newly sent `[C2C Handoff]` containing `C2C_CALLBACK`, audit through the
routed MCP and complete this attempt only with `submit_audit_result`. Copy
`hubId`, `workspaceId`, `taskId`, `attemptId`, `handoffId` and `capability`
unchanged from this new ticket, never history or ordinary replies. Keep its
capability within the routed audit; never reuse a ticket/capability.

Follow the existing tool schema and deadline. Submit a terminal result containing
only `status`, `complete:true`, `summary` and `findings`:

- `PASS`: completed MCP audit with sufficient evidence for the scope; `findings:[]`.
- `FIX`: supported in-scope findings, each containing only repo-relative `file`,
  positive integer `line`, `evidence` and concrete `fix`.
- `BLOCKED`: missing/ambiguous routing or insufficient evidence; `findings:[]`.
- `ERROR`: first repository-read MCP failure, with the actual error in `summary`
  and `findings:[]`; do not retry or reuse old success.

Respect schema limits: summary/evidence/fix at most 2048 characters each, file
at most 512, at most 20 findings, complete callback at most 16,384 UTF-8 bytes.
The attempt's maximum 180-second deadline includes registration, sending and
waiting; acknowledgement does not restart it. Missing evidence is neither a
defect nor PASS. If the callback tool is unavailable, denied or fails, report the
blocker and stop without retrying or substituting a chat result. Emit no legacy
audit frames, ACKs or Fix/Commit prompts. Only MCP `accepted:true` and the matching
terminal receipt complete delivery.

Keep the callback summary short: outcome, findings and unchecked limits, with
necessary evidence in findings. Report acceptance only when observed. Do not
repeat the same result in tables, JSON and prose; the required callback is the
structured result. Async authorizes no commits, pushes, rollout or expanded scope.
