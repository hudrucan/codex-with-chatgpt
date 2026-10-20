# ChatGPT Project repository memberships

Each Hub connector serves its registered workspaces. Projects and Hubs have a
many-to-many relationship: a Project may combine any number of Hubs, and a Hub
may serve many Projects. A workspace may belong to many Projects independently,
including through different Hubs. Routing is connector plus workspace ID.
Membership is routing/context metadata, not ownership or an extra MCP grant.
Adding a repo to Project B never moves it out of Project A. Never create a
connector for a Project or use a Project title as identity evidence.

## Select and inspect

Use the Project explicitly requested by the user or visibly selected for this
operation. If unclear, ask once to choose an existing Project or create one;
allow declining an optional Project. Do not pick a Project solely because the
workspace already appears in it. Verify its exact visible landing URL with stable
`g-p-...` ID, then run:

```bash
c2c project status --project-url "<project-url>" --json
```

Pass `--hub <id>` when multiple Hubs exist. Every command reads/writes only that
Hub's Project membership record; it does not select or change another Hub.
`current` means local aggregate metadata matches, not that the UI or MCP has been
verified. `projectVerification: "not_checked"` requires visible verification.
A missing/inaccessible/redirected saved Project is a blocker, never permission
to adopt another by title or create a replacement. `stale` or nonempty
`staleWorkspaceIds` requires explicit re-registration or membership removal.

## Add a repository or sync a Project

1. Register the repo locally to the selected Hub if necessary. Obtain its
   authoritative workspace ID from the local registration, not `list_workspaces()`
   as a routing decision. Select the Project without altering any other Project.
2. Preview the selected Hub's complete Project block plus the new member:

   ```bash
   c2c project instructions --project-url "<project-url>" --workspace <workspaceId> --json
   ```

   Omit `--workspace` to sync existing memberships. This preview writes nothing.
   Use returned `repositories`, `instructions`, `instructionHash` and separate
   `connector` metadata. Connector ID/name/URL must match the Hub's verified
   binding. The verified display name enters the managed text and semantic hash;
   connector ID/URL and runtime details do not. A verified name change requires sync.
3. Open the exact Project's visible Instructions editor. Preserve unrelated
   instructions and every other Hub's block verbatim. Replace only the single
   complete block delimited by `[codex-with-chatgpt hub="<selected-hubId>"]` and
   `[/codex-with-chatgpt hub="<selected-hubId>"]`, using the exact returned `hubId`.
   If that Hub has no block, append its generated block. Other Hub IDs are not
   duplicates. Duplicate blocks for the selected Hub, nested/overlapping blocks,
   unmatched or mismatched markers require resolution; never rewrite the whole field.

4. Save and reopen/read the editor to confirm the entire block exactly. Do this
   even for a locally `current` Project before reporting readiness. The hash
   covers only the selected Hub's generated block. Confirm that every other
   Hub's block and all unrelated instructions remain unchanged.
5. In a normal chat inside that exact Project, select the existing shared Hub
   connector. Confirm its ID/name/MCP URL using returned local metadata. For
   each repository relevant to this verification, call
   `workspace_info(workspace="<id>")` and require that exact ID. Local health,
   pasted repo contents and conversation titles are not MCP evidence.
6. Only after exact UI and MCP verification acknowledge the new member:

   ```bash
   c2c project bind --project-url "<project-url>" --workspace <workspaceId> --instruction-hash <verified-hash> --json
   ```

   Omit `--workspace` when acknowledging sync without adding a member. Only that
   Hub/Project record is written. A stale hash requires re-preview/apply/verify;
   never bypass it. A `current` unchanged Project needs no redundant write.
7. Report **MCP READY**, then stop. Do not store chat URLs or introduce task,
   planning, session or checkpoint orchestration.

## Remove one membership

```bash
c2c project unbind --project-url "<project-url>" --workspace <workspaceId> --json
c2c project instructions --project-url "<project-url>" --json
```

Use an exact ID when the grant was removed. This changes only the selected
Hub/Project membership; other Hubs, Projects and Hub read grants are unchanged.
It does not edit ChatGPT. Sync the new aggregate through the same visible UI/MCP process,
then acknowledge with `project bind` without `--workspace`. The last removal
retains an empty Project record so an empty routing block can be synced safely;
it never deletes a ChatGPT Project. If the user explicitly removes this Hub's
instruction block, remove only its exact opening-to-closing span; preserve every
other Hub's block and do not acknowledge removed text as applied. Removing a
registry grant excludes that ID from every affected Project block and reports stale membership IDs until explicitly
removed or re-registered. No silent membership transfer or rebind is involved.

## Repository routing in Project conversations

Use each repository's connector plus explicit workspace ID from its Hub's block. Never
omit `workspace` or use `list_workspaces()` to choose a repository. Choose from
the user's request and conversation context; read only a clearly targeted repo,
inspect each relevant repo through its block's connector for cross-repo work,
and ask before reading when the connector or repository is ambiguous. Before
first use of a connector/workspace pair in a conversation, verify its exact ID
through that connector's `workspace_info`; reuse that verification unless a
tool/connector error suggests the binding changed. The same workspace ID reached
through another connector requires its own verification.

Missing Project access, unconfirmed instructions, connector mismatch or incorrect
MCP workspace ID fails closed without recording success. `DESTROY_PENDING` blocks
bind/unbind; status/instructions remain diagnostics. Hub destroy removes validated
local Project records, never ChatGPT Projects or their Instructions.
