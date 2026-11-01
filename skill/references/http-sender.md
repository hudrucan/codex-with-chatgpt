# Experimental local HTTP sender

HTTP delivery is explicitly opt-in. The default browser sender and its fallback
workflow are unchanged. Import `dist/c2c/http.mjs` only when local configuration
selects `transport: "http"`, with the exact owning Hub, registered workspace and
verified conversation ID. Keep that configuration outside repositories.

The HTTP module is a sender API, not a gateway, daemon or new MCP service.
Use the existing `AuditSession` for source fingerprints, fresh callback tickets,
the original deadline, replay guards and terminal receipt. HTTP 200 and a chat
reply cannot complete an audit. Completion requires the real authenticated MCP
callback and the matching local terminal result.

## Authentication and preparation

The host supplies two explicit local adapters:

- `readConversation(signal)` performs an authenticated read of the pinned
  conversation and returns its ID, current parent ID and message IDs/roles/text.
- `prepare(message, signal)` prepares a genuine authenticated request for that
  exact message and returns its URL, headers, JSON body and `release(signal)` function.
  Release must abort any held browser POST and stop the preparation browser
  before native HTTP delivery, returning `{aborted:true,browserStopped:true}`
  only after both facts are confirmed. It must also be safe for rejected packets.

If preparation fails before returning its handle, the adapter must retain
ownership of every armed request. Only after confirming that no staged browser
POST remains may it throw `HttpPreparationError`, guaranteeing `not_sent`.
Any other preparation exception is `ASYNC_HTTP_PREPARATION_UNCONFIRMED` and
terminal `uncertain`, including exceptions that claim `not_sent` without this
explicit guarantee. Never disconnect an armed request to recover from failure.

Preparation and release use the existing attempt's abort signal and deadline.
The sender stops awaiting a stalled release at that deadline, reports
`ASYNC_HTTP_RELEASE_UNCONFIRMED`, and never posts or retries cleanup after a late
acknowledgement. The adapter must also honor the signal without dropping
debugger ownership of an unconfirmed armed request; local intervention is needed.

Keep credentials and callback capabilities in memory. Protected persistence,
when explicitly authorized, belongs in Windows user-scoped protected storage
with restrictive ACLs outside repositories. Never put credentials in arguments,
logs, source, reports or configuration. The module does not scrape sessions,
fabricate device identities, solve challenges or refresh authentication.

Browser preparation may be used with the user's permission. A browser, CDP or
CUA REPL must not be required to remain running during the native POST. Preparation
and authentication renewal remain explicit user actions; this API does not claim
indefinite browser independence.

## Delivery contract

Create one sender per independently authorized task. Call `verifyBinding()`
immediately before `AuditSession.prepare()`, then `sender.send(request, handoff)`
once and wait on the same controller. Preparation receives the complete exact
handoff and callback envelope. Redirects and arbitrary request destinations are
rejected. Identity, parent, message and handoff digest are checked before POST.

- `not_sent`: no native POST was attempted. Report the safe error code and
  required authentication or binding action. Do not silently select browser.
- `uncertain`: POST started but persistence could not be confirmed, including
  response loss or an authentication/challenge response. An armed browser POST
  whose abortion cannot be confirmed is also uncertain. Never retry delivery.
- `sent`: an authenticated read confirmed the exact message ID and content in
  the pinned conversation. Continue waiting for the existing MCP callback.

401/403, challenge, expiry and provider failures stop this sender. Do not loop
refresh, create another task to evade replay guards, extend deadlines or restart
the Hub. A separately authorized task needs its own controller and fresh ticket.

`ASYNC_HTTP_RELEASE_UNCONFIRMED` requires explicit local intervention on the owned
staged browser request. Keep debugger ownership until abortion can be confirmed;
simply disconnecting or closing it may resume the request. The sender never
retries release automatically and never treats this condition as permission to
send manually or switch transports.

Local activation should select HTTP only after a live callback E2E succeeds.
If activation or its smoke test fails, remove that opt-in selection and keep the
normal browser sender available. Do not change the default or OAuth scope.
