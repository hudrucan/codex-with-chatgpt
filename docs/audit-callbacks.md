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

## Capability gate

The local helper supports `callback register`, `callback wait` and `callback cancel`
with a JSON object on stdin, never credentials on the command line. These are
transport primitives, not an enabled automatic audit/fix flow. `async=true` fails
with `ASYNC_CALLBACK_UNAVAILABLE` before any browser access, claim or delivery;
the local helper's `async` operation checks that flag without touching task state.
Manual C2C remains available through explicit `async=false` or an omitted flag.
Do not send a browser audit to test this gate or retry an old task/claim. A passing
isolated integration test does not prove Codex command loopback permissions,
ChatGPT tool availability, OAuth consent or confirmation UI. Permission failures
require the client's official approval mechanism; do not introduce another IPC path.
