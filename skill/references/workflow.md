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
When async is requested, pass that known `hubId` to `startAsyncC2C`.
Planning remains Web-first. Set `async=true` explicitly in the work prompt only
when automatic browser delivery and bounded audit/fix rounds are wanted.
Omitting it means `async=false`: return the handoff for manual delivery as before.
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
persistent orchestration/checkpoints or agents, and do not commit just to hand off. Use the existing ten read-only
MCP tools. Project Instructions keep their routing role and need no handoff
update. Setup/reconnect still ends at **MCP READY**.

## Opt-in async v1

Only explicit `async=true` activates automatic delivery. It does not change
planning ownership or authorize commits, pushes, rollout, grant changes or scope
expansion. No connector repair, source update, dependency install, or separate
smoke message is part of this flow. Do not turn async on to implement/test async.

Use the existing in-app browser through its documented API. Reuse its selected
ChatGPT conversation immediately, trusting the user's selection, including an
ordinary conversation outside a Project, with or without a supplied `hubId`.
Do not resolve or list Hubs, inspect Project bindings, verify Project membership
or switch threads on this hot path. Use the explicit known
workspace ID from the task; it remains required on every Web MCP call. Missing
or ambiguous connector/workspace routing is a blocker, never permission to guess.

Only when there is no selected ChatGPT conversation, resolve the existing
workspace membership with `resolveAuditProject`: pass the known `hubId` to select
its owner. Without `hubId`, use the sole configured Hub; multiple Hubs fail with
`HUB_SELECTION_REQUIRED`. Require a registered workspace and exactly one current
Project binding under that owner. Missing, ambiguous, foreign or stale state fails closed. Open the
exact saved Project through visible UI and use New chat. A new conversation may
remain at the Project URL until the first message is sent. Never create a
Project, connector or binding to make fallback succeed. A browser error is a
blocker, not permission to switch browsers or send again. Retain the same tab
and conversation for every audit in this task; never persist the chat URL.

### Codex browser procedure

Use `<checkout>/dist/c2c/repl.mjs` inside the existing `cua_repl` runtime, not the
ordinary Node entrypoint `dist/c2c/async.js`. The build bundles all third-party
and relative imports; REPL resolution must not depend on its working directory,
package registration or the checkout's `node_modules`. Supported Node built-ins
are explicit lexical imports, including timers, clock, URL and Buffer. Do not
import/emulate the forbidden `node:process`, inject globals, alter allowlists or
use a module-resolution workaround.

Source fingerprints, task claims and cold Project resolution reuse the existing
local implementation in the companion `dist/c2c/local.mjs`, run as one-shot Node
commands through the supported `node:child_process.execFileSync` API. This is not
a daemon, MCP tool or orchestration service. It does not expose a process object
to the REPL or skip local checks. Obtain the absolute Node >=20 executable using
`node -p process.execPath` in the local terminal, and pass the exact built helper
path. The helper inherits the local execution environment, including the normal
C2C state directory settings; do not override permissions or reset task claims.
If the executable, helper, Git, filesystem or subprocess capability is missing,
initialization fails closed before browser delivery. Initialization checks source
access and then claims the task; retain that handle for the audit.

Follow the upstream
browser initialization/documentation first. Inspect the visible DOM to identify
the composer, user and assistant heading labels. The reader supports the
ChatGPT structure `div > h4` followed by the message body. Stop if that structure
or the labels are unavailable; do not guess selectors or scrape private state.
Preserve a user's existing draft. Ground New chat navigation in visible UI too.

Import the module and create one task-local handle. For example, with the
observed English labels below and an already selected in-app browser binding,
first define `openProjectThread(projectUrl)` using observed controls to navigate
to that exact Project, use New chat, verify the draft and return its tab handle.
It will not run on the hot path:

```javascript
var { startAsyncC2C } = await import("<checkout>/dist/c2c/repl.mjs");
var audit = await startAsyncC2C({
  async: true, taskId: "<stable-task-id>", workspaceId: "<registered-id>",
  workspaceRoot: "<absolute-local-repo-root>",
  hubId: "<known-owner-id>", // include when known from routing; used only on the cold path
}, browser, {
  composerName: "Ask ChatGPT", userHeading: "You said:", assistantHeading: "ChatGPT said:",
  openProjectThread
}, {
  nodeExecutable: "<verified-absolute-node-executable>",
  helperPath: "<checkout>/dist/c2c/local.mjs"
});
// Successful import and initialization are required before any delivery.
await audit.submit(handoff); // full current [C2C Handoff], including validation
var outcome = await audit.wait();
```

Use an existing stable task ID or create one UUID once for a genuinely new task.
Keep that ID across interrupted turns; never generate another ID to retry the
same task or bypass its limit. Starting async exclusively creates one zero-byte
claim, named by SHA-256 of the task ID, in the external C2C state directory's
`async-tasks/`. This is only a one-time budget guard: it stores no source, chat
URL, audit result, counter or resumable orchestration. Retain the original handle
for up to three audits. If that handle is lost, recreated, or startup fails,
the claim rejects another handle for that task before browser discovery or
delivery, even after runtime restart or workspace changes. Stop async and report
the interruption; continue only through the manual workflow. Do not remove the
claim or invent a new task ID to resume. Claims are retained, including after
startup failure or successful completion; v1 has no automatic claim cleanup.
Async tasks started by an older build
without this guard must also stop rather than recreate a fresh budget.

The module creates
a fresh UUID per attempt and SHA-256 of the exact handoff. It sends the handoff
with a `C2C_REQUEST` correlation line and the Web response instructions. It
accepts only an assistant response after that newly sent user message, with no
intervening user message, matching task ID, attempt ID, workspace ID and handoff
hash. The submission baseline and anchor indexes use only the grounded user and
assistant headings; unrelated headings do not count. Before the first anchor is
visible, unchanged user history or one new user heading with an unfinished body
may return `WAITING` within the original deadline. That turn remains provisional
until its exact anchor is visible. Additional user turns, regressed baseline,
duplicate or old anchor, or disappearance of an already observed anchor fail closed. Local
`ASYNC_TURN_MISMATCH` summaries include a reason and numeric turn metadata only,
never transcript text. Conversation navigation and malformed frames also fail
closed. Old ACKs and responses from previous attempts cannot satisfy the
wait. Every re-audit needs a refreshed handoff for the validated working tree.
`workspaceRoot` is an explicit local root, not an MCP workspace selector. Its
canonical root-derived ID must match `workspaceId`. At each submission the module
captures a local fingerprint of HEAD, staged index entries and every tracked or
non-ignored untracked file's path, mode and readable bytes, including deletions.
Sensitive files contribute only filesystem metadata (device/inode, size and
nanosecond modification/change times); their content is never read. This is
drift detection, not evidence of a sensitive-content audit or permission to edit
such files. It does not send source content or the fingerprint to the browser.
Ignored generated files are outside this source check. Git/source read failures,
unsupported paths (including symlinks/submodules) or more than 64 MiB of readable
file content fail closed; use the manual workflow when a complete snapshot is unavailable.

Each `wait()` performs at most one short, read-only DOM check using the supported
`playwright.evaluate` API. It reads the grounded turn headings, user anchor
metadata and latest reply body, returning only metadata and a terminal candidate
containing this attempt ID and end marker. It never chains blocking locator waits
or returns the full transcript. If no terminal candidate exists, return `WAITING`.
Call `audit.wait()` again on the same handle; do not resend or add manual browser
polling. The handle spaces settled DOM checks by at least two seconds using a
local timer with no browser operation in flight. A completed candidate returns
as soon as it is checked and validated; a response arriving between checks is
read on the next check.

The default call budget is five seconds, including local pacing and URL checks;
the optional budget is between one and five seconds. Each browser operation has
an independent watchdog of at most two seconds, clipped to the call budget and
audit deadline; DOM evaluation also receives that explicit `timeoutMs`. An
exhausted pacing budget returns `WAITING` without starting another browser call.
CDP transport errors, selector errors and other browser failures are terminal
`ERROR`, preserving their actual messages even across realms. A missing candidate
is not a transport failure. The watchdog cannot cancel a CDP operation: if it
expires, return terminal `ERROR` and never start another operation on the handle,
even if the outstanding operation settles later. Concurrent waits are rejected.
Keep the enclosing REPL invocation deadline above this short call budget. If
that invocation itself is interrupted, stop async rather than recreating the
handle or assuming its browser operation was cancelled.
The default hard deadline is 180 seconds per audit, including submission, and cannot
be increased (`timeoutMs` may shorten it). Wait slices do not reset it. After a
timeout or browser/MCP error, stop; late responses cannot reopen the attempt.
An upstream operation already in flight cannot be cancelled by this API; do not
retry an uncertain send. Keep the browser tab available with the upstream
handoff marking mechanism if work crosses a turn.

### Web response and fix limits

The request supplies all four correlation values. Return a terminal frame with
those exact values, without a Markdown code fence:

```text
[C2C Audit v1]
{"taskId":"<task>","attemptId":"<attempt>","workspaceId":"<id>","handoffId":"<sha256>","status":"PASS","complete":true,"summary":"Audited through MCP; state inspection limits here.","findings":[]}
[C2C Audit End v1]
```

Use `PASS` only after the required MCP audit is complete with sufficient
evidence. `FIX` requires at least one finding with repo-relative `file`, positive
`line`, `evidence` and concrete `fix`. `BLOCKED` means required evidence, routing
or authorization is missing. Other statuses use `findings:[]` and describe any
limits in `summary`. On the first MCP failure, immediately return the complete
`ERROR` frame with the actual error. Do not retry the failed call, wait for a
later success or return an ACK. Partial frames and `complete:false` cannot pass.
The closing marker declares the audit terminal; emit it only when finished.

Codex stops on `PASS`, `BLOCKED` or `ERROR`. On `FIX`, inspect each finding against
the authorized scope before editing; out-of-scope or ambiguous changes stop for
the user. A Web `FIX` initially has `canAutoFix:false`. Before any automatic edit
round, Codex must call `outcome = audit.verifySourceForFix()` immediately before
editing. This re-reads the local source fingerprint and compares it with the
submission snapshot, rather than the handoff-text hash. Source drift or missing
evidence returns terminal `ERROR`; stop without applying fixes or sending another
audit. Do not treat an unchanged dirty/clean status as proof: staged, unstaged and
untracked file contents must match. If interrupted before editing, verify again.
Only if this check returns `canAutoFix:true` may Codex apply the in-scope fixes,
run focused local checks, refresh the full handoff and call
`await audit.submit(updatedHandoff, true)`, then wait on the same handle. Allow
at most three total audits and two auto-fix rounds. A third `FIX` has
`canAutoFix:false`: stop and report remaining findings without another edit.
Never commit, push, rollout or expand scope automatically. The handle enforces
audit order/count and source verification; Codex remains responsible for scope,
local validation and ensuring no intervening edits between verification and its
edit round. Do not edit from a previously returned FIX after a source-drift error.

This module has fixture-based browser regression coverage. Live ChatGPT layout,
authentication, connector availability and audit latency still require a
separately authorized end-to-end check; passing local tests is not Web MCP proof.
