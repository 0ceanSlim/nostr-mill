# mill 1.7.0-beta.4 — discovery redirects, popup blocker, stale announcements

> **Status: implemented in 1.7.0-beta.4.** Design/spec record. Found while
> migrating oslim.dev to the njump ecosystem with beta.3; reproduced and verified
> against the relays on 2026-09-08. See the "As implemented" note at the end for
> the one deviation.

## What happened

The oslim.dev demo is configured for `central: 'auth.njump.me'`. The tester's
email has two `kind:16440` announcements on the default discovery relays, both
pointing at the deprecated `https://central.oslim.dev` (the newest was published
by the beta.2 replace flow at 14:04); there is **no** njump announcement.

`start()` therefore did: Google popup at njump (inside the click) → `discover()`
finds a *different* central → `pomAuthenticate(found.centralURL)` opens a **second**
popup. That `window.open` ran after several awaits; the click's transient
activation was consumed by the first popup, so Chrome blocked it:

> Popup blocked. Allow popups for this site and try again.

Allowing popups would make it worse: the replace flow would run against the old
central and publish yet another stale announcement.

Cosmetic, separate: the console showed
`Cross-Origin-Opener-Policy policy would block the window.close call` from
`oauthPopup`'s cleanup. "would block" means report-only COOP, nothing is blocked;
the call was `w.close()` on a popup that already closed itself.

## Fixes

1. **Never auto-open the re-auth popup.** When `discover()` returns a central that
   differs from the active one, `start()` stops and renders an interstitial
   (`found-elsewhere`):

   > **Account Found Elsewhere** — this Google account already has a Nostr
   > identity at `auth.njump.me`. [Continue there] · [Cancel]

   The button's click handler calls `pomAuthenticate(found.centralURL)`, so the
   popup opens inside a fresh user activation. This is what fiatjaf's
   implementation guide describes ("display a button telling the user that a
   setup was found at this other server").

2. **In the replace intent, let the user choose the central.** Same interstitial,
   two choices:

   > Found at `central.oslim.dev` — [Replace the key there]
   > or [Import here, at `auth.njump.me`] — creates/replaces the account at the
   > configured central and publishes a fresh announcement that outranks the old.

   Moving a key between centrals is exactly the case where following the old
   pointer is wrong. For plain sign-in there is only "Continue there" plus Cancel,
   so non-technical users never end up with two identities.

3. **Publish the announcement whenever the client holds the key**, not only in a
   fresh `signup()`: after a BYOK import and after a replace (both already route
   through `signup()`, which publishes). For plain NIP-46 logins the client cannot
   sign a 16440 (it never holds the key), so the interstitial in (1) is the
   self-healing point: "Import here" makes the new announcement the newest. The
   migration doc's "do one replace/relogin anyway" advice was dropped — a relogin
   never announces, and the same-key guard blocks a same-key replace.

4. **`oauthPopup` cleanup:** `if (!w.closed) try { w.close() } catch {}` — removes
   the COOP console noise (applied to `oauthPopup` cleanup + timeout and
   `erasePopup` timeout).

5. `pinCentral: true` stays as the self-hoster escape hatch; the docs note the
   demo may set it temporarily during a migration.

## Test checklist

1. Email whose newest announcement points at central A, demo configured for
   central B → one popup, then the interstitial; "Continue there" opens exactly
   one more popup with no blocker and signs in at A.
2. Same setup, "Use a different key with this Google account" → interstitial with
   both choices; "Import here" imports at B, `GET /account` on B returns the new
   key, the relays carry a newer 16440 pointing at B, and a fresh page load signs
   in at B with no interstitial.
3. Email with no announcements → no interstitial, flow unchanged.
4. Console clean of the COOP warning after a completed Google popup.
5. Popups blocked in Chrome settings → the interstitial button shows the existing
   "Popup blocked" message instead of a silent stall.

## As implemented (deviations from the spec)

- **Recovery does not re-publish an announcement.** The spec listed "after
  recovery" under fix (3). The recover flow reconstructs the key from per-operator
  OAuth shards and never obtains the account **email**, so it can't compute the
  `argon2id(email)` discovery tag to publish a `16440`. Import and replace (which
  do have the email, via the central token) already publish through `signup()`, and
  the interstitial's "Import here" is the migration self-heal, so recovery-publish
  was omitted rather than bolting an extra central Google auth onto recovery.
- **Automated coverage.** The `start()`→`proceedAt` refactor was verified in-browser
  for the no-redirect sign-in and replace paths. The interstitial itself can't be
  triggered in automation — mill's bundled nostr-tools uses the real `WebSocket`,
  so a stubbed relay event can't be injected into `discover()`. The interstitial
  is covered by the build, code review, and the live checklist above (the tester
  has the exact repro).
