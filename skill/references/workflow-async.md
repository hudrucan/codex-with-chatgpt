# Automatic C2C sender

Load with the [common contract](workflow.md) only for explicit `auto=true`
on the Codex sender. Web audits use the [receiver](workflow-web.md).
Omitted `auto` or `auto=false` stays manual without browser, Hub or task-state access.

## Existing conversation only

Before starting the terminal controller, source hashing, callback registration or
task claiming, require an existing browser and selected ChatGPT conversation in the
current REPL. Otherwise, immediately return the original manual `[C2C Handoff]`.
Never launch a browser, resolve Project bindings, open tabs or create conversations
for automatic delivery.

Import `<checkout>/dist/c2c/browser.mjs` once in that existing browser REPL. Call
`createBrowserSender(browser, composerName)` with the observed composer name. It pins
the selected conversation and rejects missing, Project landing or transient URLs
with `ASYNC_THREAD_REQUIRED`. Do not read conversation history or audit replies.
Retain this sender and the original complete handoff in memory for the task.

Only after sender creation succeeds, use prepare → send once → MCP callback → result.
Registration checks ownership and creates fresh correlation/capability. OAuth
`audit.submit` is enforced on the actual MCP callback; local health and repository
reads do not prove callback acceptance.

## Prepare and send

Use the routed `hubId`, explicit registered `workspaceId` and canonical
`workspaceRoot`. Never infer ownership from a chat URL or borrow another Hub.
Choose one task ID for this independently authorized user request and keep it stable
across its rounds. Use one terminal process and one pinned sender per task.

1. After the browser check, run `node <checkout>/dist/c2c/local.mjs async` with the
   supported terminal tool and `tty=true`. Request official terminal escalation for
   loopback or state access when needed. Send one JSONL command through `write_stdin`:
   `{"operation":"prepare","options":{"hubId":"<hub>","workspaceId":"<id>","workspaceRoot":"<root>","taskId":"<request-id>"},"handoff":"[C2C Handoff]\n..."}`.
   `async` is internal; the public opt-in is `auto=true`.
2. Prepare returns `{ticket,expiresAt,remainingMs}` and immediately opens one bounded
   HTTP event wait. It never polls or echoes the original handoff through PTY.
   With `tty=true`, ticket and result output uses short ASCII `C2C_JSON_V1_OK` or
   `C2C_JSON_V1_ERROR` frames ending in `C2C_JSON_END`. Framing still protects ticket,
   capability and result bytes against Windows PTY wrapping. Pipes use JSONL.
   Keep the terminal at least 20 columns wide, including during resizing. All TTY
   responses are framed; the decoder verifies wrapped digest/payload bytes.
   Retain complete output across tool chunks. Do not JSON.parse individual terminal
   lines or strip physical newlines to guess a response.
3. In the same existing browser REPL, use `decodeTerminalOutput` on the complete
   prepare response and require `ok:true`. Missing/corrupted frames stop delivery
   with `ASYNC_TERMINAL_OUTPUT_INVALID`. Decode and call
   `sender.send(response.value, originalHandoff)` in one invocation,
   exactly once. The sender verifies the retained handoff against the ticket's
   `handoffId`, checks the pinned thread, draft and deadline, and presses Enter once.
   Preserve the complete `C2C_CALLBACK` ticket only within the routed audit. Never
   print or persist the decoded ticket or capability.
4. Wait for the terminal result without another command. Only MCP
   `submit_audit_result` completes the attempt.
   A chat reply cannot complete it. On browser failure, catch `BrowserSendError` in
   the REPL and report only `{code:error.message,delivery:error.delivery}` without
   dumping the request or error cause, then follow [manual fallback](#manual-fallback).
5. On FIX with `canContinue:true`, send `{"operation":"verifySourceForFix"}`
   immediately before editing. Proceed only on `canAutoFix:true`: this invalidates
   the completed capability against the live Hub and rechecks unchanged source.
   After one scoped fix and focused validation, send
   `{"operation":"prepare","handoff":"[C2C Handoff]\n..."}` in the same process,
   omitting immutable options. Reuse the same sender and repeat the send/wait steps.
   Stop on PASS/BLOCKED/ERROR or `canContinue:false`. Maximum: three audits/two fixes.

The default 600-second maximum deadline includes preparation, registration, sending
and waiting. Optional `timeoutMs` in options may shorten it; nothing restarts it.
Each normal audit uses two source fingerprints: before registration and on callback receipt.
Drift during registration, sending or waiting rejects the result. FIX adds one
check immediately before editing. Never edit while an attempt is pending or run a
separate `fingerprint` command as an extra gate.

Input/fix phases have no separate idle timer. Lost sessions cannot resume.
The Hub keeps bounded replay
guards for `(workspaceId,taskId)` until ten minutes after each attempt's capability
deadline, including after cancellation, interruption or timeout. Fresh attempt IDs
or changed handoff text do not bypass the guard. FIX continuation must present the
latest authenticated, invalidated FIX ticket. After verification, editing/testing
may outlast the callback deadline, but continuation must precede guard expiry.
Guards share the existing 64-entry inbox limit and expire without permanent files.
A Hub restart loses both guards and capabilities; never restart it to retry delivery.
Abandoned legacy claim files are ignored and left untouched. A separately authorized
new task gets its own process and task ID. Expiration does not authorize a retry.

For a multi-repo request, each repository needs its own correctly routed workspace/root
and terminal/sender. A fingerprint for one repository proves nothing about another;
do not extend the controller for batch work or navigate to find another thread.

E2E passes only when the Hub returns `accepted:true` and the terminal receives the
matching result. Wrong correlation/capability, conflicting, expired or revoked
callbacks fail closed; exact duplicates are idempotent until capability expiration.

## Manual fallback

On missing browser/conversation or any prepare, send or callback failure, stop
automation without resending. EOF, Ctrl+C or interruption cancels a
pending attempt. Interrupt the same terminal if it is still running; cancellation
is best effort and cannot unsend a message. Do not retry registration, sending,
callback submission or waiting, recreate a controller/sender for the failed task,
reuse a ticket for another audit or change task IDs to bypass limits.
An interrupted fill or pre-Enter failure may leave a callback draft. Inspect it
manually after cancellation; never send the stale ticket or automatically clear
the composer over user edits.
On EPERM or denied escalation, later approval does not authorize a retry.
Do not change sandbox settings, add another transport, rollout or re-consent without
authorization. Callback transport stays in the terminal.

Report a safe code and sending state outside the copyable handoff:

- `not_sent`: Enter was not attempted, including missing browser/thread or prepare failure.
- `uncertain`: Enter was attempted but delivery could not be confirmed.
- `sent`: sending was confirmed; a later callback failure does not undo delivery.

If the browser tool fails without delivery metadata, report `uncertain` unless
there is explicit evidence Enter was never attempted. For `uncertain` or `sent`,
warn outside the handoff that manual sending may duplicate an already delivered
message. A returned ERROR/BLOCKED is an audit failure; never label it PASS or claim
callback acceptance without evidence.

Output the original complete handoff using the [common handoff format](workflow.md#codex--web)
in a separate copyable block whose first line is `[C2C Handoff]`. Exclude the callback
ticket, `C2C_CALLBACK`, capability, credentials and raw transport dumps. Do not persist
the handoff or reconstruct it from a ticket. Report source drift and unchecked limits;
validation applies only to the tested revision. The user decides whether and where to copy it.

For explicitly requested diagnostics, see [local callback helpers](operations.md#local-callback-helpers).
