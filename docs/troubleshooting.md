# Troubleshooting

For an existing setup, start with:

```
c2c doctor
```

It checks Node, workspace, bridge, MCP, OAuth and tunnel — and repairs what it
can (restarts the bridge, restarts the tunnel) without asking.

For a new setup, resolve names before provisioning or running a repairing
doctor. Use `c2c doctor --no-fix` when only diagnosis is needed.

## Setup names

The [Skill](../skill/SKILL.md#setup-names-and-connection-choice-before-provisioning)
resolves names using explicit user values, then persisted configuration, then
human-readable project suggestions, and finally fallback defaults. Existing
setups keep their saved names without another prompt unless a real conflict
needs resolution. A stopped bridge or expired temporary URL is still an
existing setup.

For a new setup with names still unspecified, Codex presents one grouped
choice before provisioning. For example, if you supplied the domain
`example.com`:

```text
Suggested setup:
- Workspace / Project: desk-c2c-hub
- Tunnel: desk-c2c
- Hostname: code.example.com
- Connector: Desk C2C Hub

Accept the suggestions, or tell me which names to customize.
```

Values you already supplied stay fixed. Without a known domain, the hostname
suggestion is a temporary address, with the option to supply your Cloudflare
domain in the same reply. Quick Tunnel names and hostnames are not user-chosen.
After this decision, Codex completes setup and verifies file reads automatically,
pausing only for authentication, credentials, required permission, or a real
conflict/blocker. An explicitly chosen manual setup preference is preserved.

Setup accepts all four names through existing configuration/state mechanisms:

```bash
c2c setup -w <workspace> --workspace-name "desk-c2c-hub" --tunnel-name "desk-c2c" --zone "example.com" --hostname "code.example.com" --connector-name "Desk C2C Hub" --json
```

Use your actual domain. Omit named-tunnel options for a temporary connection.
`tunnel choose --mode named` also accepts `--tunnel-name` and `--hostname`.

- Workspace display name: `--workspace-name` writes external C2C state at
  `workspaces/<workspaceId>.json` (`displayName`, `workspaceRoot`, `workspaceId`).
  It never creates/modifies `.c2c.json` just for naming. The external override
  wins over an existing `.c2c.json` `name`; without an override, legacy `name`
  and other project configuration remain readable.
  The canonical root still determines `workspaceId`; names do not key auth or
  runtime files. A running bridge does not reload the display name: setup/start
  report `WORKSPACE_NAME_RESTART_REQUIRED`, and status/doctor expose
  `workspaceNameRestartRequired`. Run `c2c restart -w <workspace> --tunnel --json`,
  then rerun setup. Tokens remain valid; a Quick Tunnel may get a new address.
- Tunnel resource name: explicit `--tunnel-name`, then saved `tunnelName`, then
  legacy `c2c-<workspaceId>`. An existing resource must match the saved tunnel
  name and ID to be reused; otherwise setup reports `TUNNEL_NAMING_CONFLICT`
  and leaves state intact. DNS conflicts also fail explicitly, without a new
  generated name or silent temporary-address fallback.
- Hostname: explicit `--hostname`, then saved `hostname`, then the existing
  generated default. A setup rerun or repair does not derive a new hostname
  merely because the display name changed.
- Connector display name: `--connector-name` saves `desiredConnectorName`,
  including local-only setup. `connectorName`, `boundMcpUrl`, and `connectorId`
  identify the last verified ChatGPT binding. Setup/doctor/restart preserve it
  until the Skill verifies the desired plugin's settings and workspace_info,
  then runs `c2c connector bind`. `doctor` keeps reporting pending reconciliation
  across reruns instead of forgetting it after one local repair.

Rename rollback, scoped Cloudflare API credentials, ownership checks and
`disconnect` versus `destroy` are covered in [lifecycle and recovery](lifecycle.md).

No naming flags are needed on rerun. Legacy installations keep their current
defaults; no configuration migration or multi-workspace support is introduced.
The Skill still controls suggestions, the grouped decision, ChatGPT Project
titles, and browser creation/reconciliation of the actual connector.

## Common situations

### Bridge is not running
`c2c start` (or let doctor do it). Bridge logs:
`c2c logs`, or verbose: `c2c logs --verbose`.

If doctor says the bridge state is **uncertain**, do not start a
second bridge and do not Delete the ChatGPT connector. Wait and run doctor
again. The local process may still be running.

### Codex Web GPT launcher or model catalog is missing

This repository installs the Codex Skill and the C2C Bridge. It does **not**
ship the separate `Codex Web GPT` desktop launcher or the native Codex model
catalog UI. If that launcher says **Install into Codex** is
incomplete, separate route installation from catalog verification:

- The launcher can successfully write its local `openai_base_url` route while
  the existing Codex process is still using the old configuration.
- Fully quit Codex, including its background/tray `ChatGPT.exe` process on
  Microsoft Store Windows installations, then reopen it. Closing only the
  window is not a restart. Keep the launcher open while it verifies the
  catalog.
- Repeating the install step does not reload an already-running Codex process.
  It only writes the same route again and can reset the pending verification
  state.

For the C2C repository itself, verify the checkout and installed Skill path,
rebuild with `corepack pnpm install && corepack pnpm build`, then run:

```
c2c doctor --json -w <workspace>
c2c status --json -w <workspace>
```

If those checks are healthy but the separate Web GPT launcher or model picker
still fails, capture the OS, Codex version, launcher version, exact UI error,
and timestamp for the launcher issue. Do not change tunnel settings or delete
the saved route as a workaround: the launcher owns its route backup and is
expected to restore it when its Bridge is turned off.

### Everything was quit and ChatGPT can no longer connect
Quitting Codex / the terminal stops the public address. The next `c2c doctor`
starts a new address and sets `chatgptRepair.needed`. The Skill should tell the
user that the old address expired, then **Delete** THIS workspace's
connector (`chatgptRepair.connectorName`) and create it again with the new
address (never click Reconnect — the old URL is dead). Other workspaces keep
their own connectors so two projects can stay connected at once.

Mint the pairing code only when the ChatGPT Authorize form is on screen
(`c2c pair`). After the connector is recreated, doctor being green is not
enough: the saved ChatGPT conversation must pass `workspace_info` again. If
that old chat still cannot read the workspace, open a new chat in the same
Project (or switch long-chat) and continue there.

Fixed ChatGPT pages for first-time setup and later repair (do not hunt the UI):

- Developer mode: https://chatgpt.com/#settings/Security
- Plugins hub (manage existing connectors): https://chatgpt.com/plugins
- Add a connector:
  https://chatgpt.com/plugins#settings/Connectors?create-connector=true&redirectAfter=%2Fplugins

### Tunnel URL unreachable / ChatGPT says the connector is broken
Same as above: `c2c doctor`, then Delete + recreate THIS workspace's
connector if `chatgptRepair.needed`. Mint a pairing code with `c2c pair` only
when the Authorize form is on screen.
If this workspace uses a stable hostname, doctor sets `namedRepair` instead —
re-login to Cloudflare (`c2c tunnel login`) and doctor again. Do not Delete
the connector; the address did not change.

### I have a Cloudflare domain and want a stable hostname
Include your Cloudflare domain and any preferred hostname in the setup
request or the single grouped naming reply. Codex preserves the chosen
hostname with `--hostname` and opens Cloudflare login when needed. Existing
setups retain their saved hostname without another naming prompt. To switch
later, tell Codex the desired domain/hostname; it resolves any conflict with
the existing address before provisioning. A required fixed address is not
silently replaced with a temporary one if provisioning fails.

### Pairing code is invalid or expired
Pairing codes are one-time and expire after ~5 minutes. Generate one only
when the ChatGPT Authorize page is ready:

```
c2c pair
```

Older codes become invalid immediately. Do not mint a code during `c2c doctor`.

### Temporary address keeps dropping on a UDP-filtered network
cloudflared defaults to QUIC. If the tunnel reconnects over and over on a
corporate network, set `C2C_TUNNEL_PROTOCOL=http2` and restart the bridge.
Leave it unset to keep cloudflared's default.

### ChatGPT gets 401 on every tool call
The access token expired and refresh failed (e.g. after `c2c unpair` or a
long offline period). Delete THIS workspace's connector if the address also
changed; otherwise run Authorize again in ChatGPT and enter a fresh pairing
code. Never use Reconnect when the public address has been replaced.

### cloudflared is not installed
macOS: `brew install cloudflared`
Windows: `winget install Cloudflare.cloudflared`
Linux: see Cloudflare's package instructions.
The Skill installs this automatically during setup.
If cloudflared is installed in a custom location that is not on `PATH`, set
`C2C_CLOUDFLARED_PATH` to the executable's absolute path before running `c2c`.

### Every new Codex chat “repairs” the connection / cannot write logs
The C2C state directory lives outside the project (macOS:
`~/Library/Application Support/codex-with-chatgpt`; Windows:
`%LOCALAPPDATA%\codex-with-chatgpt`). Codex's default sandbox cannot write
there, so each new chat looks like a health-check failure.

`c2c setup`, `c2c doctor` and `c2c sandbox-allow` add that directory to
`[sandbox_workspace_write].writable_roots` in `<codex-home>/config.toml`, where
`<codex-home>` is a non-empty `CODEX_HOME` when set, otherwise `~/.codex`
(`%USERPROFILE%\.codex` on Windows). After that, later chats do not need
elevation.

### Port already in use
Handled automatically: an existing healthy bridge for the same workspace is
reused; anything else makes the bridge pick a free port. Configuration follows
automatically.

### Fixed hostname is configured, but the Named Tunnel does not start on Windows
`cert.pem` and the Named Tunnel credential are different files. `cert.pem`
proves that `cloudflared` has an account certificate; the tunnel still needs
`%USERPROFILE%\.cloudflared\<TUNNEL-UUID>.json` (or the file selected by
`TUNNEL_CRED_FILE`) to run. `c2c doctor --json` reports whether the certificate
is missing, the credential is missing or unreadable, the JSON is invalid, or
the saved Tunnel ID does not match. It never prints credential contents or
repairs the file automatically.

When the diagnostic says the credential is missing, recover the credential for
the existing Tunnel with `cloudflared tunnel token --cred-file` and then run
`c2c doctor` again. Do not paste the generated credential into ChatGPT or a
project file.

### Reading a file returns ACCESS_DENIED_SENSITIVE_FILE
Working as intended: `.env`, keys, credentials and anything matched by
`.c2cignore` are never readable through ChatGPT. `.env.example` is allowed.

### I cannot see Projects in the ChatGPT sidebar
Codex can hover **Chats**, click the … that appears, and choose
**Organize by project** in the in-app browser. It creates the Project with the
resolved display name and **project-only memory**, then saves the collection
URL (`https://chatgpt.com/g/g-p-…/project`). In explicitly chosen manual setup,
follow those steps and tell Codex when the collection page is open.

### This workspace opened the wrong ChatGPT Project
Do not pick another project by name automatically. Open the collection that
matches this workspace and tell Codex "found it", or say you want the old
long-chat instead. Each workspace has its own Project and its own connector.

### Completely stuck
```
c2c stop
c2c setup
```

re-creates the bridge, tunnel and pairing session from scratch. Existing
authorizations stay valid unless you also ran `c2c unpair`.
