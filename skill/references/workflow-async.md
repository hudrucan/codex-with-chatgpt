# Automatic C2C sender

Load with the [common contract](workflow.md) only for explicit `auto=true`
on the Codex sender. Web audits use the [receiver](workflow-web.md).
Omitted `auto` or `auto=false` stays manual without browser, Hub or task-state access.

## Existing conversation only

Before starting the terminal controller, source hashing, callback registration or
task claiming, require an existing browser and selected ChatGPT conversation.
Establish a fresh binding at the beginning of each new automatic
request through the host's documented browser initialization API, using only the
same existing browser and selected tab. JavaScript variables, tab inventory and
ambient browser context do not prove that URL/composer access still works;
do not decide availability from `typeof browser` or assume handles survive turns.
Handle stale-binding failures under [initialization recovery](#initialization-recovery)
before manual fallback. If the browser or selected conversation is genuinely missing,
return the original manual `[C2C Handoff]` without resetting or preparing an attempt.
Never launch a browser, resolve Project bindings, open tabs or create conversations
for automatic delivery.

Import `<checkout>/dist/c2c/browser.mjs` in that browser REPL. Call
`createBrowserSender(bindExistingBrowser, composerName)` with the observed composer
name. `bindExistingBrowser` is a host-supplied async function that obtains live
handles for the same existing browser/selected tab using documented APIs; it must
never launch, open, navigate, reset or recover a browser. The older
`createBrowserSender(browser, composerName)` form remains supported, but cannot
refresh a stale browser object by itself. Creation pins the browser ID (when
available), tab ID and conversation route, reads the composer without modifying
it, requires an empty draft, and rechecks the URL before prepare. Missing/Project
landing/transient URLs fail with `ASYNC_THREAD_REQUIRED`; stale bindings report
`ASYNC_BROWSER_BINDING_STALE`; other browser/composer failures report
`ASYNC_BROWSER_UNAVAILABLE`/`ASYNC_COMPOSER_UNAVAILABLE`, all `not_sent`.
Do not read conversation history or audit replies. Retain this sender and the
original complete handoff in memory for the task; do not reuse it for a new task.

Only after sender creation succeeds, use prepare → send once → MCP callback → result.
Registration checks ownership and creates fresh correlation/capability. OAuth
`audit.submit` is enforced on the actual MCP callback; local health and repository
reads do not prove callback acceptance.

## Initialization recovery

On initial `browser.user is unavailable` (optional trailing period) or
`ASYNC_BROWSER_BINDING_STALE`, one CUA REPL reset/rebind is required before
manual fallback when:

- No controller, source hashing or callback registration has started; no attempt is active.
- The host's documented REPL-only reset preserves tabs and user drafts.
- The existing browser/tab IDs and conversation URL are known and can be verified.

Retain that identity only in memory. Reset only the browser REPL through the host
tool, rebind the same selected tab, reimport the module and recreate the initial
sender if needed. Verify matching IDs, live URL and empty composer before starting
the controller. Keep reset outside `bindExistingBrowser` and the C2C browser module.
Never open tabs, navigate or clear a draft during recovery.

If any condition is unmet or recovery fails, return `not_sent` with the blocker.
No second reset. Generic `ASYNC_BROWSER_UNAVAILABLE` or `ASYNC_COMPOSER_UNAVAILABLE`
alone does not authorize recovery. Never reset or recreate a sender after controller
creation, including FIX rounds. Delivery retries remain forbidden; this recovery
does not guarantee a durable host fix.

## Verification reads

Sender creation, `verifyBinding()` and the pre-fill check allow one additional
verification on `TimeoutError` or transport codes `ETIMEDOUT`, `ECONNRESET` and
`EAI_AGAIN`. The module repeats only URL/composer reads on the pinned tab, within
the original deadline. It rechecks the thread and empty draft; it never resets,
rebinds, fills or presses Enter during recovery. Initial selection/URL failures
without a pinned conversation still fail closed.

Other errors are terminal: missing browser/composer, stale binding after controller
creation, authentication/authorization, ownership, source drift, changed thread,
user draft, replay, invalid payload or expiration. Unknown errors do not authorize
recovery. After fill or Enter, stop on failure without retrying reads or delivery.

| Phase | Recovery limit | Delivery on failure |
| --- | --- | --- |
| Initial stale binding | One host reset under the conditions above | `not_sent` |
| Pinned URL/composer verification before fill | One read-only verification | `not_sent` |
| Controller, prepare/register, terminal decode or callback wait | None; never restart or re-register | `not_sent` before Enter; otherwise preserve sending state |
| Fill | None; preserve any remaining draft | `not_sent` |
| Enter or post-Enter confirmation | None; never resend | `uncertain` |
| Web MCP read/callback | Only the [receiver's exceptions](workflow-web.md#bounded-recovery) | Preserve `sent` |

## Prepare and send

Use the routed `hubId`, explicit registered `workspaceId` and canonical
`workspaceRoot`. Never infer ownership from a chat URL or borrow another Hub.
Choose one task ID for this independently authorized user request and keep it stable
across its rounds. `taskId` must contain 1–128 ASCII characters matching
`^[A-Za-z0-9_-]+$`. Periods, spaces and slashes are not allowed. For example, use
`release-v0-3-0-b979f170` for a versioned release.

Validate the ID locally before starting the terminal controller, source hashing
or callback registration. Never change task IDs to retry a failed attempt or
bypass replay protection. Use one terminal process and one pinned sender per task.

1. Immediately before prepare, call `await sender.verifyBinding()` in the browser
   REPL. This reacquires and verifies the same browser/tab/conversation and empty
   composer through the supplied binding function, preserving the sender's
   consumed-ticket state. Initial stale binding follows initialization recovery
   above. After controller creation, only the verification reads above may recover;
   never reset or recreate the sender.
   After the browser check, run `node <checkout>/dist/c2c/local.mjs async` with the
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
3. In the same existing browser REPL, run
   `const response = await decodeTerminalOutput(fullPrepareOutput)` and require
   `response.ok === true`. Missing/corrupted frames stop delivery
   with `ASYNC_TERMINAL_OUTPUT_INVALID`. Decode and call
   `await sender.send(response.value, originalHandoff)` in one invocation,
   exactly once. The sender verifies the retained handoff against the ticket's
   `handoffId`, checks the pinned thread, draft and deadline, and presses Enter once.
   The envelope includes `C2C_DEADLINE` (absolute Unix milliseconds) for bounded
   receiver recovery; it never extends the Hub deadline.
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
   After one scoped fix and focused validation, call `await sender.verifyBinding()`
   again before the next prepare, then send
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

For initial stale-binding failures, apply [initialization recovery](#initialization-recovery)
before entering this fallback. A genuinely missing browser or conversation does
not authorize reset.
After the bounded recovery above and in the receiver contract, on any unrecovered
browser, prepare, send or callback failure, stop
automation without resending. EOF, Ctrl+C or interruption cancels a
pending attempt. Interrupt the same terminal if it is still running; cancellation
is best effort and cannot unsend a message. Do not retry registration, sending or
callback waiting. Never recreate a controller/sender for the failed task,
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
