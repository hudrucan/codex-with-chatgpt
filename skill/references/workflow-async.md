# Async C2C sender

Load with the [common contract](workflow.md) only for explicit `async=true`
on the Codex sender or an isolated connection permission probe. Web handoff
audits use the [receiver contract](workflow-web.md), not this terminal/browser flow.

Omitted `async` or `async=false` uses manual delivery without browser, Hub or task
state access. Async requires the routed `hubId`, explicit registered `workspaceId`,
canonical `workspaceRoot` and one stable `taskId` for that workspace. Missing
ownership blocks sending; do not infer it from a chat URL or substitute another
Hub/thread.

Before sending, require successful [permission probe](#permission-probe) evidence
for runtime ownership, ChatGPT `audit.submit` consent and terminal loopback access.
Reuse that evidence in the same session only while runtime identity, Hub owner,
connector and permissions are known unchanged. Probe again after restart/rollout,
permission or connector changes, permission errors, or missing/uncertain evidence.
This reuses evidence only, never a ticket/capability; every attempt still registers
fresh correlation/capability and performs all ownership, permission, source,
deadline, claim and send-once checks. Local tests do not prove live readiness.
On EPERM,
request official escalation for `127.0.0.1`; denial keeps async disabled. Callback
operations use that terminal, independently of REPL fetch permissions. Do not change
sandbox settings, add another transport, rollout or re-consent without authorization.

For a multi-repo request, audit each repository with its own correctly routed
workspace/root, task-local terminal session and attempt/source gate. A fingerprint
for one repository proves nothing about another. Keep each task ID stable through
its rounds; do not extend the controller for batch work or bypass a claim/limit.

Use one task-local terminal process and one in-app browser sender per workspace:

1. Run `node <checkout>/dist/c2c/local.mjs async` with the supported terminal tool,
   `tty=true` to keep stdin open and official loopback approval when required.
   Keep its session ID and send JSONL through `write_stdin`, not shell interpolation
   or credentials in argv. First line:
   `{"async":true,"hubId":"<known-hub>","workspaceId":"<id>","workspaceRoot":"<canonical-root>","taskId":"<stable-task>"}`.
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

The default 600-second maximum deadline includes registration, sending and waiting;
send acknowledgement never restarts it. Optional `timeoutMs` may shorten this deadline.
Input/fix phases expire independently after 180 seconds of idle input.
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

## Permission probe

Use this isolated check during connection verification and when async delivery
lacks reusable evidence under the rule above.
It creates no task claim or coding loop. Verify the selected Hub with `c2c status
--hub <hubId> --json` and the exact registered root/ID with `c2c workspace list`.
One-shot `callback register`, `callback wait` and `callback cancel` read one JSON
document through EOF, up to 4096 bytes. Prefer a pipe whose writer closes stdin
after the document; an interactive PTY must also send EOF. A newline alone does
not complete these commands. Keep tickets out of shell interpolation and argv.
Only the long-lived `async` command uses JSONL with stdin kept open.

Then run `node <checkout>/dist/c2c/local.mjs callback register` with JSON stdin:

```json
{"hubId":"<hubId>","workspaceId":"<workspaceId>","taskId":"<probe-id>","attemptId":"<fresh-uuid>","handoffId":"<sha256-of-probe-message>","timeoutMs":600000}
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
