# C2C handoff workflow

This is the sole handoff contract and works without Lazier. ChatGPT Web
thinks/plans/audits; Codex implements/tests or handles explicitly delegated
planning. The local repo is the source of truth; summaries are not repository
evidence. Lazier adds engineering policy/activation, not another transport contract.
Other tasks keep normal handoffs; setup/reconnect ends at **MCP READY**.

Read this common contract once for C2C and only the reference for the active role:

- **Web audit:** [receiver](workflow-web.md), including manual/async results.
- **Codex, explicit `async=true`:** [sender](workflow-async.md), including permission
  verification. Manual Codex handoffs need no sender/receiver reference.

Reuse guidance already read and still valid in this session; reread only after
changes or missing/uncertain context. Before final handoff, ensure the applicable
contract was read, without loading unrelated host/mode or broad docs/GitHub.
Disclose unreadable guidance; do not claim it ran.

## Web → Codex

Choose by intent and put the marker on the exact first line:

- `[C2C Plan]`: create or check a plan; do not edit code.
- `[C2C Task]`: implement, refactor, clean up or test within the requested scope.
- `[C2C Fix]`: fix evidenced findings within scope; include location, evidence
  and the proposed fix.
- `[C2C Commit]`: execute the delivery actions explicitly authorized by the user
  for this task: commit and, after audit PASS, any authorized push and rollout.

After audit PASS, keep all explicitly authorized delivery actions in one
`[C2C Commit]`; do not reduce it to commit-only when push or rollout is authorized.
Default to no push or rollout without explicit user authorization for this task;
audit PASS itself grants no permission. Codex performs and verifies the authorized
steps without asking for the same confirmation again.

Include repo, known connector/workspace ID, scope and relevant constraints.
Copy known `hubId` from the matching connector/workspace routing block; preserve
that owner across Plan → Task/Fix and later handoffs. Never borrow another routing
block's Hub or infer one from a chat URL. Carry relevant, still-valid decisions
and evidence forward, separating verified findings, assumptions and open questions;
inspect current source before editing without repeating a full settled audit.

Preserve routing and an already-selected `async=true` when revising/continuing a
prompt. Planning remains Web-first. Omitted `async` or `async=false` means manual
delivery without browser, Hub, claim or callback state access. Explicit `async=true`
requires local permission and Hub runtime support; otherwise stop before sending.
Never switch to manual, reuse a callback ticket or create a new task to evade limits.
Do not mark ordinary replies, non-C2C Codex prompts or MCP-only source reads.
Markers execute nothing and grant no permissions; drafting a prompt does not send
it or authorize execution. Add no workflow/state layer.

## Codex → Web

Start the final message with the exact first line `[C2C Handoff]`. Briefly provide:

- **Repo:** identity, known connector/workspace ID and known `hubId` for each repo.
- **Revision:** full base/HEAD SHAs, or HEAD plus `uncommitted` and the included
  staged, unstaged and untracked scope.
- **Changes:** behavior, relevant paths and necessary decisions.
- **Validation:** actual commands/results, tested revision or working tree,
  and unrun checks. A clean diff or build does not imply tests passed.
- **Risks:** concrete risks, limits or blockers; none known when appropriate.

State `not checked` or `not run` for omitted revision checks or validation. Keep
handoffs/results concise: outcome, findings, observed acceptance and unchecked
limits. Do not repeat one result in a table, JSON and prose or omit necessary
evidence to shorten it. The async controller's callback envelope stays complete.
