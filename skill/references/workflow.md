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
delivery. Explicit `async=true` selects the [callback workflow](#async-callback-workflow)
only when local permission and the Hub runtime support it; otherwise stop before sending.
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

## Async callback workflow

Omitted `async` or `async=false` uses manual delivery without browser, Hub or task
state access. Async requires the routed `hubId`, explicit registered `workspaceId`,
canonical `workspaceRoot` and one stable `taskId`. Missing ownership blocks sending;
do not infer it from a chat URL or substitute another Hub/thread.

Before sending, complete the [permission probe](#permission-probe) to verify runtime
ownership, ChatGPT `audit.submit` consent and terminal loopback access.
Local tests do not prove live readiness. On EPERM,
request official escalation for `127.0.0.1`; denial keeps async disabled. Callback
operations use that terminal, independently of REPL fetch permissions. Do not change
sandbox settings, add another transport, rollout or re-consent without authorization.

Use one task-local terminal process and one in-app browser sender:

1. Run `node <checkout>/dist/c2c/local.mjs async` with the supported terminal tool,
   `tty=true` to keep stdin open and official loopback approval when required.
   Keep its session ID and send JSONL through `write_stdin`, not shell interpolation
   or credentials in argv. First line:
   `{"async":true,"hubId":"<known-hub>","workspaceId":"<id>","workspaceRoot":"<canonical-root>","taskId":"<stable-task>","timeoutMs":180000}`.
   `READY` validates options/source only.
2. Send `{"operation":"submit","handoff":"[C2C Handoff]\n...","fixed":false}`.
   Success registers the attempt before claiming the task and returns `attemptId`,
   `message`, `remainingMs` and `expiresAt`. Only then may delivery start. Preserve
   the complete envelope, including `C2C_CALLBACK`, and keep its capability within the routed audit.
   Registration/transport failure stops before browser access.
3. Import `<checkout>/dist/c2c/browser.mjs` in the existing in-app browser REPL.
   `createBrowserSender(browser, ui, resolveProject)` uses the supported browser's
   `tabs.selected()` and a UI-grounded `composerName`. Trust the selected ChatGPT
   conversation without resolving its Hub/Project or switching it. Only when none
   exists may the resolver use `project <workspaceId> [hubId]` with the routed Hub
   and `ui.openProjectThread(projectUrl)` with observed navigation. The helper
   requires exactly one current, owner-scoped Project binding; multiple configured
   Hubs require a selector. If tool bridging needs `ASYNC_PROJECT_REQUIRED`, obtain
   the URL in the terminal before creating the sender. Reuse it across rounds.
4. Pass the complete returned envelope to `sender.send(envelope)` exactly once.
   It checks thread identity, draft and deadline, then presses Enter once. It never
   reads conversation history or audit responses.
   Then send `{"operation":"sent","attemptId":"<returned-id>"}` to the same
   terminal session to open one bounded HTTP event wait. Use normal terminal
   completion waits, not inbox polling or transcript DOM. Only an MCP
   `submit_audit_result` completes the attempt; a chat reply cannot.
5. On FIX with `canContinue:true`, send `{"operation":"verifySourceForFix"}`
   immediately before editing. Proceed only on `canAutoFix:true`: this checks
   unchanged source and invalidates the completed capability against the live Hub.
   After one in-scope fix and focused validation, submit the new handoff with
   `fixed:true` in this same process, then use the same sender and wait again.
   Stop on PASS/BLOCKED/ERROR or `canContinue:false`. Maximum: three audits/two fixes.

The 180-second maximum deadline includes registration, sending and waiting; send
acknowledgement never restarts it. Input/fix phases also expire after 180 seconds.
Source drift or ownership, permission and transport failures stop the session.
Any error or uncertainty after delivery starts consumes the sender: send
`{"operation":"abort"}` or terminate the terminal without resending. EOF/interrupt
cancels the attempt. Lost sessions cannot resume, and persistent task claims must
not be removed or bypassed with a new ID. Report the blocker without changing modes.

E2E passes only when the Hub returns `accepted:true` and the terminal receives the
matching result. Wrong correlation/capability and conflicting, expired or revoked
callbacks fail closed; exact duplicates are idempotent until expiration.

The helper also supports one-shot `callback register`, `callback wait` and
`callback cancel` with JSON stdin for isolated checks, plus local `claim`,
`fingerprint` and `project` helpers. These do not bypass session claims or audit limits.

### Permission probe

Use this isolated check during connection verification and before async delivery.
It creates no task claim or coding loop. Verify the selected Hub with `c2c status
--hub <hubId> --json` and the exact registered root/ID with `c2c workspace list`.
Then run `node <checkout>/dist/c2c/local.mjs callback register` with JSON stdin:

```json
{"hubId":"<hubId>","workspaceId":"<workspaceId>","taskId":"<probe-id>","attemptId":"<fresh-uuid>","handoffId":"<sha256-of-probe-message>","timeoutMs":180000}
```

Only after registration succeeds, ask the selected ChatGPT conversation to verify
`workspace_info` through the routed connector, then call `submit_audit_result`
with the complete returned ticket and `result` containing `status:"PASS"`,
`complete:true`, `summary:"Permission probe"`, `findings:[]`. Do not paste source,
use a task handoff marker, or infer consent from the local admin endpoint.
Pass that same ticket as JSON stdin to `callback wait` in the terminal. Require
both the MCP `accepted:true` and matching terminal result. Cancel an unused ticket
with `callback cancel`; a rejected/expired probe blocks readiness and async sending.
Existing limited tokens require explicit reauthorization, never a callback-only
scope challenge. Without authorization to re-consent, report the blocker and stop.
