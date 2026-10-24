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

Explicit `async=false` or an omitted flag remains manual: no browser, Hub, claim
or callback access. Do not silently change modes or transports after a failure.
Async requires a known `hubId` from the matching routing block, explicit registered
`workspaceId`, canonical `workspaceRoot` and the task's stable `taskId`. Never infer
the callback owner from a chat URL or another connector. Missing callback ownership
blocks sending; it does not authorize selecting another thread or Hub.

First prove terminal loopback permission with a read-only health/status probe and
an isolated register → authenticated MCP callback → terminal wait gate. On EPERM,
request official command escalation limited to `127.0.0.1`; never edit sandbox
settings or add IPC workarounds. If permission is denied, async stays disabled.
REPL fetch permission is separate: all callback operations run in the approved
terminal. A local gate does not verify the deployed runtime, ChatGPT OAuth
`audit.submit` consent, tool confirmation or live E2E. Do not rollout or re-consent
unless authorized. All ten repository-read MCP tools and manual C2C remain intact.

Use one task-local terminal process and one in-app browser sender:

1. Run `node <checkout>/dist/c2c/local.mjs async` with the supported terminal tool,
   `tty=true` to keep stdin open and official loopback approval when required.
   Keep that terminal session ID. Send JSONL through `write_stdin`, never shell
   interpolation or credentials in argv. First line:
   `{"async":true,"hubId":"<known-hub>","workspaceId":"<id>","workspaceRoot":"<canonical-root>","taskId":"<stable-task>","timeoutMs":180000}`.
   `READY` validates options/source only, not transport readiness.
2. Send `{"operation":"submit","handoff":"[C2C Handoff]\n...","fixed":false}`.
   Only its successful response authorizes delivery: registration proves runtime
   support and owner access before the exclusive claim is created. It returns
   `attemptId`, `message`, `remainingMs` and `expiresAt`. Never reconstruct the
   message or expose its capability outside the routed audit. Runtime unavailable
   or `ASYNC_CALLBACK_TRANSPORT_UNAVAILABLE: EPERM` means stop without browser access.
3. Import `<checkout>/dist/c2c/browser.mjs` in the existing in-app browser REPL.
   `createBrowserSender(browser, ui, resolveProject)` uses the supported browser's
   `tabs.selected()` and a UI-grounded `composerName`. A selected ChatGPT conversation
   is trusted immediately: do not resolve a Hub, check Project membership or switch
   it. This selection rule does not depend on whether a hubId was supplied.
   Only if no selected conversation exists may the resolver call the existing local
   `project <workspaceId> [hubId]` helper and `ui.openProjectThread(projectUrl)` use
   observed Project navigation/New chat. Pass the exact routing hubId on the cold
   path. To bridge tools, a resolver may first stop with `ASYNC_PROJECT_REQUIRED`;
   obtain the URL in the terminal, then create the sender with that URL. No message
   has been sent. Reuse the resulting sender across audit rounds.
4. Pass the complete returned envelope to `sender.send(envelope)` exactly once.
   It checks thread identity, existing draft and deadline, fills the composer and
   presses Enter once. It never reads conversation history or audit responses.
   Then send `{"operation":"sent","attemptId":"<returned-id>"}` to the same
   terminal session. This opens one bounded HTTP event wait. Use the terminal tool's
   normal output/completion wait; do not repeatedly call an inbox endpoint, poll by
   model, or read transcript DOM. The terminal receives only `submit_audit_result`.
5. On FIX with `canContinue:true`, send `{"operation":"verifySourceForFix"}`
   immediately before editing. Proceed only on `canAutoFix:true`: this checks
   unchanged source and invalidates the completed capability against the live Hub.
   After one in-scope fix and focused validation, submit the new handoff with
   `fixed:true` in this same process, then use the same sender and wait again.
   Stop on PASS/BLOCKED/ERROR or `canContinue:false`. Maximum: three audits/two fixes.

The original per-attempt deadline is at most 180 seconds, including registration,
sending and waiting; it never restarts at acknowledgement. Each input/fix phase
also expires after 180 seconds. Wrong correlation/capability, conflicting callback,
revoked workspace, restart, connection/permission failure and source drift fail
closed. Exact callback duplicates are idempotent while the ticket remains valid.
Any error or uncertainty after browser delivery starts consumes that sender; send
`{"operation":"abort"}` or terminate the terminal, then stop without resending.
EOF/interrupt cancels the wait/attempt. A lost terminal cannot be resumed, and no
legacy result path is available. Return the actual blocker in the manual handoff.

The helper also supports one-shot `callback register`, `callback wait` and
`callback cancel` using JSON stdin for isolated capability checks. Do not use
these primitives to bypass session claims or audit limits. `{"async":false}`
or `{}` on the `async` operation returns success without accessing task state.

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
