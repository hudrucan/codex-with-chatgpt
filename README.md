# Desk C2C Hub

> ChatGPT thinks. Codex works.

This is [hudrucan/desk-c2c-hub](https://github.com/hudrucan/desk-c2c-hub), a fork of
[XiaoDuoYa/codex-with-chatgpt](https://github.com/XiaoDuoYa/codex-with-chatgpt).
Upstream attribution and the [MIT license](LICENSE) are retained. The `c2c`
command, package identity and installed Skill directory remain compatible.

## The problem

ChatGPT Plus/Pro web quota sits idle while your coding agent burns
scarce API/Codex tokens on planning and review. This project moves the
thinking to the subscription you already pay for; Codex only executes.
No OpenAI API keys, no reverse proxy — official web UI plus a read-only MCP bridge.

## What it is

Use the ChatGPT web app as the planning and review brain for your
Codex coding sessions, while Codex keeps full ownership of execution. Your
repository is never uploaded: ChatGPT reads exactly the lines it needs through
a secure, OAuth-protected, **read-only** MCP connection to your current
workspace.

## One-paste install

Copy this request to Codex:

```text
Please install and configure "Desk C2C Hub" for me, fully automatically.
I am a non-technical user — do everything yourself:

1. Check the environment: git and Node.js >= 20 must be available. Install
   anything missing yourself (macOS: Homebrew, Windows: winget). Also install
   cloudflared.
2. Download: clone https://github.com/hudrucan/desk-c2c-hub into
   ~/desk-c2c-hub. Reuse an existing fork checkout without pulling automatically.
   Update only when I ask, after verifying origin is hudrucan/desk-c2c-hub.
3. Build: inside that folder run `corepack pnpm install --frozen-lockfile` then `corepack pnpm build`.
4. Install the Skill: determine the Codex home first: use a non-empty CODEX_HOME
   when set, otherwise use ~/.codex (%USERPROFILE%\.codex on Windows). Copy
   skill/SKILL.md to <codex-home>/skills/codex-with-chatgpt/SKILL.md, and update
   the line "The codex-with-chatgpt checkout lives at:" to the actual clone path.
5. First-time setup: follow the SKILL.md "first-time setup" workflow
   (run c2c setup, configure the ChatGPT connector in the BUILT-IN browser,
   enter the pairing code). Never open a third-party browser.
6. Only interrupt me for logins (ChatGPT / Cloudflare), CAPTCHAs or 2FA —
   and give me exactly ONE action at a time.
7. When done, show me the ✓ checklist and confirm the file-read test passed.
   I don't know what MCP, OAuth, tunnels or ports are. Don't explain them.
   If anything breaks, fix it yourself first.
```

**Updates:** Only on explicit user request. The Skill does not check daily or
update itself automatically. `c2c update` verifies the resolved `origin` is this
fork and refuses a dirty checkout before pulling with `--ff-only`. It never
stashes or pulls upstream automatically. Then build and reinstall the Skill.

## Install → Setup → Use (manual)

Let `<codex-home>` be a non-empty `CODEX_HOME` when set; otherwise use `~/.codex`
(`%USERPROFILE%\.codex` on Windows).

1. Install the Codex Skill: copy `skill/` to `<codex-home>/skills/codex-with-chatgpt/`.
2. Tell Codex: **"Set up Codex with ChatGPT."**
3. Use Codex normally: **"Use Codex with ChatGPT to implement XXX."**

That's the whole manual. You don't need to know what MCP, OAuth, tunnels,
ports or localhost are — Codex configures everything automatically and you
just see:

```
Codex with ChatGPT

✓ Project detected
✓ Workspace Bridge started
✓ Secure connection established
✓ ChatGPT connected
✓ File read test passed

Ready.
```

Setup first resolves workspace/tunnel/hostname/connector names in one grouped
choice, reusing explicit or saved values. Human login, credentials or explicit
permission may still be required. A **new** workspace also asks
you to create a ChatGPT Project (collection) once — pick **project-only
memory**, name it after the workspace. If the sidebar has no Projects row,
hover **Chats**, open the … menu, and choose **Organize by project**. Codex
then saves that collection link and starts chats from that page. Existing
workspaces that already have a C2C chat stay on the old one-conversation
style until you ask to switch.

### Optional stable hostname

The default public address is a temporary Cloudflare URL. It changes when the
bridge restarts, and Codex repairs ChatGPT by deleting that workspace's
connector and adding it again.

For a domain already on Cloudflare, setup can use an explicitly selected
Named Tunnel and hostname. Persisted resource names and the tunnel UUID are
reused across reruns. Explicit naming conflicts fail without silently falling
back to a different name or temporary address. A temporary Quick Tunnel is also
available when selected; its address may change on restart.

C2C state stays outside the project. Cloudflare account credentials retain
cloudflared's own credential location.

### Local naming and resource lifecycle

Setup saves local workspace display names in external C2C state, keyed by the
canonical-root workspace ID. It does not create `.c2c.json` for naming; existing
project configuration stays readable. Tunnel UUIDs and OAuth identities remain
stable through name changes. Connector desired names become bound only after
ChatGPT-side verification.

`c2c disconnect` revokes access and stops the bridge while retaining resources.
`c2c destroy` plans deprovisioning; execution requires verified connector-removal
receipts and matching Cloudflare ownership. See [lifecycle and recovery](docs/lifecycle.md).

## How it works

```
             ┌───────────────────────────┐
             │       ChatGPT Web         │
             │  Reason / Plan / Review   │
             └──────────┬──────────▲─────┘
                        │          │
               MCP      │          │ Computer Use
            Data Plane  │          │ Control Plane (<1 KB messages)
                        ▼          │
             ┌─────────────────────┐
             │      C2C Bridge     │   loopback-only HTTP server
             │  read-only MCP      │   OAuth 2.1 + one-time pairing code
             │  OAuth + Pairing    │   Cloudflare Quick Tunnel
             │  Tunnel Manager     │
             └──────────┬──────────┘
                        │  read-only
                        ▼
             ┌─────────────────────┐          ┌─────────────────────┐
             │   Local Workspace   │◀─────────│    Codex Harness    │
             └─────────────────────┘ edit/git │ shell / tests / fix │
                                              └─────────────────────┘
```

- **Control plane (Computer Use)**: Codex and ChatGPT exchange tiny structured
  `[C2C]` state messages — `INIT → PLAN → EXECUTED → REVIEW → DONE`. No diffs,
  no logs, no file bodies are ever pasted.
- **Data plane (MCP)**: ChatGPT pulls what it needs itself through 10 read-only
  tools: `workspace_info`, `list_directory`, `read_file`, `search_workspace`,
  `git_status`, `git_diff`, `test_status`, `execution_summary`,
  `execution_output`, `read_image`.
- **Independent review**: after Codex executes, ChatGPT inspects the actual
  git diff and test records through MCP — it never trusts "all tests passed"
  claims blindly.

### Generated media handoff

The connector remains read-only: `read_image` can inspect supported workspace
images but cannot write files. After a requested image or video is downloaded
through the visible ChatGPT UI, the local executor can validate and import the
original with `c2c asset import -w <workspace> --from <download> --to <new-path>`.
Imports are workspace-contained, signature-checked, size-limited, reject active
SVG content, and never overwrite an existing file.

## Security model (short version)

- **Read-only by construction**: write/delete/shell/commit tools simply do not
  exist on the server. No prompt injection can enable them.
- **One workspace = one boundary**: every token is bound to a single workspace;
  path containment uses canonical realpaths (symlink/`../`/absolute-path escapes
  are all blocked and tested).
- **Sensitive files never leave**: `.env*`, keys, SSH, credentials are denied by
  default (`.env.example` allowed); `.c2cignore` adds your own rules.
- **Knowing the URL grants nothing**: the public MCP endpoint requires OAuth 2.1
  (PKCE S256, dynamic client registration, rotating refresh tokens). Without a
  token: 401. Wrong workspace: 403.
- **The model never sees long-lived credentials**: the only secret that ever
  touches a browser is a one-time pairing code (5-minute TTL, 5 attempts,
  rate-limited, destroyed on use).

Full threat model: [docs/security.md](docs/security.md)

## For developers

```bash
pnpm install --frozen-lockfile
pnpm build          # -> dist/, exposes the `c2c` bin
pnpm test           # path security, OAuth, pairing, MCP and lifecycle tests

c2c setup           # bridge + tunnel + pairing code, all in one
c2c sandbox-allow   # whitelist the settings dir in Codex (macOS + Windows)
c2c status / doctor / pair / unpair / logs / stop
c2c disconnect      # revoke/stop, retain resources
c2c destroy --json  # inspect the ownership-checked deprovisioning plan
```

Requirements: Node.js >= 20, git. `cloudflared` for the public connection
(auto-detected; the Skill installs it for you). If QUIC is blocked, set
`C2C_TUNNEL_PROTOCOL=http2` and restart the bridge.

Docs: [architecture](docs/architecture.md) · [protocol](docs/protocol.md) ·
[security](docs/security.md) · [troubleshooting](docs/troubleshooting.md)

## Project layout

```
src/
  bridge/     loopback HTTP server, port recovery, admin API
  mcp/        read-only tools, stateless Streamable HTTP
  auth/       OAuth 2.1 (PKCE, DCR, refresh rotation, revocation)
  pairing/    one-time pairing codes (CSPRNG, TTL, rate limits)
  workspace/  path containment, sensitive-file policy, search, git
  tunnel/     TunnelProvider abstraction + Cloudflare Quick/Named Tunnel
  execution/  execution records for the review loop
  process/    bridge daemon management
  lifecycle/  disconnect, verified destroy, workspace operation locks
  cli/        the c2c CLI
skill/        the Codex Skill (the real UX layer)
tests/        unit + integration tests
docs/         architecture / protocol / security / troubleshooting
```

## Disclaimer

**Unofficial community project. Not affiliated with or endorsed by OpenAI.**

## License

[MIT](LICENSE). Original copyright and attribution are preserved.
