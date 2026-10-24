# Codex with ChatGPT

A secure read-only MCP bridge from ChatGPT to explicitly registered local repos.
Codex manages setup and connection lifecycle; ChatGPT reads repo content through
MCP. Each connection resolves a stable local Hub with its own workspace grants.

## Install

Requirements: Node.js >= 22.13 for the pinned pnpm toolchain, git, Corepack, and
cloudflared for a public ChatGPT connection. The bridge runtime supports Node.js >= 20.

```bash
git clone https://github.com/hudrucan/codex-with-chatgpt.git
cd codex-with-chatgpt
corepack pnpm install --frozen-lockfile
corepack pnpm build
```

Copy the whole `skill/` directory, including `references/`, into
`<codex-home>/skills/codex-with-chatgpt/`. Codex home is a non-empty `CODEX_HOME`,
otherwise `~/.codex` on Unix or `%USERPROFILE%\.codex` on Windows. Replace
`<ACTUAL_CHECKOUT_PATH>` in the installed `SKILL.md` with this checkout's path.
Run `node <checkout>/bin/c2c.js <command>`, or `c2c` when linked.

## Quick setup

Ask Codex: **"Set up Codex with ChatGPT for this repo."** The [Skill](skill/SKILL.md)
resolves names, reuses saved settings, completes ChatGPT authorization and
verifies the actual MCP connection. Successful setup ends at **MCP READY**.

For local setup with a temporary Quick Tunnel:

```bash
node bin/c2c.js setup -w /path/to/repo --json
```

The Skill completes the ChatGPT connection after local setup. For a fixed
hostname and naming options, see [lifecycle](docs/lifecycle.md).

## Main commands

| Action | Command |
| --- | --- |
| Start/reuse | `c2c start --tunnel` |
| Status | `c2c status --json` |
| Diagnose/repair | `c2c doctor --json`; add `--no-fix` for diagnosis only |
| Restart | `c2c restart --tunnel` |
| Revoke tokens | `c2c unpair` |
| Stop process | `c2c stop` |
| Disconnect and retain resources | `c2c disconnect --json` |
| Explicit update | `c2c update --json` |

## Multiple repos

```bash
c2c workspace add /path/to/backend --alias backend
c2c workspace list --json
c2c workspace remove backend
```

One configured Hub is selected automatically; multiple Hubs require `--hub <id>`.
MCP calls select a registered alias or ID,
for example `read_file({ "workspace": "backend", "path": "src/index.ts" })`.
See [multi-repo access](docs/multi-repo.md) for selection rules and registry details.
Each Hub connector serves many workspaces. Optional [ChatGPT Projects](docs/multi-repo.md#chatgpt-project-bindings)
can combine many Hubs with separate routing blocks; repos may appear in multiple Projects.

## MCP capabilities

Ten read-only tools provide workspace discovery, project information,
directory listing, text/image reads, search, git status, paginated git diffs,
bounded commit history and commit patches.
OAuth scopes, canonical containment and sensitive-file rules protect access.
An additional `submit_audit_result` tool can complete a locally registered,
short-lived audit inbox with explicit `audit.submit` permission. It cannot write
repo files or run commands. See [security](docs/security.md) and
[the tool reference](docs/multi-repo.md#mcp-tools).

## Documentation

- [Codex ↔ ChatGPT Web workflow](skill/references/workflow.md): manual handoffs, opt-in async callbacks and validation trust.
- [Architecture](docs/architecture.md): components, request flow and development checks.
- [Security](docs/security.md): authorization, file policies and credential storage.
- [Lifecycle](docs/lifecycle.md): setup, naming, binding, reconnect and disconnect.
- [Multi-repo access](docs/multi-repo.md): registrations, selectors and registry format.
- [Troubleshooting](docs/troubleshooting.md): diagnostics and recovery.

Based on [XiaoDuoYa/codex-with-chatgpt](https://github.com/XiaoDuoYa/codex-with-chatgpt).
The upstream [MIT license and copyright](LICENSE) are preserved.

**Unofficial community project. Not affiliated with or endorsed by OpenAI.**
