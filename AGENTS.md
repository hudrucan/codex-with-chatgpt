# AGENTS.md

## Communication

- Reply to the user in Vietnamese.
- Keep responses concise, technical, and focused on the current task unless more detail is requested.
- Report only work and results that were actually verified. Never invent progress, test results, commits, tool output, or external state.

## Language

- Write new or modified product code, comments, tests, documentation, and user-facing product text in English.
- If Chinese text is encountered in files being edited, refactor or translate the touched Chinese text into clear English.
- Do not introduce new Chinese text.

## Working style

- Make the smallest deterministic change that fully solves the requested task.
- Preserve unrelated user changes. Never revert, reset, overwrite, or silently discard existing work.
- Prefer explicit state and fail-closed behavior over heuristics, hidden mutable state, random naming, or suffix-based conflict avoidance.
- Stop on real ownership, naming, or resource conflicts instead of adopting or replacing unverified resources.
- Do not perform destructive cleanup, deprovisioning, source updates, remote resource deletion, or other irreversible actions unless explicitly requested.
- Keep behavior changes, pure refactors, and documentation-only cleanup in separate commits when practical.
- For pure moves or structural refactors, do not change runtime behavior at the same time.

## Repository conventions

- Use Node.js >= 20 and pnpm/Corepack as defined by `package.json`.
- Keep source organized by feature under `src/`.
- Keep tests organized by feature, roughly mirroring `src/`; use `tests/integration/` for genuinely cross-feature end-to-end coverage.
- Avoid growing a flat `tests/` directory with long repeated filename prefixes.
- Preserve existing public compatibility unless the task explicitly changes it.
- Do not add dependencies unless they are necessary for the requested change.
- Keep local state and generated runtime data outside repositories.

## Documentation

- Documentation describes the current supported product, not implementation history or phase-by-phase development decisions.
- Keep `README.md` short: product purpose, install, quick setup, main commands/capabilities, and links to focused docs.
- Move substantial feature details into focused files under `docs/`.
- Do not use README or docs as a changelog, engineering diary, migration log, or decision log; git history and commit messages serve that purpose.
- Remove obsolete historical explanations instead of accumulating them.
- Avoid labels such as `phase 1`, `phase 2`, or descriptions of temporary implementation stages in user-facing docs.
- Avoid duplicating the same detailed explanation across README, docs, and the Skill. Keep one authoritative place and link to it when useful.
- Keep docs limited to meaningful product areas such as architecture, security, lifecycle, multi-repo behavior, and troubleshooting.
- Keep normal setup/reconnect guidance concise. Experimental or rare destructive flows should remain isolated in dedicated references rather than bloating the main Skill or README.

## Desk C2C Hub invariants

- Remote MCP remains read-only unless a task explicitly changes that product boundary.
- Do not add shell execution, package installation, git commit, arbitrary filesystem write, or similar privileged tools to the remote MCP surface by default.
- Multi-repo access is based on explicit local registrations of canonical roots.
- Workspace selection must remain stateless per MCP call. Never introduce mutable global, session-wide, or current/open-workspace selection.
- When multiple workspaces are available, tools resolve an explicit registered alias or workspace ID on each call.
- Never accept an arbitrary remote path as a workspace selector.
- Keep workspace registries scoped to their owning bridge/hub identity; never silently widen one connection's grants to another owner.
- Preserve canonical path containment, sensitive-file filtering, ignore rules, and git filtering for every registered workspace.
- Keep `workspaceId` root-derived and deterministic; display names and aliases are labels, not authorization identities.
- Keep secrets, OAuth material, Cloudflare credentials, runtime admin tokens, and machine-local state outside repositories.
- Do not create or edit `.c2c.json` merely for local naming.

## Resource lifecycle

- Reuse verified owned resources; do not create suffixed duplicates to bypass conflicts.
- Keep connector, tunnel, DNS, and persisted-state ownership checks fail-closed.
- A failed or partial destructive operation must retain enough state to recover safely.
- `disconnect` revokes/stops access while retaining reusable resources, registrations, and configuration.
- Successful destroy may remove only resources and state proven to belong to the targeted owner.
- Experimental deprovisioning remains isolated from the normal setup, reconnect, doctor, and repair paths unless explicitly requested.
- Do not treat a local health check as proof of a ChatGPT-side connector binding; binding requires actual verified MCP evidence.

## Skill behavior

- Keep the main Skill focused on stable setup, verification, reconnect, doctor/repair, and disconnect flows.
- Keep rare or experimental operations in focused references.
- Successful setup or reconnect ends at `MCP READY`, then stops; do not start an automatic planning/review/coding loop.
- Do not create ChatGPT Projects, persistent chat pointers, or session/checkpoint orchestration unless explicitly requested.
- Ask the user only for genuinely required grouped naming choices, human authentication, credentials/permissions, or real conflicts.

## Verification

- Prefer focused tests for changed files/features; do not rerun the full suite after each small sub-step.
- Run full `corepack pnpm test` once near phase completion or before commit, unless broader coverage is specifically needed; honor explicit verification scope.
- Run `typecheck`/`build` when relevant module/build boundaries change or during final phase verification.
- Use `git diff --check` as the cheap default check. Do not repeat passing expensive checks without a concrete reason.

- Report what passed, what was not run, and any remaining blocker.
- Keep handoffs concise: changed files, behavior/invariants affected, compatibility notes, and verified results.
