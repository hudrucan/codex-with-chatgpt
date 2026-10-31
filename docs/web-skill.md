# ChatGPT Web Skill

The standalone Web Skill recognizes a first-line `[C2C Handoff]` and uses the
existing C2C MCP connector and explicit Project workspace/Hub routing to audit.
It preserves the receiver's bounded recovery and `submit_audit_result` callback
contract. It adds no connection, MCP registration, app mapping, marketplace,
hook, sender, browser automation or runtime dependency.

## Build and check

With the repository's existing development dependencies installed:

```powershell
corepack pnpm skill:web:pack
corepack pnpm skill:web:check
```

These commands are offline and write only `dist/web-skill/`. The installable
`skill.zip` contains exactly four files:

```text
codex-with-chatgpt/
  SKILL.md
  agents/openai.yaml
  references/workflow.md
  references/workflow-web.md
```

The output directory also contains the expanded files, `provenance.json` and
`SHA256SUMS`. These verification sidecars stay outside the installable ZIP.
Provenance records the single package version, Git HEAD, exact source input and
payload hashes, transformation and archive hash. Modified inputs are represented
by their actual hashes; HEAD does not imply an uncommitted input was released.

`web-skill/` contains only the concise Web entrypoint and discovery metadata.
Workflow rules come from canonical `skill/references/`: `workflow-web.md` is
copied verbatim. In `workflow.md`, only links to the excluded Local sender are
flattened to text marked `Codex Local only`; all other text remains unchanged.
The projection is recorded in provenance. No manually edited workflow snapshot
is maintained, and the Local Skill source is unchanged.

The builder validates relative references, metadata, version, prohibited local
paths/connection identities and source stability. ZIP entries are sorted with
fixed timestamps. Stale output, missing source, changed checksums, path aliases
and invalid references fail closed. To check reproducibility, call the exported
`packageWebSkill` function with another explicit absolute output directory, then
compare archive hashes. Preserve older generated output outside the output
directory before regenerating after a source/revision change.

## Web installation and rollback

Installation is a separate authorized phase after audit. In the intended
ChatGPT workspace, open Plugins > Skills and use its Skill creation/upload
control, such as Create > Upload from your computer, if available. Upload
`dist/web-skill/skill.zip`, then verify the displayed identity and test in a
fresh Web chat. Upload support and permissions depend on the account/workspace;
do not assume a visible plugin-upload control also accepts standalone Skills.
See [Skills and plugins](https://learn.chatgpt.com/docs/skills-and-plugins).

The existing C2C connector must be available in that chat, with Project routing
for the intended Hub and registered workspace. Verify the connector/workspace
pair through `workspace_info`. The ZIP contains no connector ID or credentials
and grants no new access. Stop if installation asks to create another MCP
connection or change authentication. If Skill upload is unavailable, keep the
artifact and ask the workspace administrator for a supported route.

Keep Lazier Web and its bundled receiver unchanged during preparation and
validation. Automatic discovery metadata expresses eligibility, not proof of
host selection. A later cutover must verify this standalone Skill handles a
fresh handoff through the existing MCP and produces accepted callback plus
matching terminal receipt before removing Lazier's receiver.

To roll back an authorized installation, disable/remove only this newly uploaded
Skill using the host's controls, then verify the existing Lazier receiver and
connector in a fresh chat. Leave the Local plugin, shared marketplace, Hub,
OAuth, tunnel and registry intact. Do not disconnect the existing MCP app when
removing the Skill.
