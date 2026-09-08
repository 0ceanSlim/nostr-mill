# mill 1.7 — Pomegranate deploy & demo handoff (oslim.dev)

This is the handoff for updating the **oslim.dev demo** to mill 1.7 and standing
up the **pomegranate infrastructure** it needs. It has two halves:

- **Part A — Demo page changes** (small; front-end config).
- **Part B — Stand up `central` + `operator` servers** (the real work; Go daemons).

> **You probably don't need Part B.** As of 1.7, `MILL.open({ pomegranate: true })`
> uses the shared **njump ecosystem** (central `auth.njump.me`; operators
> `po.f7z.io`, `po.coracle.social`, `po.njump.me`, `po.jumble.social`; 3-of-4) —
> the same set Jumble uses, so users get one identity across the ecosystem and you
> host nothing. Part B is only for running your **own** central+operators (a
> separate identity namespace — see "Choosing a central" in the README). The
> oslim.dev demo now just uses `pomegranate: true`.

> **What 1.7 changes for the demo:** the experimental relay-published cross-client
> backup from 1.6 is **gone**. Cross-client "Continue with Google" is now a client
> of fiatjaf's **pomegranate** (FROST threshold signing). The 1.6 **Drive+PIN**
> Google path still exists in the code — keep your 1.6 OAuth shim running for
> yourself **until 1.8**; nothing forces you to remove it now.
>
> **Experimental & self-hosted:** pomegranate is days old, has no NIP, and needs
> servers you run. Treat this as a testbed, not a production promise.

---

## Part A — Update the demo page

1. **Bump the mill build** the demo loads to the 1.7 beta once published, e.g.:
   ```html
   <script src="https://cdn.jsdelivr.net/npm/nostr-mill@1.7.0-beta.3/dist/mill.umd.min.js"></script>
   ```
2. **Enable pomegranate** in the `MILL.open` call (replace the old `backupRelays`
   / Drive-only config). For the shared njump ecosystem — what oslim.dev now uses
   — that's just:
   ```js
   MILL.open({
     appName: 'oslim.dev',
     pomegranate: true,                    // central auth.njump.me, po.* operators, 3-of-4
     // header/footer/branding as before …
   });
   ```
   To run your own servers instead, pass `pomegranate: { central, operators,
   threshold }` (see Part B). `pinCentral` now defaults to **true** (no discovery
   redirect / "found elsewhere" interstitial); set `pinCentral: false` if you want
   cross-central discovery. When `pomegranate` is set it becomes the "Continue with
   Google" method and **takes precedence** over the Drive+PIN path — no double
   button.
3. **Remove** any `backupRelays` option and `backup-relays` attribute — they no
   longer exist in 1.7.
4. **Leave your 1.6 Drive+PIN shim** (`mill-oauth.html` + its Google client)
   deployed and untouched until 1.8, so existing 1.6 logins keep working.

That's the entire front-end change. Everything else (signing consent, branding,
Amber, etc.) is unchanged.

---

## Part B — Stand up pomegranate `central` + operators

The source lives at fiatjaf's git (not GitHub). `fiatjaf.com/pomegranate` is the
Go **import path**, not a web page (it 404s in a browser). Browse it at
<https://gitworkshop.dev/npub180cvv07tjdrrgpa0j7j7tmnyl2yr6yr7l8j4s3evf6u64th6gkwsyjh6w6/pomegranate>,
or clone `https://pyramid.fiatjaf.com/npub180cvv07tjdrrgpa0j7j7tmnyl2yr6yr7l8j4s3evf6u64th6gkwsyjh6w6/pomegranate.git`
(also via the Go module proxy or ngit). It's Go; each server needs
[`templ`](https://github.com/a-h/templ) to generate templates and builds with the
`libsecp256k1` tag.

### Topology for oslim.dev (minimal test setup: 2-of-3)

| Service | Suggested host | Port | Role |
|---|---|---|---|
| central | `central.oslim.dev` | 5033 | Google OAuth + NIP-46 coordinator |
| operator 1 | `op1.oslim.dev` | 5041 | holds shard 1 |
| operator 2 | `op2.oslim.dev` | 5041 | holds shard 2 |
| operator 3 | `op3.oslim.dev` | 5041 | holds shard 3 |

Put each behind your reverse proxy (nginx/caddy) with **real TLS** — **not**
Cloudflare's flexible/automatic HTTPS, since that would let Cloudflare see the
shards in transit (the operator README calls this out explicitly).

> **Trust-model note, honestly:** FROST's security comes from operators being
> *independent parties* who won't collude. Running all three yourself (as you
> will, to start) gives you the working flow and cross-client identity, but **not**
> the collusion resistance — you can reconstruct any user's key from your own
> servers. That's fine for a testbed and for your own account; if this ever goes
> real, some operators should be run by other people.

### Build (each server)

```bash
templ generate
go build -tags=libsecp256k1 -o ./central     # in central/
go build -tags=libsecp256k1 -o ./operator     # in operator/
```
(Static musl build instructions are in the operator README if you want a
dependency-free binary.)

### Environment

**central** (`central/main.go`):

| Var | Default | Needed |
|---|---|---|
| `PORT` | `5033` | |
| `SERVICE_URL` | | yes — `https://central.oslim.dev` |
| `GOOGLE_CLIENT_ID` | | yes |
| `GOOGLE_CLIENT_SECRET` | | yes |
| `DB_PATH` | `central.db` | |

**operator** (one per operator; `operator/README.djot`):

| Var | Default | Needed |
|---|---|---|
| `PORT` | `5041` | |
| `SERVICE_URL` | | yes — e.g. `https://op1.oslim.dev` |
| `GOOGLE_CLIENT_ID` | | yes |
| `GOOGLE_CLIENT_SECRET` | | yes |
| `DB_PATH` | `operator.db` | |

Run each under systemd (the operator README has a ready template — adapt the
`SERVICE_URL`/port per service).

### Google Cloud Console (OAuth)

Pomegranate reads the user's **email** from Google (a normal OpenID sign-in) —
non-sensitive scopes, **no security review**. You need OAuth 2.0 **Web
application** credentials with these **Authorized redirect URIs**:

- central: `https://central.oslim.dev/callback/google`
- op1: `https://op1.oslim.dev/po/callback/google`
- op2: `https://op2.oslim.dev/po/callback/google`
- op3: `https://op3.oslim.dev/po/callback/google`

Simplest: **one OAuth client** with all four redirect URIs added, and use its
client id/secret for every service. (You *may* use a separate client per service
instead — more isolation, more setup.) Also add each service's origin under
**Authorized JavaScript origins** if Google asks.

### Discovery relays

Cross-client discovery publishes/queries a `kind:16440` event keyed by
`argon2id(email)`. mill defaults to a public relay set (damus/primal/nos.lol/
nostr.mom/offchain). No action needed unless you want to pin your own — if you do,
pass the same `relays` list in the demo's `pomegranate` config **and** make sure
central/operators publish there too, or discovery won't line up across clients.

---

## Test checklist (once central + operators are up)

1. Demo → **Continue with Google** → the Google popup is served by
   `central.oslim.dev/login/google`. Approve.
2. **First run:** it should reach **Set Up Your Account** → choose **Create new
   key** (or **Import my key** to shard an existing nsec/hex — see BYOK below) →
   watch central + operator logs for the `POST /register` and `POST /po/register`
   calls, then the account coming online. mill shows the nsec once (optional
   backup) → **Continue** → it connects the NIP-46 bunker and you're signed in.
3. **Returning run** (same Google account, even a different browser/app): it
   should discover the account (kind:16440), resolve the bunker, and sign in with
   the **same npub** — no new key.
4. **Sign something** — confirm the NIP-46 round trip through central produces a
   valid signature.
5. **Recover** — "Recover my key from operators" → Google at each operator →
   after the threshold, mill reconstructs and shows the nsec.
6. **Replace the key** — on the "Continue with Google" screen, "Use a different
   key with this Google account" → Google → *Replace Your Key* shows the current
   npub. Optionally back it up, then **Import my key** (or Create new key), tick
   the confirm box, and **Replace key** → one erase popup per operator ("Yes,
   erase forever") → Continue. Watch operator logs for `po-erase` then a fresh
   `po-register`, and central for `DELETE /account` → `POST /register` →
   `account created`. `GET /account` should then return the **new** pubkey, and
   signing works as it. If you Cancel an erase, that operator's row flips back to
   "still holds your old share" (a `403` on re-register) — erase it and Continue
   again; the retry is idempotent. Only one identity per Google account exists at
   a time. See `pomegranate-replace-key.md` for the full flow and server rules.

If sign-in never offers/discovers, check that `central/login/google` returns a
token whose base64 payload has an `email` tag, and that the operators confirmed
registration with central (central marks the account "operational" only after all
operators ack).

---

## Keys & accounts (BYOK and multi-account)

- **Bring-your-own-key (BYOK):** at signup, **Import my key** lets a user shard
  an existing `nsec`/hex instead of a freshly generated one. mill decodes it in
  the browser, FROST-shards it, and registers it exactly like a new key. Useful
  for moving an established identity onto pomegranate. The UI warns that the
  operators then become semi-custodians of that identity — a threshold could
  rebuild it — so it's a trust decision the user makes knowingly.
- **One key per Google account.** `central` keys the account record by email, so
  each Google account resolves to exactly one npub; a second signup overwrites
  the first. Pomegranate **profiles** are multiple NIP-46 bunkers for the *same*
  identity (permission scopes), not distinct npubs.
- **Want multiple identities?** Use BYOK with **separate Google accounts** — that
  works today with stock pomegranate. Supporting several *distinct* npubs under a
  single Google account would mean forking `central` to key by `[email, index]`,
  which breaks cross-client interop with other pomegranate clients and centrals.
  mill deliberately does not do this.

## What mill does vs. what you host

- **mill (client):** the whole UI + the pomegranate client protocol (OAuth popup,
  argon2id discovery, FROST sharding via `@fiatjaf/promenade-trusted-dealer`,
  register calls, NIP-46 connect, recovery). Nothing to configure beyond the
  `pomegranate` object.
- **you (host):** the `central` + `operator` servers, their Google OAuth client,
  TLS, and uptime. If a threshold of operators is down, users can't sign — that's
  the availability cost of the model.
