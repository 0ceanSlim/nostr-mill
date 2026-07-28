# mill OAuth shim

`mill-oauth.html` is a **template** you deploy to enable "Continue with Google"
(and cross-app recovery) in apps that use mill. It is a single static file — no
server logic, no database, no secret.

## Why it exists

Google validates the OAuth flow against the **origin** that runs it, and the
`drive.appdata` scope is scoped **per OAuth client**. A drop-in library embedded
on many different sites therefore can't run the flow itself — every host would
get a separate Drive folder for the same user, fragmenting their identity. This
one page, on one origin you own, holding one shared client ID, is what makes
"log in with Google" resolve to the **same** Nostr identity everywhere.

It holds no secret: an OAuth client ID is public by design, and the registered
origin is the security boundary.

## Deploy

1. **Google Cloud Console** (free, no billing): create an **OAuth client ID
   (Web application)**, enable the **Drive API**, and confirm the `openid` scope
   is available (both `openid` and `drive.appdata` are non-sensitive — no
   review). Add this page's origin under **Authorized JavaScript origins**
   (scheme + host, no path, no trailing slash).
2. **Copy `mill-oauth.html`** to a stable HTTPS origin you control, and fill in
   the two values in the `TEMPLATE` block at the top:
   - `MILL_CLIENT_ID` — the client ID from step 1.
   - `MILL_ALLOWED_ORIGINS` — every origin that embeds mill and opens this popup.
3. **Point mill at it:** `MILL.open({ oauthShim: 'https://you.com/mill-oauth.html' })`.

Full walkthrough (including the failure-mode table): [`../docs/google-login-setup.md`](../docs/google-login-setup.md).

## Cross-app recovery (optional)

If you also enable the experimental relay backup
([`../docs/nip-cloud-key-backup.md`](../docs/nip-cloud-key-backup.md)), no change
to this file is needed beyond what's already here — it requests the `openid`
scope so mill can read the account's stable `sub`. You additionally pass
`MILL.open({ backupRelays: ['wss://your-relay'] })` on the app side, pointing at
a relay that accepts these backups.

## Note on updates

If you deployed an earlier copy, the current template adds the `openid` scope and
a `userinfo` fetch that returns `sub`. Re-copy this file (keeping your two config
values) to pick that up; without it, cross-app recovery stays hidden but Drive
login keeps working.
