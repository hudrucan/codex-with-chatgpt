# Desk C2C Hub security model

## Trust boundaries

1. **Bridge startup identity** owns the read grants. Every token remains bound
   to that owner's `workspace_id`. A bridge reads only canonical roots explicitly
   registered in `workspace-registries/<ownerWorkspaceId>.json`; another bridge
   in the same state directory cannot use or discover those grants. The registry
   file's owner ID must match the bridge startup identity. Only the owner-keyed
   registry format grants read access.
2. **Workspace content is untrusted.** README, comments, diffs may contain
   prompt injection. Workspace-content tool descriptions carry an explicit warning
   and tools never grant capabilities based on file content.
3. **The model never sees long-lived credentials.** Browser automation only ever
   handles the one-time pairing code. Access/refresh tokens travel only inside
   the OAuth redirect/token endpoints between ChatGPT's client and the bridge.

## Threat model → mitigations

| Threat | Mitigation |
| --- | --- |
| MCP URL leaks | URL alone is useless: every `/mcp` request requires a valid bearer token (401 without, 403 wrong workspace) |
| Pairing code brute force | 8 chars from a 31-char CSPRNG alphabet (~40 bits), 5 attempts per session, per-IP rate limit (10/min), 5-minute TTL, one-time use, session destroyed on limit |
| OAuth CSRF | `state` round-tripped verbatim; authorization requests are server-side records keyed by random ids |
| Code interception | PKCE S256 mandatory (plain rejected); authorization codes are one-time, 5-minute TTL, bound to client + redirect URI |
| Token theft | Opaque high-entropy tokens; stored only as SHA-256 hashes; access tokens live 1 h; refresh tokens rotate on every use (replay of the old one fails); revocation endpoint + `c2c unpair` |
| Cross-owner repo access | Registries and alias namespaces are keyed by the bridge startup workspace ID; MCP accepts no owner override and resolves registered aliases/IDs independently on every tool call |
| Workspace traversal | `realpath` canonicalization of the deepest existing ancestor; containment check against the canonical root; case-insensitive comparison on macOS/Windows; rejects `..`, absolute escapes, backslash tricks, null bytes |
| Symlink escape | Canonicalization resolves symlinks before the containment check (file and directory symlinks both covered by tests) |
| Sensitive files | Deny-by-default patterns (.env*, keys, SSH, cloud creds, keychains…) enforced at resolve time — reads, listings, and search all pass through the same gate; `git diff` adds pathspec excludes; `.env.example` allowed |
| Oversized file / diff DoS | read_file caps lines and bytes per response; git_diff paginates by byte offset with hard caps; search caps matches and file sizes |
| Tunnel exposure | Bridge binds 127.0.0.1 only (refuses 0.0.0.0); the only public surface is HTTPS via the tunnel, protected by OAuth; `/health` reveals only the root-derived workspace ID |
| Admin API abuse | Loopback-only + random admin token (0600 runtime file) + requests with proxy headers (`cf-connecting-ip`, `x-forwarded-for`) rejected; unauthenticated probes get 404 |
| Log credential leakage | Logger redacts token prefixes, bearer headers, token-like parameters, and pairing-code-shaped strings before writing |

## Token & scope design

Scopes: `workspace.read`, `workspace.search`, `git.read`, `offline_access`. Tools enforce scopes individually (`INSUFFICIENT_SCOPE`).
Access tokens: 1 hour. Refresh tokens: 30 days, rotated. All tokens bound to
`workspace_id` and `client_id`. Explicit scope requests are intersected with
supported scopes; an unsupported-only request grants none instead of falling
back to every core permission.

## Storage

State lives under the OS-convention app dir
(`~/Library/Application Support/codex-with-chatgpt` on macOS), directories 0700,
files 0600. Named-hostname preference and tunnel metadata live there too
(`tunnels/<workspaceId>.json`) — never in the project. Only SHA-256 hashes of
tokens are persisted — a stolen token-hash file does not yield usable bearer tokens.
Read grants live in `workspace-registries/<ownerWorkspaceId>.json`, with matching
`ownerWorkspaceId` metadata and canonical roots. Registry updates use an exclusive
owner-local lock and atomic replacement; no repository configuration is written.

**Storage limitation**: client registrations and token hashes are file-based rather
than OS-keychain-based. Raw tokens are never written anywhere. Keychain integration is not implemented.

## MCP capability boundary

Eight read-only tools expose workspace discovery and bounded repo reads.
`list_workspaces` returns aliases and IDs without local roots. The workspace
selector accepts registered aliases or IDs, never arbitrary local roots, and
cannot select another owner. See [multi-repo access](multi-repo.md) for tool
scopes, selection rules and registry format.

Canonical containment, sensitive-file and git policies apply to every selected
root. Files and diffs are untrusted project data and cannot authorize new grants.

Write files, delete files, run shell commands, commit, install packages —
these tools do not exist on the server, so no prompt injection, scope bug, or
UI confusion can enable them.
