# mill 1.7.0-beta.8 — drop the "Signed In" gate; don't strand on a stale central

> **Status: implemented in 1.7.0-beta.8.** Design/spec record. Two problems seen
> on the oslim.dev demo after beta.7, verified against the branch head and the
> live servers on 2026-09-08.

## A. Removed the redundant "Signed In" interstitial (returning users)

beta.7 added a full **Signed In** screen (Continue / Back) before the built-in
**Connected** screen — two screens both saying "you're signed in".

**Now:** a returning user (`pomLogin()` finds an existing account) connects
straight through to the **Connected** screen — one screen, no gate (beta.4
behaviour restored). New signups still get **Account Created** (nsec backup +
Details + Continue), which has a real job.

beta.7's goal — offer "Use a different key" only *after* Google login (so no
pre-login popup just to learn the email) — is kept differently: the **Connected**
screen carries a quiet **Use a different key** action next to "Disconnect & Switch
Account". By then the email/account is known, so it enters the replace flow
directly. It re-enters `renderPomegranateFlow` with `host._state.pomegranateReplace`
set; the flow auto-starts the replace intent synchronously inside the click, so
the Google popup isn't blocked. `proceedAt()` sign-in no longer has a `signed-in`
detour; the `signed-in` step and its helpers are gone.

## B. A stale stored central no longer strands returning visitors

Since beta.5, mill persisted the chosen servers to
`localStorage['mill:pomegranate:servers']` and let a stored value override the
host's configured `central`. When oslim renamed its central
(`central.oslim.dev` → gone), every returning visitor was pinned to the dead
name: OAuth popup and NIP-46 relay resolved to nothing and the connect spun on
the 90 s timeout.

**Fixes shipped:**
1. **Validate the stored selection on load (core).** Only restore a stored
   central if the host still offers it (it's `cfg.central` or in
   `cfg.centralChoices`); otherwise ignore it, fall back to the default, and
   rewrite storage without the stale value. Stored operators are likewise
   filtered to the currently-offered set (a removed operator can't linger as a
   checked box). This auto-invalidates old entries — no schema bump needed.
2. **Fail fast, name the relay.** `connectBunker` parses the bunker relay, drops
   the timeout to **20 s** (was 90 s), and on failure shows
   `Couldn't reach your signer relay (wss://…). It may be offline.` with the relay
   in the message and the Details log.
3. **`connecting-signer` is recoverable.** It renders the Details log live and
   has a **Cancel** (via a `connectToken` that abandons the pending attempt) that
   returns to `idle` — no more blank 90 s spinner.

## As implemented (deviations from the spec)

- **Fix B1 is synchronous** (known-offered-set check), not the spec's optional
  async reachability probe for arbitrary custom URLs. Consequence: a *custom*
  central entered via Advanced "Custom…" is used for that session but not
  re-restored across reloads (only host-offered centrals persist). This fully
  fixes the reported stranding (a renamed/removed central is dropped) without an
  async load path; a probe-restore for custom URLs can be added later if wanted.

## Verified in-browser

- Returning account → Continue with Google → **connecting-signer** directly (no
  "Signed In" screen); Connected screen shows **Use a different key** →
  replace-confirm without an extra prompt.
- Stored `central` not in `centralChoices` → dropped on load, default used,
  storage rewritten; no stale option in the select, no status line.
- `connecting-signer` shows Details (with the relay URL) and a working **Cancel**.
- Clean build; only the expected dead-relay console noise.

## Migration note for hosts

Renaming/moving a central strands returning users only on builds before this fix.
On beta.8+, stale stored centrals self-heal on next load. (If a user is stuck on
an older build, clearing `mill:pomegranate:servers`, `mill:nip46:state`, and
`mill:connected` resets them.)
