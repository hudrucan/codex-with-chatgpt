# Jev MCP

An independent, optional TypeSafe Jev evaluator for Codex Local and ChatGPT Web.
It exposes one `evaluate` tool with batched `noul`, `choice`, and `score` questions,
returning probabilities, the pinned `jev-1.14.0` model, and token usage.

Default to skipping Jev. Invoke it explicitly or conditionally when useful for
comparing alternatives, examining hypotheses, or prioritizing uncertain evidence.
It supplies advice, never authority over correctness, security, hard constraints,
or final decisions. Failure or uncertain results should not block the main task.

## Build and test

Run from the repository root with its existing Node >=20 and pnpm toolchain:

```sh
corepack pnpm exec tsc -p services/jev/tsconfig.json
corepack pnpm exec vitest run --config services/jev/vitest.config.ts
```

No new dependencies, fork, or vendored upstream code are required. The
[reference MCP](https://github.com/anasbekheit/typesafe-jev-mcp) informs the tool
shape. The implementation uses the [TypeSafe HTTP API](https://docs.typesafe.ai/api.md)
directly and the existing MCP SDK, Express, and Zod dependencies.

## Independent Mac deployment

The commands below use deployment labels as examples; names are saved in external
state, not hardcoded into the service. Choose an unused port and hostname.

```sh
node services/jev/dist/index.js init \
  --name typesafe-jev --public-url https://jev.huynm.dev --port 49873

# Set TYPESAFE_API_KEY in the invoking shell without placing it in history or arguments.
node services/jev/dist/index.js start
node services/jev/dist/index.js verify --infer

# Provisioning additionally requires CLOUDFLARE_API_TOKEN in this shell.
node services/jev/dist/index.js provision-tunnel \
  --zone huynm.dev --tunnel-name typesafe-jev
node services/jev/dist/index.js stop
node services/jev/dist/index.js start
node services/jev/dist/index.js verify --public --infer
```

Like C2C, `start` launches a detached Node daemon inheriting the invoking process's
environment, including its CA/proxy configuration. macOS GUI processes do not
automatically inherit shell exports: run `start` from the shell where
`TYPESAFE_API_KEY` is available. The key is not written to configuration, command
arguments, or logs. A restart after logout/reboot requires starting from an
environment with the key again. `serve` is available for a foreground process.

State defaults to `~/Library/Application Support/jev-mcp`, independently of C2C.
`--state-dir` selects an existing parent for a new private directory during `init`.
Existing directories are never adopted. Runtime status, OAuth, consent secret,
spending ledger, tunnel credentials, plugin manifests, and logs stay outside Git.
Directories require owner-only permissions; private files require mode 0600.

`status` and `stop` authenticate a local-only admin endpoint and verify the saved
process identity before acting. Stop retains OAuth, budgets, and reusable tunnel
resources. A stale runtime lock or uncertain Cloudflare create outcome requires
explicit ownership reconciliation; there is no automatic resource adoption,
suffix fallback, deletion, or destructive recovery.

Cloudflare account access can be reused for provisioning. The named tunnel,
credentials file, hostname, DNS binding, process, and endpoint belong exclusively
to Jev. Tunnel startup first checks local authentication, PKCE, token rotation,
revocation, MCP initialize and tool discovery. Failure prevents public exposure.
Ingress has one explicit hostname and a 404 fallback. No C2C state or runtime
modules are imported: its OAuth store/scopes and lifecycle utilities are bound to
Hub identity. Jev follows the same stateless transport, detached-process,
ownership-checking and persisted-intent patterns using the shared dependencies.

## Connect clients

For Codex Local:

```sh
codex mcp add typesafe-jev --url http://127.0.0.1:49873/mcp
# The add command may perform OAuth automatically; otherwise:
codex mcp login typesafe-jev --scopes jev.evaluate
codex mcp get typesafe-jev --json
```

Approve only the expected client and redirect shown on the consent page. Use the
`approvalSecret` from Jev's private `credentials.json`; this is independent of C2C
pairing and OAuth. Scope is limited to `jev.evaluate`. Local and public OAuth
resource audiences are distinct. Tokens cannot cross these audiences or C2C.

For ChatGPT Web, create a **separate** custom MCP plugin with the chosen name,
Server URL `https://jev.huynm.dev/mcp`, and OAuth authentication. Keep existing
C2C plugins unchanged. `init` also generates a portable `plugin/plugin.json` and
`plugin/mcp.json` under the external state directory. A manifest or successful
HTTPS health check does not prove a ChatGPT binding. Complete OAuth in ChatGPT,
then make an authenticated `evaluate` call before claiming Web E2E success.
See [OpenAI's connection instructions](https://developers.openai.com/plugins/deploy/connect-chatgpt).

## Tool contract and limits

```json
{
  "invocationReason": "Compare these alternatives because maintenance evidence is ambiguous.",
  "state": {"A": "A local cache with explicit invalidation", "B": "Repeated direct reads"},
  "questions": {
    "cache_helpful": {"type": "noul", "instructions": "Could A reduce repeated reads?"},
    "maintenance": {"type": "choice", "instructions": "Which has fewer moving parts?", "criteria": {"A": "Cache", "B": "Direct reads"}},
    "evidence": {"type": "score", "instructions": "How complete is the evidence?", "criteria": ["No measurements", "Representative measurements"]}
  }
}
```

Only deliberately supplied JSON state is transmitted to the fixed TypeSafe API.
The service has no repository, shell, filesystem, Git, or workspace tools. It does
not follow URLs or load assets. Never submit credentials or private content without
authorization. Known credential patterns and the service API key are rejected;
this check cannot identify every secret, so the caller must select safe state.

Limits: 16 KiB serialized tool arguments, 12 nested JSON levels, 1–16 questions,
2–32 Choice alternatives, 2–10 Score levels, one concurrent inference, 15-second
upstream timeout, and 64 KiB upstream response. No retries or long-context/image
danger-zone headers are enabled. Responses must match the pinned model, requested
question IDs/types, and valid probability distributions. Uncertainty is returned
without inventing a verdict or a universal confidence threshold.

Defaults allow 10 attempts and 655,360 reserved input tokens per UTC day.
`init --daily-attempts N --daily-tokens N` sets bounded limits. Each dispatch
reserves 65,536 input tokens, the conservative full standard context allowance,
before networking. Reservations survive failures, timeouts, and restarts and are
never refunded automatically. Usage reports actual provider tokens separately.
These are local request/token safeguards, not a guaranteed currency cap; configure
provider-side account spending limits too. A missing/corrupt budget fails closed.
HTTP requests and OAuth endpoints also have bounded rates and state capacities.

`verify` uses synthetic public text. Without `--infer` it exercises authentication,
PKCE rejection, refresh rotation/revocation, initialize and `tools/list` without
paid inference. `--public` checks the HTTPS route; `--infer` explicitly spends one
bounded request for all three primitives. Neither establishes ChatGPT Web E2E.
