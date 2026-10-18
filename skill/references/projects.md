# ChatGPT Project binding

Use after registering and verifying the workspace on the selected Hub. One Hub
connector serves many workspaces; a workspace may have one optional Project
binding. Projects never get a separate connector. Use visible ChatGPT UI, not
hidden endpoints or title-based adoption.

## Inspect and select

Run `c2c project status --workspace <workspaceId> --json`, with `--hub <id>` only
when needed. `current` means local instruction metadata matches, not that the
Project is accessible or MCP verified. `projectVerification` is always
`not_checked`; the following UI checks are required for readiness.

- `current`: open the exact saved `binding.projectUrl`, inspect its instructions
  and reuse it. Verify the workspace through MCP inside that Project.
- `unbound`: ask once whether to use an existing ChatGPT Project or create one.
  Show accessible choices when possible; confirm the user's exact selection
  through its Project URL. If the user declines an optional Project, finish
  with ordinary MCP verification and leave the workspace unbound.
- `sync_required`: open the exact saved Project and sync the generated
  instructions in place. Do not create a replacement Project.
- `stale`: stop on the reported workspace/connector problem. A removed workspace
  requires explicit re-registration/rebind or local unbind by its stored ID.

Open the Project landing page, not a conversation URL. A valid saved URL has
the shape `https://chatgpt.com/g/g-p-<project-id>-<slug>/project`. Project names
are labels, not identity evidence. A missing, inaccessible or redirected saved
Project is a blocker: report it and require explicit rebind/unbind. Never adopt
another Project by matching its title or silently create a replacement.
A Project's stable `g-p-...` ID may belong to only one Hub/workspace binding,
including across Hubs. `PROJECT_BINDING_CONFLICT` requires explicit unbind of the
previous acknowledgement; never steal or silently reassign that Project.

## Apply and verify

1. Run `c2c project instructions --workspace <workspaceId> --json`. Use exactly
   its `instructions`, `instructionHash`, workspace ID and connector ID/name/URL.
   Unverified or unreconciled Hub connector state blocks this operation.
2. For a new binding or sync, open the selected Project's visible menu/settings
   and Project Instructions editor. Inspect the actual controls before acting.
   Preserve all unrelated user instructions. The exact managed markers are:

   ```text
   --- BEGIN DESK C2C HUB WORKSPACE BINDING ---
   --- END DESK C2C HUB WORKSPACE BINDING ---
   ```

   Replace only the single block from the exact BEGIN marker through its exact
   END marker, inclusively, using the complete generated text. If no block or
   prior C2C binding exists, append it without changing unrelated instructions.
   Multiple, nested, unmatched or otherwise ambiguous C2C blocks, an unmarked
   older C2C binding, or a block for another workspace are blockers: stop for
   explicit resolution instead of rewriting the entire Instructions field.
3. Save and reopen/read the editor to confirm the entire generated block exactly,
   including the workspace ID. The hash covers that block, not unrelated Project
   instructions. Even for a `current` binding, inspect the block: if the UI text
   was changed, repair and verify it before acknowledging readiness.
4. Open a normal chat inside that exact Project. Select the existing shared Hub
   connector and confirm its ID/name/MCP URL against the generated metadata.
   Call `workspace_info(workspace="<workspaceId>")` and require that exact ID.
   Do not accept local health, a chat's title or pasted repo content as evidence.
5. Only after successful UI and MCP verification acknowledge a new/synced binding:

   ```bash
   c2c project bind --workspace <workspaceId> --project-url "<verified-project-url>" --instruction-hash <verified-hash> --json
   ```

   A hash conflict requires regenerating, applying and verifying current
   instructions; never copy an old hash to bypass the conflict. A `current`
   unchanged binding needs no new acknowledgement after verification.
6. Report **MCP READY**, then stop. Do not store the verification chat URL or
   introduce task/session/checkpoint state.

If the Project is unavailable, instructions cannot be confirmed, MCP returns a
different workspace ID or the connector differs, fail closed. Keep the existing
binding and resources; do not record success or create a connector. Explicit
`c2c project unbind --workspace <workspaceId> --json` removes local metadata only;
it does not delete the ChatGPT Project or change its instructions.
`DESTROY_PENDING` blocks bind/unbind until the Hub's destroy is resolved;
status/instructions remain local diagnostics. Destroy removes only local Project
acknowledgements, never ChatGPT Projects or their Instructions.
