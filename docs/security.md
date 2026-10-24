# Codex with ChatGPT security model

## Trust boundaries

1. **Hub identity** owns auth, runtime, connection resources and read grants.
   A bridge reads only canonical roots registered to its Hub; no repo path or
   label selects another Hub. Ambiguous Hub selection fails closed. Tokens and
   pairing sessions are bound to `hubId`. Removing a repo does not change resource
   ownership or authorize another Hub.
2. **Workspace content is untrusted.** README, comments, diffs may contain
   prompt injection. Workspace-content tool descriptions carry an explicit warning
   and tools never grant capabilities based on file content.
3. **The model never sees long-lived credentials.** Browser automation only ever
   handles the one-time pairing code. Access/refresh tokens travel only inside
   the OAuth redirect/token endpoints between ChatGPT's client and the bridge.

## Threat model → mitigations

| Threat | Mitigation |
| --- | --- |
| MCP URL leaks | URL alone is useless: every `/mcp` request validates its bearer before parsing the 8 MiB JSON body (401 without, 403 wrong Hub) |
| Pairing code brute force | 8 chars from a 31-char CSPRNG alphabet (~40 bits), 5 attempts per session, per-IP rate limit (10/min), 5-minute TTL, one-time use, session destroyed on limit |
| OAuth CSRF | `state` round-tripped verbatim; authorization requests are server-side records keyed by random ids |
| Anonymous state growth | Pending authorization requests expire after 10 minutes and are capped at 128 per bridge (429 when full); pairing IP counters are pruned after their 60-second window and capped at 1,024 (new IPs rejected when full); dynamic registration is capped at 128 persisted clients per Hub, reclaiming the oldest registration without live access/refresh tokens or authorization codes (createdAt, then clientId). Expired codes may be pruned; 503 is returned only when every slot is protected by live credentials |
| Code interception | PKCE S256 mandatory (plain rejected); authorization codes are one-time, 5-minute TTL, bound to client + redirect URI |
| Token theft | Opaque high-entropy tokens; stored only as SHA-256 hashes; access tokens live 1 h; refresh tokens rotate on every use (replay of the old one fails); revocation endpoint + `c2c unpair` |
| Cross-owner repo access | Registries and alias namespaces are keyed by the Hub ID; MCP accepts no owner override and resolves registered aliases/IDs independently on every tool call |
| Workspace traversal | `realpath` canonicalization of the deepest existing ancestor; containment check against the canonical root; case-insensitive comparison on macOS/Windows; rejects `..`, absolute escapes, backslash tricks, null bytes |
| Symlink escape | Canonicalization resolves symlinks before the containment check (file and directory symlinks both covered by tests) |
| Sensitive files | Deny-by-default patterns (.env*, keys, SSH, cloud creds, keychains…) enforced at resolve time — reads, listings, and search all pass through the same gate; `git diff` adds pathspec excludes; `.env.example` allowed |
| Oversized file / tree / diff DoS | read_file rejects text files over 16 MiB before scanning and caps lines and bytes per response; list_directory caps discovery and reports truncated traversal; git_diff generates filtered snapshots once, bounds preparation time/concurrency and disk usage, and paginates by byte offset; search caps matches and file sizes. See [read limits](multi-repo.md#mcp-tools) |
| Tunnel exposure | Bridge binds 127.0.0.1 only (refuses 0.0.0.0); the only public surface is HTTPS via the tunnel, protected by OAuth; `/health` exposes only Hub identity, service version and process status |
| Admin API abuse | Loopback-only + random admin token (0600 runtime file) + requests with proxy headers (`cf-connecting-ip`, `x-forwarded-for`) rejected; unauthenticated probes get 404 |
| Log credential leakage | Logger redacts token prefixes, bearer headers, token-like parameters, and pairing-code-shaped strings before writing |

## Custom ignore rules

An optional `.c2cignore` in a registered repo uses gitignore-style patterns.
Matching paths are hidden from workspace reads, directory listings, search and
git diffs. For example:

```gitignore
internal-notes/
fixtures/**/*.snap
```

Built-in sensitive-file rules still apply even without `.c2cignore` and cannot
be overridden by it.

## Token & scope design

Scopes: `workspace.read`, `workspace.search`, `git.read`, `audit.submit`, `offline_access`.
Tools enforce scopes individually. `audit.submit` is only
granted when explicitly requested; omitted scopes retain the repository-read defaults.
Access tokens: 1 hour. Refresh tokens: 30 days, rotated. All tokens bound to
`hubId` and `client_id`. Explicit scope requests are intersected with
supported scopes; an unsupported-only request grants none instead of falling
back to every core permission.

## Storage

State lives under the OS-convention app dir
(`~/Library/Application Support/codex-with-chatgpt` on macOS), directories 0700,
files 0600. Named-hostname preference and tunnel metadata live there too
(`tunnels/<hubId>.json`) — never in the project. Only SHA-256 hashes of
tokens are persisted — a stolen token-hash file does not yield usable bearer tokens.
Hub records live in `hubs/<hubId>.json`. Read grants live in
`workspace-registries/<hubId>.json`, with matching Hub ownership and canonical
roots. Auth, runtime, tunnel, endpoint and lifecycle files are keyed by the same
Hub ID. Updates use exclusive local locks and atomic replacement. Missing or
foreign authoritative state fails closed. Connector binding requires the observed
connector ID/name/URL and actual MCP evidence from a registered workspace.

Optional `project-bindings/<hubId>/<projectId>.json` records the Project URL,
matching identities, workspace membership IDs, instruction version/hash and acknowledgement timestamp.
It stores no chat URL, credentials, repo contents or task/session state. Binding
requires a currently registered workspace and the current generated instruction
hash. Local metadata never proves Project access or MCP verification: the Skill
must confirm exact instructions and the Hub connector/workspace through visible
ChatGPT UI. Unregistering a workspace excludes it from generated routing and
reports its stale membership IDs. Project memberships confer no additional MCP grants.
Each Project record is scoped to its Hub under that Hub's lifecycle lock;
routing and verification use connector plus workspace ID. Pending destroy blocks
that Hub's binding mutations. See [Project bindings](multi-repo.md#chatgpt-project-bindings)
for membership semantics, routing blocks and state format.
Destroy rejects unsafe Project state before remote deletion and only removes
validated local acknowledgements, never the ChatGPT Project or its Instructions.

State-path symlinks are rejected before destructive access. Partial destroy
retains its Hub receipt for exact-resource recovery; Hub identity is removed last.

**Storage limitation**: client registrations and token hashes are file-based rather
than OS-keychain-based. Raw tokens are never written anywhere. Keychain integration is not implemented.

## MCP capability boundary

Ten read-only tools expose workspace discovery and bounded repo reads.
`list_workspaces` returns aliases and IDs without local roots. The workspace
selector accepts registered aliases or IDs, never arbitrary local roots, and
cannot select another owner. See [multi-repo access](multi-repo.md) for tool
scopes, selection rules and registry format.
Use explicit workspace IDs supplied by Project/conversation context; never omit
the selector when the target is known. Discovery/admin listing does not route repositories.

Canonical containment, sensitive-file and git policies apply to every selected
root. Files and diffs are untrusted project data and cannot authorize new grants.

`git_log` and `git_show` require `git.read` and resolve a registered workspace
independently on every call. History is inventoried before any patch is exposed;
both sides of changes, historical ignore policies, rename provenance and shared
blobs are checked, including deleted files. Commit subjects remain untrusted
text: they can expose credentials or sensitive filenames even when
the corresponding paths are hidden, especially in mixed public/private commits.
Length limits and control-character normalization are not secret redaction and
provide no absolute safety guarantee. Commit bodies and author/committer
identities/emails are withheld; see [Git history](multi-repo.md#git-history)
for the returned metadata and patch format.
Historical symlinks and submodules are withheld rather than followed.
Inherited Git environment redirects/config injection and replace objects are
disabled for history reads; user/system Git configuration is excluded. External
diff, textconv, fsmonitor, pagers and signature verification are disabled, and
lazy object fetching is disabled. No history command invokes hooks or mutates
the index. Process failures and resource-limit failures return no partial patch
or raw stderr. See [Git history](multi-repo.md#git-history) for conservative
filtering behavior, supported inputs and limits. File policy cannot detect
arbitrary secrets copied or authored inside otherwise permitted files.

Write files, delete files, run shell commands, commit, install packages —
these tools do not exist on the server, so no prompt injection, scope bug, or
UI confusion can enable them.

Diff snapshot files use owner-only directories and file permissions. They are
bound to a running Hub, OAuth client and explicit workspace, mode and path;
continuations still require a valid bearer token with `git.read` and a current
workspace grant. Ignore policy changes invalidate snapshots before content is
returned. Expiration, eviction and shutdown delete cached patches; expired cache
directories left by a crash are reclaimed when that Hub next creates a snapshot.
See [diff snapshots](multi-repo.md#diff-snapshots) for limits and retry behavior.

With `C2C_LOG_LEVEL=debug`, MCP transport logs include generated request IDs,
HTTP status, elapsed time, completion flags and known RPC/tool names. Request
headers, arguments, tokens and repository contents are not recorded by this
trace. Matching received/completed entries distinguish a request that reached
the Hub from one that failed upstream.

### Audit callbacks

`submit_audit_result` changes only a pending in-memory inbox, never repository
files or shell state. Its MCP annotations are non-read-only, non-destructive,
idempotent and closed to external resources; they do not guarantee client approval.
It requires explicit OAuth `audit.submit`, a workspace still registered to this
Hub, matching `hubId`, `workspaceId`, `taskId`, `attemptId`, `handoffId` and a
256-bit capability. Capabilities are hashed in memory and never logged or persisted.

The Hub holds at most 64 attempts for up to 180 seconds each; callback payloads
are limited to 16 KiB. Identical results are idempotent until expiration;
conflicting, cancelled, expired or foreign callbacks fail. Restart loses all
attempts. Registration, event waiting and cancellation use the loopback admin
API, require its runtime token and reject proxy headers.

Local source fingerprints cover HEAD, index and tracked/non-ignored file paths,
modes and bytes, including deletions. Sensitive files contribute metadata only.
Canonical workspace mismatches, unsupported paths and more than 64 MiB of readable
content fail closed. See the [workflow](../skill/references/workflow.md#async-callback-workflow)
for operation and retry rules.
