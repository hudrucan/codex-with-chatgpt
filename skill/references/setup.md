# Setup, verification and lifecycle

Read only for the requested connection operation. Successful setup/reconnect
ends at **MCP READY**, then stop without planning, coding or audit loops.
Optional [Projects](projects.md) reuse the Hub connector. Do not persist chat
URLs, sessions or checkpoints.

## Location and selection

Use the checkout bound in [the entrypoint](../SKILL.md). The bridge runtime
requires Node >= 20; the pinned pnpm toolchain requires Node >= 22.13 and Corepack. Build/install only if absent or
explicitly updating; never pull just to start a connection.
Keep OS C2C state outside repos. Keep display naming in external workspace state.

Start with `c2c hub list --json`:

- One Hub: use it automatically. The user need not know its internal ID.
- Multiple Hubs: ask once which displayed Hub to use; pass its exact `--hub <id>`
  on local commands. Never choose based on a repo path or silently change grants.
- No Hub: perform initial setup below.

## “Use C2C for this repo”

With one healthy Hub:

1. Run `c2c status --json` and, if needed, `c2c doctor --no-fix --json`.
2. Run `c2c workspace add <current-repo> --json`, using the chosen Hub selector
   only if multiple Hubs exist. This changes grants without restarting or
   touching OAuth, tunnel or connector state.
3. Select the same connector in ChatGPT. Verify the known registration ID with
   `workspace_info(workspace="<workspaceId>")`; require that exact ID. Never use
   `list_workspaces()` to decide which repository a task should read.
4. Complete [permission verification](#verification-and-binding), then follow
   [Project membership](projects.md) when requested. Report
   **MCP READY** and stop. Reuse the healthy Hub's tunnel, OAuth grant and connector;
   incomplete grants require explicit reauthorization.

A stopped/disconnected Hub is an existing connection, not a fresh setup. An
explicit request to reconnect authorizes `c2c start --tunnel`; preserve its saved
names and binding. Unknown runtime state is a blocker, not permission to spawn.

## Initial setup

1. Resolve each name from explicit values, saved settings, human-readable repo/
   domain suggestions, then defaults. Group genuinely missing naming choices
   into one question: Hub display name, tunnel name, hostname and connector name.
   Never ask the user to name internal Hub IDs, hashes, ports or token IDs.
2. Use the existing OS state directory and prerequisites. Run `c2c sandbox-allow
   --json` when required. Escalate a concrete permission failure once.
3. Run `c2c setup -w <current-repo> --hub-name "<display>" --connector-name
   "<connector>" --tunnel-name "<tunnel>" --zone "<domain>" --hostname "<host>"
   --json` for a Named Tunnel. Omit Named options for Quick. `--no-tunnel` is
   local development, not a working public ChatGPT connection.
4. Setup creates an independent Hub and registers the repo. Reuse returned
   names/URL exactly. Follow normal Cloudflare login when needed; stop for human
   authentication, required credentials, consent or a real ownership conflict.
5. Reuse a matching ChatGPT connector. Create only for a genuinely new connection,
   using returned name/URL, OAuth, and description `Read-only access to the
   registered local repositories.` Reuse the task's single in-app browser tab.
6. Request the complete advertised scope bundle for every new connection or
   reauthorization: `workspace.read workspace.search git.read audit.submit offline_access`.
   The server also presents this bundle for omitted/subset requests. Before
   approval, verify all five permissions are visible, including audit submission
   and staying connected. Missing permissions block setup; never edit the OAuth
   URL or token state to add them. When the form is ready, use `c2c pair --json`
   and type the one-time code. Never unpair/revoke as a discovery workaround.
7. Verify actual MCP results and bind the connector below. Then follow
   [Project binding](projects.md) for the registered workspace.
   End at **MCP READY**.

## Verification and binding

Inspect the exact connector ID, name and Server URL. A title or local health
check is not binding evidence. Select the connector in a normal ChatGPT chat.
Verify `workspace_info`, a small `read_file`, `search_workspace` and `git_status`
with the explicit registered workspace ID, without supplying repository contents.
Setup, reconnect and reauthorization require these repository reads and visible
five-scope consent before **MCP READY**. Callback permission is established by a
real automatic handoff's register → send → callback, independently of setup.
Repository reads and local health do not prove `audit.submit` acceptance. Do not
register a separate verification attempt or submit a fabricated audit result.
Refresh preserves old grants; restricted connections need explicit reauthorization
with the five visible permissions. Do not silently upgrade or start callback-only
consent. If ChatGPT rejects a full grant after requesting fewer scopes, report
the observed incompatibility and stop without a workaround.

For a stale catalog, use the existing connector's **Manage → Refresh tools**,
then verify in a new ordinary chat. Do not recreate a working connector just to
refresh tools. A browser/login failure leaves the binding unchanged.

Only after settings and actual MCP evidence match, acknowledge:

```bash
c2c connector bind --name "<observed-name>" --mcp-url "<observed-url>" --connector-id "<observed-id>" --verified-workspace "<observed-workspace-id>" --json
```

The workspace must currently be registered to that Hub. Rebinding is unnecessary
when adding a repo to an already verified unchanged connector. Require healthy
`doctor`, no pending resource rollback and no unresolved connector repair before
reporting readiness. If verification fails, report the concrete blocker.

## Lifecycle and explicit updates

- `c2c start --tunnel`, `status --json`, `restart --tunnel`, `stop`, `pair --json`,
  `unpair`, `disconnect --json`, `logs`: target the selected Hub without any repo
  root requirement. `stop` retains credentials; `disconnect` revokes/stops access
  while retaining grants, connector, DNS, tunnel and configuration.
- `c2c doctor --no-fix --json` diagnoses; repairing doctor runs only when repair
  is intended. It respects intentional disconnect. Fix local failures before
  connector reconciliation; never modify an unrelated connector.
- Named Tunnel UUID/name/hostname remain fixed unless the user explicitly asks
  for a supported change. Pending rollback blocks switching/replacement.
- Explicit update only: `c2c update --json`, frozen dependency install, build,
  reinstall the complete Skill directory, then restart/verify active Hubs.
  Never auto-stash/reset, bypass an origin conflict, or reconnect a disconnected
  Hub during update.
- See [rare recovery](operations.md). Experimental destroy is isolated
  in [deprovisioning](deprovision.md); setup/doctor/reconnect must not
  invoke it as repair.
