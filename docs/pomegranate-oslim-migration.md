# oslim.dev — retire the self-hosted central, contribute one operator

Handoff for the **oslim.dev server admin**. Goal: stop running a full pomegranate
stack, move onto the shared **njump ecosystem** (`pomegranate: true` territory),
but keep **one** operator running and contribute it to the set — following the
`po.<domain>` convention as **`po.oslim.dev`** (not `op.oslim.dev`).

Server facts below were verified against pomegranate `aaca8f9` (the commit running
at oslim.dev). Build/OAuth mechanics live in
[`pomegranate-deploy.md`](pomegranate-deploy.md); this doc is the *migration*.

---

## End state

| Was | Becomes |
|---|---|
| `central.oslim.dev` (your central) | **gone** — you use `auth.njump.me` |
| `op1.oslim.dev` | **repurposed → `po.oslim.dev`** (fresh operator DB) |
| `op2.oslim.dev`, `op3.oslim.dev` | **gone** |
| demo `pomegranate: { central: central.oslim.dev, … }` | `pomegranate: { central: 'auth.njump.me', operators: […, po.oslim.dev], threshold: 3 }` |

Central is auth.njump.me, so identities are the ecosystem's (one key per email,
same as Jumble). Your operator just holds shards for accounts created through your
demo — see the interop note below.

---

## ⚠️ Before anything: back up, or lose keys

Your old central runs **2-of-3**. The moment you take down two operators, any key
sharded there is **below threshold and unrecoverable** from the operators. So:

1. **Any key on `central.oslim.dev` you might ever want** — recover its nsec now,
   while all three old operators are still up: open a client pointed at the OLD
   config → **Recover my key from operators** → save the nsec. (Skip if you
   already hold that nsec.)
2. Only then proceed. If it's just throwaway test keys, fine — but decide
   deliberately, because there is no undo after step 4.

---

## Decisions (recommended answers baked in; change if you disagree)

- **Operator set for the demo.** Recommended: **additive**, keep all four
  ecosystem operators and add yours →
  `['po.f7z.io','po.coracle.social','po.njump.me','po.jumble.social','po.oslim.dev']`,
  **threshold 3-of-5** (mill computes 3 by default for n=5). This adds redundancy
  and doesn't displace anyone. (Alternative: swap one out for a 4-op 3-of-4 set —
  fewer shard-holders, but you drop a community operator.)
- **Your keeper identity.** You currently have two keys for your email: one on
  njump (from Jumble) and one on your old central. Pick one. Recommended: back up
  the old one, then on njump use **"Use a different key with this Google account"
  → Import my key** to make that your njump identity (it also publishes a fresh
  discovery announcement — see step 2). Or just keep the njump key and abandon the
  old one.
- **Do NOT add `po.oslim.dev` to mill's library defaults.** `POM_DEFAULT_OPERATORS`
  mirrors the ecosystem (fiatjaf's four); baking oslim in would make *every* mill
  consumer shard to your box. Keep it a per-demo override. To become a real
  default, go through Part 5.

---

## Part 1 — Stand up `po.oslim.dev` (repurpose the `op1` box)

`po.oslim.dev` is a **fresh** ecosystem operator: give it a new, empty
`operator.db`. The old `op1` shard DB was for old-central accounts and is
irrelevant once you've backed up (see safety note).

1. **DNS:** `po.oslim.dev` → the box (A/AAAA).
2. **TLS: real certs, terminated at your proxy.** **Not** Cloudflare
   flexible/automatic HTTPS — that would let Cloudflare see shards in transit
   (the operator README calls this out). nginx/caddy with Let's Encrypt is fine.
3. **Google OAuth:** in the same GCP project, add the operator redirect URI
   **`https://po.oslim.dev/po/callback/google`** to an OAuth *Web application*
   client. (Non-sensitive `email`/openid scope — no security review.) Reuse the
   client you already had, or make a dedicated one.
4. **Build & run** (see deploy doc for `templ generate` + `go build
   -tags=libsecp256k1`). Env for the operator:

   | Var | Value |
   |---|---|
   | `PORT` | `5041` |
   | `SERVICE_URL` | `https://po.oslim.dev` |
   | `GOOGLE_CLIENT_ID` | your client id |
   | `GOOGLE_CLIENT_SECRET` | your client secret |
   | `DB_PATH` | `po-oslim.db` (fresh) |

   Proxy `https://po.oslim.dev` → `127.0.0.1:5041`. Run under systemd (template in
   the operator README).
5. **Verify reachable:** `https://po.oslim.dev/po/recover/google` should return the
   Google sign-in (central's health probe hits exactly this path). Endpoints in
   play: `POST /po/register`, `POST /po/sign`, `DELETE /po/shard`,
   `/po/erase/google`, `/po/recover/google`, `/po/callback/google`.

At this point `po.oslim.dev` is live and empty; it gains shards only as new
accounts choose it (next part).

---

## Part 2 — Consolidate your identity on njump

Do this **before** tearing down the old central, so a fresh njump announcement
supersedes the stale `central.oslim.dev` one on the relays.

1. With the demo pointed at njump (Part 3 config, or temporarily `pomegranate:
   true`), open **Use a different key with this Google account** and sign in.
   Because your only announcements point at the (soon-dead) `central.oslim.dev`,
   mill shows the **"Account Found Elsewhere"** interstitial (beta.4+).
2. Choose **Import here (`auth.njump.me`)**, then **Import my key** and paste the
   nsec from the safety step. This creates/updates the account at `auth.njump.me`
   and **publishes a new `kind:16440`** pointing there — newer than the stale
   oslim announcement, so discovery now resolves njump. (Importing is what
   publishes a fresh announcement; a plain re-login can't — the client never holds
   the key — and a *same-key* replace is blocked by the guard, so "just relog in"
   does not fix discovery. Import, or replace with a different key.)
3. (Optional, best-effort) publish a NIP-09 deletion for the old
   `central.oslim.dev` `16440` events. Relays may or may not honor it; the newer
   njump announcement is what actually fixes discovery.
4. **During the migration** you can set `pinCentral: true` on the demo so mill
   ignores the stale oslim pointer and goes straight to `auth.njump.me` (no
   interstitial). Remove it once a fresh njump announcement exists.

---

## Part 3 — Point the demo at njump + your operator

On the oslim.dev demo page:

```js
MILL.open({
  appName: 'oslim.dev',
  pomegranate: {
    central: 'auth.njump.me',
    operators: [
      'po.f7z.io',
      'po.coracle.social',
      'po.njump.me',
      'po.jumble.social',
      'po.oslim.dev',        // yours
    ],
    // threshold: 3,          // optional; mill defaults to 3 for 5 operators
  },
  // header/footer/branding as before …
});
```

- **Remove** the old `central.oslim.dev` / `op*.oslim.dev` config.
- Don't set `pinCentral` — you *want* njump discovery/interop.
- **Interop note:** the operator set only applies to **new signups** through this
  demo. A visitor who already has a njump account (e.g. from Jumble) logs into
  *that* account with *its* operator set; `po.oslim.dev` isn't retroactively
  added. So `po.oslim.dev` holds shards only for accounts first created here — and
  because it's in those accounts' sets, keep it up: other clients will reach it
  for their recover/erase.

---

## Part 4 — Decommission the old central + two operators

Only after Parts 1–3 and the backup are done:

1. Stop and disable `central.oslim.dev`, `op2.oslim.dev`, `op3.oslim.dev`
   (systemd units + proxy vhosts). Keep the DBs archived for a bit if you're
   cautious.
2. Remove their DNS records (or point elsewhere).
3. In GCP, drop the redirect URIs for the retired hosts
   (`central.oslim.dev/callback/google`, `op2…/po/callback/google`,
   `op3…/po/callback/google`); keep `po.oslim.dev/po/callback/google`.
4. **Stale-announcement caveat:** the old `central.oslim.dev` `16440` events
   linger on relays (nostr events aren't reliably deletable). They're harmless
   *as long as* a newer njump announcement exists for each affected email
   (Part 2). If you ever see a client try to reach `central.oslim.dev`, that's an
   email whose newest announcement is still the oslim one — fix it by
   re-announcing via njump (a replace/relogin for that email).

---

## Part 5 — Optional: make `po.oslim.dev` a real ecosystem operator

Adding it to *your* demo config uses it for your signups only. To have Jumble and
other clients use it by default, it has to go into the **shared default operator
list** — i.e. coordinate with fiatjaf to add `po.oslim.dev` to the reference admin
client's `DEFAULT_OPERATORS`, and ask other clients (mill's `POM_DEFAULT_OPERATORS`,
Jumble, etc.) to follow. That's a social/consensus step, not something you can
ship unilaterally. Until then, `po.oslim.dev` is a valid operator that only opted-in
clients use.

---

## Test checklist

1. `https://po.oslim.dev/po/recover/google` serves Google sign-in over real TLS.
2. Demo (Part 3 config) → **Continue with Google** → new email → **Create new
   key** → watch `po.oslim.dev` logs for `POST /po/register` and the account
   coming online at `auth.njump.me`. Confirm the account's operators include
   `po.oslim.dev`.
3. **Sign a note** — NIP-46 round trip through `auth.njump.me` produces a valid
   signature (threshold met across the 5 operators).
4. **Cross-client:** sign into that same email in Jumble → same npub (it reads the
   account + operator set from central/discovery).
5. **Recover** for an oslim-created account → collecting shards includes
   `po.oslim.dev`, reconstructs the key.
6. Old hosts are down and nothing in the flow tries to reach `central.oslim.dev`.
