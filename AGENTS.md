# AGENTS.md

## Communication and language

- Reply in concise, technical Vietnamese focused on the task; add detail when requested. Report only verified work/results, never invented progress, tests, commits, output or external state.
- Write new/modified code, comments, tests, docs and product text in English. Translate touched Chinese text; introduce none.

## Working style

- Make the smallest deterministic change that fully solves the task; preserve unrelated user work without reverting, resetting or overwriting it.
- Prefer explicit state and fail-closed behavior over heuristics, hidden mutable state, random naming or suffixed conflict avoidance. Stop on real ownership, naming or resource conflicts; never adopt/replace unverified resources.
- Destructive cleanup, deprovisioning, source updates, remote deletion and other irreversible actions require an explicit request.
- Keep behavior changes, pure refactors and docs-only cleanup in separate commits when practical. Pure moves/structural refactors preserve runtime behavior.

## Repository conventions

- Use Node.js >= 20 and pnpm/Corepack as defined by `package.json`; add dependencies only when necessary. Preserve public compatibility unless explicitly changed.
- Organize `src/` and corresponding tests by feature; reserve `tests/integration/` for cross-feature end-to-end coverage. Avoid flat tests with repeated long prefixes.
- Keep machine-local state, generated runtime data, secrets, OAuth material, Cloudflare credentials and runtime admin tokens outside repos. Store display names in external workspace state, never repo configuration.

## Documentation

- Describe the current supported product. Keep README short: purpose, install, quick setup, main commands/capabilities and links to focused docs.
- Keep substantial details in one authoritative place under meaningful product areas: architecture, security, lifecycle, multi-repo behavior or troubleshooting. Avoid duplication across README, docs and Skill.
- Remove obsolete explanations; do not turn docs into changelogs, engineering/development diaries, decision logs or temporary phase narratives. Use git history/commit messages for history.
- Keep normal setup/reconnect concise; isolate rare/experimental destructive flows in dedicated references.

## Codex with ChatGPT invariants

- Remote MCP stays read-only unless explicitly changed. Do not add shell execution, package installation, git commit, arbitrary filesystem write or similar privileged tools by default.
- Grant multi-repo access only through explicit local registrations of canonical roots, scoped to the owning bridge/Hub. Never widen one owner's grants to another.
- Resolve an explicit registered alias or workspace ID statelessly on every call; never accept arbitrary remote paths or introduce global/session/current/open-workspace selection.
- Keep `workspaceId` root-derived and deterministic; display names/aliases are labels, never authorization identities. Preserve canonical path containment, sensitive-file filtering, ignore rules and git filtering for every workspace.

## Resource lifecycle

- Reuse verified owned resources without suffixed duplicates. Keep connector, tunnel, DNS and persisted-state ownership checks fail-closed.
- Failed/partial destructive operations retain recovery state; successful destroy removes only resources/state proven owned by the target.
- `disconnect` revokes/stops access while retaining reusable resources, registrations and configuration. Experimental deprovisioning stays outside setup, reconnect, doctor and repair unless explicitly requested.
- Connector binding requires actual verified ChatGPT-side MCP evidence; local health alone proves no binding.

## Skill behavior

- Keep the main Skill focused on stable setup, verification, reconnect, doctor/repair and disconnect; place rare/experimental operations in references.
- Successful setup/reconnect ends at `MCP READY`, then stops without an automatic planning/review/coding loop.
- Optional Project bindings reuse the Hub connector and require visible instructions plus MCP verification. Never persist chat URLs or restore session/checkpoint orchestration.
- Ask only for genuinely required grouped naming choices, human authentication, credentials/permissions or real conflicts.
- This repository's guidance must remain usable without Lazier installed.

## Verification

- Protect public behavior, security/ownership boundaries, persisted-state safety and regressions with the smallest meaningful behavior/invariant tests. Avoid duplicate unit/integration coverage and tests merely for private helpers; use tables for equivalent inputs.
- Prefer focused tests for changed features. Run full `corepack pnpm test` once near completion/before commit unless explicit verification scope says otherwise; do not repeat passing expensive checks without a concrete reason.
- Run typecheck/build for relevant module/build boundary changes or final verification; use `git diff --check` as the cheap default.
- Keep handoffs concise: changed files, affected behavior/invariants, compatibility, verified results, unrun checks and remaining blockers.
