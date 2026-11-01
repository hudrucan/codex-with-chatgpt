# Automatic C2C sender

Load with the [common contract](workflow.md) only for explicit `auto=true`.
Web supplies the user's conversation URL/ID in the prompt and reuses it within
that workflow. Codex never asks again, scans tabs or infers it from ambient UI.
Missing/invalid conversation input fails before source hashing or registration.

## Direct CDP

Configure an existing C2C-owned private Edge profile once with
`node <checkout>/dist/c2c/local.mjs cdp-configure`, supplying
`{hubId,workspaceId,profileDirectory,executable}` as JSON on stdin.
Only profile settings are saved in local runtime configuration; no conversation,
endpoint, credential or callback is stored there.
Each `auto=true` controller then verifies ownership, reuses or launches that
profile and resolves its current loopback endpoint without thread-local setup.
Startup waits for the browser's endpoint-file event, without polling or sleeps.
An optional `C2C_CDP_ENDPOINT` overrides this only for explicit diagnostics.
Node must expose native `WebSocket`
(Node 22+; Node 20 requires its experimental WebSocket flag).
Profile conflicts, authentication or challenges fail before an attempt; report
the required user action. Do not
automate authentication/challenges or change browser flags to evade protections.

The sender creates one tab for the supplied normal or Project conversation URL
(a bare ID means `https://chatgpt.com/c/<id>`), then pins its CDP session and route
for the whole task, including FIX. It verifies the live URL and empty composer
before prepare; each write checks identity/draft atomically in the renderer.
One fill and one send-button click; no in-app browser, CUA REPL, prepared HTTP
packet, polling, sleeps or automatic resend. Readiness uses browser events.
An existing user draft is never overwritten or automatically cleared.
On task exit, the controller closes its owned tab after a matching callback and
empty-draft check. In-flight/uncertain delivery, unconfirmed callbacks or unsafe
cleanup leave the tab open for manual inspection; cleanup is bounded and never retried.

The experimental [HTTP sender](http-sender.md) remains unactivated and is not a
fallback. There is only one automatic sender: direct CDP in the local controller.

## Prepare and send

Run `node <checkout>/dist/c2c/local.mjs async` with the host terminal (`tty=true`
when needed). Send one JSONL command through `write_stdin`:

```json
{"operation":"prepare","auto":true,"conversation":"<user URL or ID>","options":{"hubId":"<routed Hub>","workspaceId":"<registered ID>","workspaceRoot":"<canonical root>"},"handoff":"[C2C Handoff]\n..."}
```

The controller generates `taskId`; AuditSession generates fresh attempt identity
and capability. It performs prepare → send once → MCP callback → result in the
same process. Tickets never leave the controller except inside the routed message.
It includes every required `C2C_CALLBACK` field and `C2C_DEADLINE` internally.
Only authenticated MCP `submit_audit_result` completes the attempt; a send
acknowledgement or chat reply is insufficient. E2E requires `accepted:true` and
the matching terminal receipt, never inferred from HTTP/browser success.

Retain complete terminal output. TTY uses checksummed ASCII frames decoded by
`src/c2c/terminal-output.ts`; pipes use JSONL. Keep the TTY at least 20 columns
wide. Do not print tickets, capabilities, credentials or raw CDP messages.
Use official terminal escalation if loopback/state access requires it.

On FIX with `canContinue:true`, send `{"operation":"verifySourceForFix"}`
immediately before editing. Require `canAutoFix:true`, apply the scoped fix and
affected validation, then send `{"operation":"prepare","handoff":"[C2C Handoff]\n..."}`
in the same process, omitting immutable options/conversation/auto. Keep the same
sender and task identity. Maximum three audits/two fixes; no reset or recreation.

AuditSession retains source fingerprints, ownership/OAuth boundaries, the
600-second maximum deadline (optional `timeoutMs` may shorten it), callback
correlation and replay guards. Each audit has two source fingerprints, before
registration and at callback receipt; never edit while pending. Callback waiting
is one event-driven HTTP wait and returns promptly on a matching result.
FIX verifies source immediately before editing. Input/fix phases have no idle
timer. Lost sessions cannot resume; do not restart the Hub to retry an attempt.
Each independently authorized task gets a new controller and explicit target;
multi-repo work retains separate registered workspace/root ownership.
Only the [receiver's exceptions](workflow-web.md#bounded-recovery) allow bounded
MCP read/callback recovery; never retry registration, delivery or callback waiting.

## Manual fallback

On any failure, cancel/close the same controller and stop automation without
resending. No sender recreation, changed task ID or alternate transport can retry
an uncertain delivery. Preserve any draft for manual inspection.
Report the safe error and delivery state outside the copyable handoff:

- `not_sent`: the send action was never attempted.
- `uncertain`: the send action was attempted but not confirmed.
- `sent`: the browser confirmed the action; callback acceptance is separate.

For `uncertain`/`sent`, warn that manual sending may duplicate a delivered message.
Return the original handoff in a copyable block starting `[C2C Handoff]`; exclude
callback tickets, capability, credentials and transport dumps. Never label an
unverified callback PASS. See [local callback helpers](operations.md#local-callback-helpers)
only for explicitly requested diagnostics.
