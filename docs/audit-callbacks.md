# Audit callback boundary

`submit_audit_result` accepts one terminal result for an existing local attempt.
It is state-changing (`readOnlyHint:false`), non-destructive, idempotent and closed
to external resources. OAuth `audit.submit` must be explicitly requested; existing
repository-read grants do not acquire this permission automatically. These MCP
annotations describe the operation, not a guarantee of ChatGPT confirmation behavior.

Local callers register through the existing loopback admin API and receive an
unguessable 256-bit capability. The Hub retains at most 64 entries in memory,
each lasting at most 180 seconds. Results are capped at 16 KiB. Registration,
waiting and cancellation require the runtime admin token and reject proxy headers.
Capabilities never appear in URLs, runtime metadata or logs. No new service,
database or repository-write capability is introduced.

Callbacks match `hubId`, `workspaceId`, `taskId`, `attemptId`, `handoffId` and the
capability. The workspace must still be registered to that Hub. Identical terminal
callbacks succeed until expiration; different results conflict. Cancellation,
deadline expiration and runtime restart reject further delivery. A single local
HTTP wait resolves on the terminal event or fails on deadline, interruption or
shutdown; it does not poll the inbox.

## Local transport and readiness

The local helper supports `callback register`, `callback wait` and `callback cancel`
with a JSON object on stdin, never credentials on the command line. The `async`
operation holds one bounded task session over terminal JSONL stdin/stdout. It
validates source and transport/ownership, claims the task once, prepares one browser
message, then receives each result through one local HTTP event wait. The browser
sender has no result reader or network transport. See the authoritative
[workflow](../skill/references/workflow.md#async-callback-workflow) for operations.

Only opt in after an isolated terminal register → authenticated MCP callback →
terminal wait succeeds under the actual client's permissions. If sandboxed
loopback fails with EPERM, request the client's official narrow approval for
`127.0.0.1`; do not change security settings or introduce another IPC path. Use
the terminal for callback operations even if the browser REPL cannot fetch.
If approval is denied, keep async disabled. A missing/old runtime or transport
failure produces no browser message or new claim. Do not send an audit to test
permissions or retry an old task/claim.

Local verification does not deploy code or prove ChatGPT tool availability,
OAuth `audit.submit` consent or confirmation behavior. Those require a separately
authorized runtime rollout, connector tool refresh/consent and live E2E validation.
Existing repository-read tokens remain valid for all ten read tools and are
insufficient for callbacks. Manual C2C remains available with `async=false` or
an omitted flag.
