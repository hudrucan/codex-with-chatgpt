# Rare bridge operations

Read only the section relevant to the current diagnostic. Keep the selected
Hub and its existing resource IDs. These are recovery procedures, not a
coding workflow; a recovered connection ends at `MCP READY` and stops.

## Named Tunnel prerequisites

`cert.pem` authenticates the cloudflared account; it is not the tunnel credential.
A locally managed Named Tunnel also needs `~/.cloudflared/<TUNNEL-UUID>.json`
(`%USERPROFILE%\.cloudflared\<TUNNEL-UUID>.json` on Windows), or the configured
`TUNNEL_CRED_FILE`. Doctor distinguishes missing certificate, missing/unreadable
credential, invalid JSON and a UUID mismatch without printing credential content.

Follow the diagnostic: account login uses `c2c tunnel login`; a missing tunnel
credential may be restored for the existing UUID with
`cloudflared tunnel token --cred-file <credential-path> <TUNNEL-UUID>`.
Do not copy credentials into the repo, ChatGPT or logs. Never recreate a
working resource to avoid restoring its saved credential.

For QUIC-blocked networks, set `C2C_TUNNEL_PROTOCOL=http2` in the bridge's
launch environment, then explicitly restart. Do not rotate the hostname.

## Rename rollback and API access

Tunnel rename uses the saved UUID in place. Hostname rename creates the new
route before deleting the old exact CNAME, whose target must match that UUID.
Do not force-overwrite DNS or append a suffix to bypass an ownership conflict.

Rename/cleanup needs an environment-only `CLOUDFLARE_API_TOKEN` with Zone Read
and DNS Edit for the relevant zone, plus Tunnel Write for tunnel rename.
Ordinary unchanged setup uses the existing cloudflared account certificate.
Do not read the certificate to extract tokens; do not paste API tokens in UI.

`TUNNEL_ROLLBACK_PENDING` retains operation intent. Rerun the named setup
request once to retry rollback before applying the requested names. Do not
switch to Quick, discard the journal or claim success while cleanup is pending.
A lost create response before its UUID is known cannot safely be adopted or
deleted automatically. Report the requested name and need to verify Cloudflare
ownership manually, preserving the journal.

## Locks

CLI lifecycle operations serialize per Hub. A crash can leave a lock;
verify the recorded process is gone before removing that specific lock. Do not
auto-remove locks by age or kill an unverified PID.

## ChatGPT UI recovery

For a stale tool surface, open the exact existing connector in Manage and use
Refresh tools. Then select that connector and verify all eight tools and the
optional workspace selector in a new ordinary chat
in the same IAB tab and verify there. Tool refresh does not create a Project;
reuse an existing Project binding when applicable. Do not persist a chat pointer,
send a task handoff or repeatedly message a stale conversation.

Use visible settings navigation if a legacy deep link redirects without opening
the add form. Start at Plugins → Manage → Add → Add custom MCP server when
those controls are present. A new layout is a reason to inspect the UI, not
recreate unrelated plugins. Login/2FA/CAPTCHA and explicit consent may need the
user. Preserve the tab for handoff and resume the same setup when completed.
