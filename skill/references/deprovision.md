# Experimental deprovisioning

Read this reference only when the user explicitly requests destruction or
cleanup of the Hub's connection/resources. The procedure is experimental;
report partial results and concrete blockers rather than claiming completion.
Disconnect retains resources and stays in SKILL.md. Setup, doctor and repair
do not authorize deprovisioning. An authorized rename/rebind may replace its
owned connector under the normal transaction without destroying the Hub.

## Workflow

1. Run `c2c destroy --json` for the read-only ownership-checked plan.
   Do not proceed on incomplete legacy bindings, pending rollback or conflicts.
2. In ChatGPT verify `plan.connector` by exact ID/name/Server URL, then remove
   only that plugin (or verify that exact ID is already absent). Legacy bindings
   without a plugin ID need verified `connector bind` before deletion.
   Uninstall/disconnect is not deletion. If settings deletion fails, read
   [interrupted destroy recovery](#interrupted-destroy)
   for the personal plugin deletion path and manual-cleanup verification.
3. If `plan.desired.needed` has a URL, verify the pending desired plugin is
   absent or remove only its matching owned partial plugin. Never delete a
   title collision with another Server URL.
4. Run `c2c destroy --confirm --connector-removed <bound-id> --json`.
   Omit the bound-ID flag when no bound plugin exists. Include
   `--desired-connector-absent` only after step 3. Flags are receipts of observed
   UI actions, not proof the runtime independently obtained; never fabricate them.
5. Runtime rechecks ownership, revokes/stops, removes recorded DNS/tunnel, then
   this Hub's local state (including validated Project binding acknowledgements),
   registry and finally Hub identity. Project bindings are preflighted before
   remote deletion; malformed, foreign, unexpected or symlinked state blocks it.
   A failure retains its receipt/state for retry. ChatGPT Projects and their
   Instructions are not automatically deleted.
   Shared credentials, other Hubs and repository files stay intact.
   Verify remote absence and removal of this Hub's state before reporting
   complete destruction. Report each remaining blocker separately; Cloudflare
   cleanup alone is partial. After user-reported manual cleanup, inspect fresh
   state and resume the authorized destroy rather than repeating an old blocker.
   For partial cleanup follow [recovery below](#interrupted-destroy); do not
   wipe the state directory.

## Interrupted destroy

For a leftover CLI lock, follow [lock recovery](operations.md#locks) before
retrying. Keep the existing Hub identity and resource bindings.

Destroy checks UUID/name and exact DNS target. It preserves a receipt before
remote cleanup, and keeps local state if cleanup fails. Do not reconfigure a
Hub with a pending destroy receipt. Missing API access is a credential
blocker, not permission to forget resources. Check whether
`CLOUDFLARE_API_TOKEN` is available without printing its value; use it directly
from the environment when present.

If `Delete app` in settings fails, inspect the owned plugin's personal detail
page: `https://chatgpt.com/plugins/<connector-id>?directoryTab=personal`.
Use More actions → Delete plugin if offered, verifying the exact saved ID and
the previously checked name/Server URL. This is an alternative UI path, not
proof that deletion will succeed. Respect required deletion consent. Uninstall,
absence from an admin list, or a failed delete alert does not prove removal.
After a successful action or user-reported manual deletion, reload the exact
plugin page and verify absence. Do not recreate/install it to test deletion.
If the result is still ambiguous, retain state and report the concrete blocker.

Once plugin removal is verified, resume the existing destroy automatically.
Without a saved destroy receipt, pass `--connector-removed <bound-id>` and any
verified `--desired-connector-absent` as in the workflow above. With a valid Hub-owned `lifecycle/<hubId>.json`
saved receipt, retry `c2c destroy --confirm --json`. Already absent owned DNS/tunnels
are tolerated; do not recreate resources or patch bindings to finish cleanup.
If only Cloudflare cleanup was requested while ChatGPT deletion was blocked,
report it as partial and retain the binding for this later retry.

Before reporting full completion, verify the recorded hostname is absent via
the Cloudflare API and the tunnel UUID is absent from `cloudflared tunnel list`.
Dashboard/browser/DNS resolver caches alone are not authoritative. Check that
the bridge is stopped and this Hub's auth, runtime, endpoint, tunnel,
registry, local Project binding acknowledgements and daemon logs are gone, including
the destroy receipt. Inspect paths/existence without dumping credentials.
Reinspect after the user reports manual cleanup; do not reuse stale results.
The shared state directory may remain for prefs, global logs or other Hub
IDs. Never delete those merely because this Hub was destroyed; report
unverified historical IDs separately without claiming they are orphaned.

Destroy only knows recorded resources. Other historical tunnels or manually
added DNS aliases need separate ownership review. External dashboard changes
can race API checks; stop on conflicts instead of forcing deletion.
Shared Cloudflare credentials and ChatGPT chat history are never deprovisioned.

Legacy cleanup is separate from destroy. Never delete retained migration-gate
backups, shared credentials, global settings or repository contents.
