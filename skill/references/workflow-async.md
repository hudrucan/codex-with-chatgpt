# Automatic C2C sender

Load with the [common contract](workflow.md) only for explicit `auto=true`
on the Codex sender. Web handoff audits use the [receiver contract](workflow-web.md),
not this terminal/browser flow.

Omitted `auto` or `auto=false` uses manual delivery without browser, Hub or task
state access. Automatic delivery requires the routed `hubId`, explicit registered
`workspaceId`, canonical `workspaceRoot` and one stable `taskId` for that workspace.
Missing ownership blocks sending; do not infer it from a chat URL or substitute
another Hub/thread. Keep the original complete handoff before registering it.

Go directly register → send → callback. Every attempt registers fresh
correlation/capability and performs ownership, permission, source, deadline, claim
and send-once checks. Registration proves local transport availability only;
OAuth `audit.submit` is enforced on the actual MCP callback. Local health and
repository reads do not prove callback acceptance.
Request official terminal escalation for `127.0.0.1` or state access when needed.
On EPERM or denied escalation, stop the attempt and use the manual fallback;
permission approval does not authorize an automatic retry of a failed operation.
Callback operations use that terminal, independently of REPL fetch permissions.
Do not change sandbox settings, add another transport, rollout or re-consent
without authorization.

For a multi-repo request, audit each repository with its own correctly routed
workspace/root, task-local terminal session and attempt/source gate. A fingerprint
for one repository proves nothing about another. Keep each task ID stable through
its rounds; do not extend the controller for batch work or bypass a claim/limit.

Use one task-local terminal process and one in-app browser sender per workspace:

1. Run `node <checkout>/dist/c2c/local.mjs async` with the supported terminal tool,
   `tty=true` to keep stdin open and official loopback approval when required.
   The CLI command and JSON `async` field are runtime internals; the public prompt
   opt-in is `auto=true`. Keep its session ID and send JSONL through `write_stdin`,
   not shell interpolation or credentials in argv. First line:
   `{"async":true,"hubId":"<known-hub>","workspaceId":"<id>","workspaceRoot":"<canonical-root>","taskId":"<stable-task>"}`.
   `READY` validates options/source only.
2. Send `{"operation":"submit","handoff":"[C2C Handoff]\n...","fixed":false}`.
   Success registers the attempt before claiming the task and returns `attemptId`,
   `message`, `remainingMs` and `expiresAt`. Only then may delivery start. Preserve
   the complete envelope, including `C2C_CALLBACK`, within the routed audit only.
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
   reads conversation history or audit responses. On send failure, `BrowserSendError`
   reports `delivery`; catch it in the REPL and report only
   `{code: error.message, delivery: error.delivery}` so the tool preserves this
   metadata without dumping the request or error cause. Codex handles the manual
   fallback below.
   After success, send `{"operation":"sent","attemptId":"<returned-id>"}` to the same
   terminal session to open one bounded HTTP event wait. Use normal terminal
   completion waits, not inbox polling or transcript DOM. Only an MCP
   `submit_audit_result` completes the attempt; a chat reply cannot.
5. On FIX with `canContinue:true`, send `{"operation":"verifySourceForFix"}`
   immediately before editing. Proceed only on `canAutoFix:true`: this checks
   unchanged source and invalidates the completed capability against the live Hub.
   After one in-scope fix and focused validation, submit the new handoff with
   `fixed:true` in this same process, then use the same sender and wait again.
   Stop on PASS/BLOCKED/ERROR or `canContinue:false`. Maximum: three audits/two fixes.

The default 600-second maximum deadline includes registration, sending and waiting;
send acknowledgement never restarts it. Optional `timeoutMs` may shorten this deadline.
Input/fix phases expire independently after 180 seconds of idle input.
Source drift or ownership, permission and transport failures stop the session.
EOF/interrupt cancels the attempt. Lost sessions cannot resume, and persistent
task claims must not be removed or bypassed with a new ID.

E2E passes only when the Hub returns `accepted:true` and the terminal receives the
matching result. Wrong correlation/capability and conflicting, expired or revoked
callbacks fail closed; exact duplicates are idempotent until expiration.

## Manual fallback

On register, browser setup/send, callback transport or terminal audit failure,
stop automation without resending. Retain the original handoff in Codex's current
context; do not persist it or reconstruct it from the callback envelope.
Browser errors report only a safe code and `delivery`:

- `not_sent`: Enter was not attempted; the handoff was not sent.
- `uncertain`: Enter was attempted but sending could not be confirmed.
- `sent`: sending was confirmed; a later callback failure does not undo delivery.

Registration/browser setup failures are `not_sent`. After a successful browser
send, a failed terminal wait is `sent`, even if its command acknowledgement was
lost. If the browser tool itself fails without returning delivery metadata, report
`uncertain` unless there is explicit evidence Enter was never attempted.

Report the sending state and safe failure code outside the copyable handoff.
For `uncertain` or `sent`, warn outside the handoff that manually sending it may
duplicate a message already delivered. Acknowledge a returned ERROR/BLOCKED as an
audit failure; never label it PASS or claim callback acceptance without evidence.

Then output the original complete handoff as a separate copyable block whose
exact first line is `[C2C Handoff]`. Preserve every repo's connector/Hub/workspace,
revision and uncommitted scope, changes, actual validation, risks and blockers.
Exclude the callback ticket, `C2C_CALLBACK`, capability, credentials and raw tool
or transport dumps. Add observed source drift or unchecked limits honestly;
validation still refers only to the revision actually tested.
Codex only provides the text; the user decides whether and where to copy it.

Abort or terminate the same terminal session to cancel a pending attempt, without
resetting its task claim. Cancellation is best effort and cannot unsend a message.
Do not retry registration, browser sending or callback submission/waiting; do not
create a new task to evade an existing claim or audit limits.

The helper retains one-shot `callback register`, `callback wait` and `callback
cancel`, plus local `claim`, `fingerprint` and `project` helpers. Callback commands
read one JSON document through EOF, up to 4096 bytes. Prefer a pipe whose writer
closes stdin; an interactive PTY must also send EOF. A newline alone does not
complete these commands. Keep tickets out of shell interpolation and argv.
Only the long-lived `async` command uses JSONL with stdin kept open.
