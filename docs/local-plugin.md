# Offline Codex Local plugin

For the standalone ChatGPT Web receiver, see [Web Skill](web-skill.md).

The optional prototype distributes the existing canonical `skill/` as one
plugin-managed Skill. It does not install or run a Hub, register MCP, add hooks,
change OAuth, or replace the Web receiver bundled with Lazier. The standalone
Skill remains supported. Runtime installation and plugin installation are separate.

## Build and check

Use the repository's installed, lockfile-pinned development dependencies. Packaging
is offline and does not install packages. Build the repository first, then supply
the existing runtime checkout as an explicit absolute path, including quotes when
it contains spaces:

```powershell
corepack pnpm build
corepack pnpm plugin:pack --runtime-checkout 'C:\Users\Desk Agent\.codex-with-chatgpt'
corepack pnpm plugin:check --runtime-checkout 'C:\Users\Desk Agent\.codex-with-chatgpt'
```

The runtime must have matching source, package version, compiled JavaScript and
C2C bundles. Packaging checks these without writing to the runtime. Source files
and built helpers are compared by SHA-256; JavaScript and helper bundles are rebuilt
in memory. Different Git revisions are allowed when the checked runtime source and
artifacts match. A missing file, changed source, stale artifact, symlink/junction,
relative/traversing path, invalid Skill reference or unexpected Skill file stops
packaging. The package derives version `0.4.0` from `package.json` and checks
the existing runtime version constant against it.

The command writes only `dist/plugin-marketplace/`:

```text
.agents/plugins/marketplace.json
codex-with-chatgpt/
  .codex-plugin/plugin.json
  LICENSE
  provenance.json
  skills/codex-with-chatgpt/
    SKILL.md
    agents/openai.yaml
    references/*.md
codex-with-chatgpt-0.4.0.zip
SHA256SUMS
```

The ZIP contains the marketplace and plugin tree, without the ZIP itself or
`SHA256SUMS`. Entries are sorted and stored with fixed timestamps. The manifest
declares only `skills: "./skills/"`. Exactly one `SKILL.md` is packaged; its sole
checkout placeholder is replaced with the canonical runtime path, using forward
slashes on Windows. References are copied verbatim. CLI and sender instructions
continue using that external runtime's `bin/c2c.js` and `dist/c2c/*.mjs`.

`provenance.json` records full source/runtime Git revisions, SHA-256 hashes of
packaging inputs, runtime artifacts and plugin files. Input hashes describe the
actual working tree, including uncommitted changes; the Git revision alone is not
a claim of a clean checkout. `SHA256SUMS` covers every distribution file except
itself. Check mode regenerates expected bytes from the source and runtime and
compares the complete tree, archive, provenance and checksums. It rejects extra
files and never repairs or overwrites a stale distribution. Identical repeated
builds are read-only and return the same ZIP hash. After intentional source
changes, run the normal repository build, which clears `dist/`, then package again.
Keep the reported archive hash outside the package when transferring it; these
checks provide integrity and source comparison, not publisher signatures.

Only the explicit Skill allowlist, license, generated manifests and provenance
enter the archive. Runtime/state files, credentials, `.git`, `node_modules` and
unrelated build output are excluded. The archive contains the absolute runtime
binding and is therefore specific to that installation. Do not publish it as a
portable package or use the plugin cache as a runtime checkout.

## Check host compatibility without installing

Codex CLI `0.164.0` supports the `.codex-plugin/plugin.json` compatibility manifest
and a local `.agents/plugins/marketplace.json` catalog. Its plugin commands are
`add`, `list`, `remove` and `marketplace {add,list,upgrade,remove}`. This prototype
uses the compatibility manifest rather than requiring the newer portable root
manifest. See [OpenAI's package reference](https://developers.openai.com/plugins/build/plugins).

Use a process-only config override to ask the installed host to read the catalog:

```powershell
codex -c 'marketplaces.hudrucan={source_type="local",source="D:/repos/codex-with-chatgpt/dist/plugin-marketplace"}' plugin list --marketplace hudrucan --available --json
```

Expect one available `codex-with-chatgpt@hudrucan`, version `0.4.0`,
`installed: false`, `enabled: false`. This validates host catalog/manifest parsing;
it does not prove installed Skill activation. No user configuration is persisted.
The distribution's nested catalog is outside normal repository discovery.

The `hudrucan` publisher marketplace can contain multiple plugins, including
`codex-context-mode@hudrucan`. Each marketplace ID resolves to one catalog root.
When that ID is already configured, preserve its verified entries in a shared
catalog outside repositories before adding C2C; do not replace the existing
catalog with the C2C-only generated catalog. Keep every local source inside the
shared root and verify copied distributions against their original sources.

## Later installation and rollback

Installation/cutover requires a separately authorized phase. Before installing,
verify the package against its source and inspect user/repo discovery roots,
legacy `<codex-home>/skills/`, plugin caches and any bootstrap instructions.
Activating the plugin while the standalone C2C Skill remains discoverable creates
duplicate entrypoints. Preserve the existing complete standalone Skill and its
absolute checkout binding outside discovery before enabling the replacement.
Keep exactly one active C2C Skill and verify it in a fresh session.

For an authorized installation, register the extracted marketplace root with
`codex plugin marketplace add <absolute-marketplace-root>`, then use
`codex plugin add codex-with-chatgpt@hudrucan`. Do not overwrite a
conflicting marketplace identity or install a second copy with a suffix. Validate
the installed cache against the generated plugin tree and perform an explicitly
authorized E2E with callback acceptance and matching terminal receipt.

For an authorized rollback, remove only the verified prototype installation via
`codex plugin remove codex-with-chatgpt@hudrucan`, restore the preserved
standalone Skill to its original discovery location, and check a fresh session.
Do not remove the shared runtime checkout or restart/deprovision the Hub, tunnel,
Scheduled Task, registry or OAuth. Keep Lazier's Web receiver until a separate
successful Web cutover. Packaging or host listing success alone does not authorize
production migration.
