# mill 1.7.0-beta.2 — Replace the key behind a Google account (pomegranate)

> **Status: implemented in 1.7.0-beta.2.** This is the design/spec record kept
> for reference. Server facts were verified against the pomegranate commit
> running at oslim.dev (`aaca8f9`, central + 3 operators).

> **Why this exists.** In beta.1, **Import my key** lives only on *Set Up Your
> Account*, which mill reaches only when central answers `404` for `/account`.
> An existing account auto-signs-in, so the one group of users who *want* to
> import (people who already have an account and want a different key behind
> the same Google login) can never see the button. beta.2 makes replacing the
> key a first-class, always-reachable path, with explicit "this replaces your
> current identity — back it up first" prompts.
>
> **Scope:** mill only. pomegranate needs no change, but its rules dictate the
> order of operations. Still one identity per Google account *at a time*.

---

## 1. What the servers actually do

| Call | Behaviour (pomegranate `aaca8f9`) | Consequence for mill |
|---|---|---|
| central `GET /account` | `{ operators: [{url, pubshard}], threshold, pubkey }`, or `404` | Gives the **current npub** and the **operator set to erase at** |
| central `POST /register` while an account exists | Allowed only if the event pubkey **equals** the registered pubkey ("update" / re-shard). A different pubkey → `409 pubkey does not match registered account`. A pending registration for the email → `409 registration already in progress` | You **must `DELETE /account` first**, then register the new key |
| central `DELETE /account` (`Authorization: Token …`) | `204`. Deletes the account, all profiles and handler keys, **and any pending registration**. Idempotent. Existing `bunker://` URIs stop working at once | Safe to call again on retry |
| central pending registration | In-memory, **swept after 60 s** (`central/main.go` ticker) | Everything from `POST /register` to the last operator ack must complete within a minute → **no user interaction inside `signup()`** |
| central token | Valid **24 h** | No re-auth needed mid-flow |
| operator `POST /po/register` | If a shard exists for that email under a **different** pubkey → `403 a different pubkey is already registered for this email`. Same pubkey → overwrite allowed | Old shards must be erased **before** `signup()`; the 403 is also your proof that an erase did *not* happen |
| operator erase | `GET /po/erase/google` → Google → `/po/callback/google` sets an HttpOnly cookie `reallyDelete` (Path `/po`, 5 min) and renders a confirm page. "Yes, erase forever" does `DELETE /po/shard` then `window.close()`. **Cancel also just closes.** No `postMessage`. Unknown email → `404` text page | From mill you can only observe "popup closed". Proof of success is the later `POST /po/register` returning `200` |

Why operators insist on their own OAuth to erase (from `operator/handlers.go`):

> if a registration already exists for this email, require it to be from the
> same public key (this prevents rogue actors from overwriting other people's
> shard registrations). if one wants to use a new keypair with their previous
> email they'll have to delete their shards manually first

Operators trust central's word for a *first* registration only. Don't fight
this; the flow below works with it.

---

## 2. Order of operations (forced by the table above)

```
1. Google login at central            → token, email        (oauthPopup, as today)
2. discover() + GET /account          → account { pubkey, operators, threshold }
3. Confirm + optional backup          → user-driven, unlimited time
4. Erase at each of account.operators → one popup per operator, user-clicked
5. DELETE /account                    → 204 (clears pending too)
6. signup({ secretKey })              → POST /register + POST /po/register ×N + poll
                                        + announce + default profile — all machine
                                        speed, well inside the 60 s window
7. Connect the new bunker
```

Do **not** interleave the erase popups between `POST /register` and the
operator registrations: the pending registration would expire while the user
is busy with Google. Do **not** call `DELETE /account` before the erases: if
the user bails at the first popup nothing has changed and they can keep using
the old account; once erases start they are committed anyway (at 2-of-3, two
erases make the old key unrecoverable), which the UI says up front.

Same central for everything: use the central where the account was found
(`activeCentral` after discovery), for delete and for the new signup.

---

## 3. UX

### 3.1 Entry point — always visible
In `renderPomegranateFlow`, `step === 'idle'`, directly under the existing
"Recover my key from operators" link, add a second `mill-consent-manage` link:

> **Use a different key with this Google account**

Muted, same style, no badge. Click → `intent = 'replace'; start(render)`.
(Optional: mention "replaceable later" in the picker card sub-text.)

### 3.2 `start()` with `intent === 'replace'`
Same auth + discovery as today, then:
- **no account** → `step = 'new-account'` with `mode = 'import'` preselected.
  The link doubles as an import shortcut for new users.
- **account exists** → keep `account` (from `getAccount`, *not* `loginExisting`,
  which would create a default profile) plus `auth = { centralURL, token, email }`,
  then `step = 'replace-confirm'`.

### 3.3 `replace-confirm` — "Replace Your Key" (step 1 of 4)
- Current identity block: npub from `account.pubkey`, "sharded across N
  operators, M needed".
- Danger badge: *"This permanently replaces the identity tied to
  {email}. Your posts, follows and DMs belong to the current key; after
  replacing, nothing can sign as it again unless you keep a backup. If you care
  about this identity, back it up now."*
- Ghost button **Back up current key first** → runs the existing `recover`
  step with `returnTo = 'replace-confirm'`, so **Done** on `recovered` returns
  here instead of `idle`. Afterwards show a "✅ Backed up" hint.
- The `new-account` segmented control, reused: **Import my key** (default) /
  **Create new key**, same nsec/hex field and validation.
  Guard: if `getPublicKey(imported) === account.pubkey` → inline error
  *"That's already the key on this account."*, Replace disabled.
- Checkbox: *"I understand my current key will be erased from the operators
  and this cannot be undone."*
- Footer: **Back** (→ idle) · **Replace key** (danger style; enabled only with
  checkbox ✓ and a valid key when importing) → `step = 'replace-erase'`.

### 3.4 `replace-erase` — "Erase old shares" (step 2 of 4)
One row per entry in `account.operators` (use `op.url`; this is the account's
set, which may differ from the configured `operators`), styled like the
`recover` rows:

```
⏳ op1.oslim.dev   [Erase at op1.oslim.dev]
✅ op2.oslim.dev   requested
⏳ op3.oslim.dev   [Erase at op3.oslim.dev]
```

Each button opens `${op}/po/erase/google` through a new `erasePopup()` helper
**from the click handler** (popup blockers). When the window closes, mark the
row "requested" — you cannot tell confirm from cancel here. Hint text:
*"Sign in with Google at each operator and confirm. Do all of them: stopping
halfway leaves your old key unrecoverable and no new key in place."*
**Continue** enables once every row is requested → `doReplace()`.

### 3.5 `doReplace()` — "Registering your new key…" (step 3 of 4, automatic)
1. `DELETE ${central}/account` with the token (`401` → `authenticate()` once, retry).
2. `signup({ centralURL, token, email, operators, threshold, secretKey, relays })`
   with the **configured** operators/threshold — the existing function, unchanged
   in behaviour (register → operators → poll → announce → default profile).
3. Success: generated key → existing `created` step (nsec shown once, then
   Continue → connect). Imported key → skip the reveal, show one line
   "Replaced ✓ — signed in as {new npub}" and `connectBunker(res.bunkerURI)`.
4. Failure: make `signup()` errors structured (`err.operator`, `err.status`,
   `err.body`). A `403` from an operator whose body starts with
   `a different pubkey is already registered` means that operator's erase was
   cancelled → back to `replace-erase` with that row reset to *"still holds your
   old share — erase again"*, other rows kept ✅. Continue runs `doReplace()`
   again. This is safe: `DELETE /account` is idempotent and clears the pending
   entry, and operators that already stored the new key accept the same pubkey
   again. Any other error → message + **Retry** on the same path.

### 3.6 The new announcement
`signup()` publishes a fresh kind `16440` signed by the new key. The old one
(signed by the old key) stays on relays; both carry the same `central` tag, so
discovery still resolves the right server. Make `discover()` prefer the newest
`created_at` if it ever receives several (nostr-tools `get` returns one).

---

## 4. Code touchpoints

`src/pomegranate.js`
- `erasePopup(operatorURL)` — like `oauthPopup` but resolves when the window
  closes (no message expected); rejects only if the popup was blocked. Same
  600×680 window name.
- `deleteAccount(centralURL, token)` → `DELETE /account`, resolve on `204`,
  throw with `status` otherwise.
- `signup()`: throw `Error` objects carrying `{ operator, status, body }` for
  operator failures and `{ status, body }` for the central registration.
- Export a small predicate, e.g. `isShardConflict(err)` (`status === 403 &&
  /different pubkey/.test(body)`).

`src/mill-core.js` — `renderPomegranateFlow`
- State: `intent` (`'signin' | 'replace'`), `account`, `returnTo`,
  `eraseRequested = {}`.
- New steps: `replace-confirm`, `replace-erase`, `replacing`.
- `start()` branch per §3.2; idle link per §3.1; `recovered` **Done** honours
  `returnTo`; the segmented control + nsec field factored so `new-account` and
  `replace-confirm` share it.
- Flow steps counter: replace path is 4 steps (confirm, erase, registering,
  done/connect).

Docs
- `README.md` → the "One key per Google account" note: still one identity per
  Google account *at a time*, but it can be replaced from inside mill (import
  or fresh key) after backing up; describe the erase-at-each-operator step so
  hosts know why there are N Google popups.
- `docs/pomegranate-deploy.md` → add test step 6 below.
- `package.json` → `1.7.0-beta.2`, publish with `--tag beta`.

---

## 5. Test checklist (against central.oslim.dev / op1–op3)

1. **Entry:** demo → Continue with Google flow's first screen shows the muted
   "Use a different key with this Google account" link; click → Google → *Replace
   Your Key* shows the current npub (`fd6313…` for the existing test account).
2. **Backup:** Back up current key first → two operator popups → nsec shown →
   Done returns to *Replace Your Key* with the ✅ hint.
3. **Happy path:** Import a fresh nsec (or Create new key) → checkbox → Replace
   key → three erase popups (Google at op1/op2/op3, "Yes, erase forever") →
   Continue → registering → signed in as the **new** npub. Logs: operators
   `op-register: registration saved` for the new pubkey, central
   `ack: registration complete, account created`; `GET /account` now returns
   the new pubkey.
4. **Cancelled erase:** repeat, but Cancel at op2 → Continue → op2 row flips to
   "still holds your old share" (from the 403), op1/op3 stay ✅ → erase at op2
   → Continue → success. Check central shows only one account for the email
   afterwards.
5. **Post-replace:** sign a note (NIP-46 round trip through central), then
   Recover my key from operators returns the **new** key.
6. **New user via the link:** a Google account with no pomegranate account →
   the link lands on *Set Up Your Account* with Import preselected.
7. **Same-key guard:** importing the key already on the account is refused
   inline, nothing is erased.
8. **Popup blocker:** with popups blocked, each erase button shows the existing
   "Popup blocked" message rather than a silent stall.

---

## 6. Out of scope / upstream notes

- Several *distinct* npubs under one Google account: still not supported
  (central keys accounts by email); this handoff only makes the one identity
  replaceable.
- Optional pomegranate nicety, not required: `confirmErasePage` could
  `window.opener.postMessage({ erased: true }, '*')` before `window.close()` so
  clients get a definitive signal instead of inferring from the 403. The retry
  loop in §3.5 covers it without that.
- oslim.dev demo: once beta.2 is on npm, bump the pin and change the Google
  card copy to "…one identity per Google account, replaceable any time".
