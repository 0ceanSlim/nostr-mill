# mill 1.7.0-beta.5 — Advanced servers + fault-tolerant signup

> **Status: implemented in 1.7.0-beta.5.** Design/spec record. Server facts were
> checked against the live pomegranate servers on 2026-09-08 (see the original
> handoff). This file records what shipped and where it deviates from the spec.

## Shape

The default flow is fully defaulted and **minimal**: central `auth.njump.me`, the
four ecosystem operators, threshold by formula, `pinCentral` **true** (no
discovery redirect). The idle screen shows only *Continue with Google*, the
recover / "use a different key" links, and a collapsed **▸ Advanced** — which is
where the how-it-works explainer, the central select, the operator checklist, and
the threshold line live. Most people never open it.

If an operator is unreachable or errors **at signup/replace**, mill leaves it out
(within a floor) and says so, instead of failing the whole signup. Only
signup/replace needs every listed operator (each must store a shard); signing is
central's job (any threshold subset) and recovery works with whoever answers. An
account's operator set is fixed at signup, so a skip there is permanent — hence
the floor and the visible notice.

## Config (`MILL.open({ pomegranate: … })`)

| Option | Default | Meaning |
|---|---|---|
| `central` | `auth.njump.me` | default option in the Advanced central select |
| `operators` | `po.f7z.io, po.coracle.social, po.njump.me, po.jumble.social` | default operator checklist |
| `threshold` | `min(n, max(2, ceil(7n/12)))` | explicit value kept while `≤ n−1`, else formula |
| `pinCentral` | **`true`** | no discovery redirect/interstitial; `false` restores beta.4 behaviour |
| `centralChoices` | `[]` | extra centrals in the select |
| `operatorChoices` | `[]` | extra operators, listed **unchecked** |
| `allowCustomCentral` | `true` | `false` hides the central row |
| `allowCustomOperators` | `true` | `false` hides the operator rows (white-label) |
| `minOperators` | `3` | never create an account with fewer operators |

`pomegranate: true` = all defaults.

## Fault-tolerant signup (`signupResilient`, used by signup + replace)

1. **Pre-flight**: probe the selected operators (`probeServer`: GET `/`, CORS, 3 s
   timeout, 2xx = up). Unreachable ones are dropped and recorded.
2. **Attempt** `signup()` with the remaining set and recomputed threshold.
3. **Operator 5xx / network failure**: `DELETE /account` (clears the pending
   registration — mandatory, since the operator may have acked central before
   failing), drop that operator, **re-deal the same key** across the rest (pubkey
   unchanged), retry. Loop while `remaining ≥ minOperators`.
4. **4xx is never skipped silently** — surfaced. Central failures are never
   skipped (no central, no account). Central `401` → one re-auth + retry.
5. **Floor**: below `minOperators`, stop with a clear message.
6. **Transparency**: the created screen lists what was left out, and
   `onConnected` receives `result.pomegranate = { central, operators, threshold,
   skipped: [{ url, reason }] }`.

Also: `signupErr()` surfaces `host: status body` (e.g. `po.f7z.io: 500 failed to
save registration`), and every failure that reaches the user clears the pending
registration so **Retry** never hits the 60 s `409 registration already in
progress`.

## As implemented (deviations from the spec)

- **How-it-works + status line moved for minimalism** (per the maintainer's
  steer): the "How this works" explainer lives *inside* Advanced, not always on
  the idle screen; the `auth.njump.me · N operators, M needed` status line shows
  **only when the selection differs from defaults**, so the default view is bare.
- **Stale-shard `403` is surfaced, not an inline 3-way prompt.** The spec wanted
  `[Erase at X] / [Leave X out] / Cancel` mid-signup. Implemented: `signupResilient`
  surfaces the `403` (never silent). In the **replace** flow it routes back to
  *Erase Old Shares* ("… still holds your old share — erase it and continue"). In
  the **new-account** flow it shows `host: 403 …` and stops; to leave that operator
  out, uncheck it in **Advanced** and retry. No mid-loop erase sub-flow was built.
- **Pre-flight "left out" notice** appears on the **created** screen (and via
  `result.pomegranate.skipped`), not as a live badge on *Set Up Your Account*
  during the probe — the probe runs after the user commits, inside the "Creating…"
  step.
- Everything else (probe dots, custom central/operator inputs with
  `isValidServerURL`, threshold recompute + read-only line, floor disabling,
  `localStorage` persistence after success + Reset, `pinCentral` default flip,
  COOP `w.close()` guard) shipped as specified.

## Verified in-browser (fetch-mocked; signup/probe use fetch, not WebSocket)

- Default idle is minimal (no how-it-works, no status line); Advanced reveals the
  explainer, central select, 4 operator checkboxes + dots, `Any 3 of the 4 …`.
- Unchecking recomputes the threshold and shows the status line; below 3 the
  primary button disables with the floor message.
- Operator 500 on `/po/register` → one `DELETE`, drop, re-deal, retry succeeds;
  created screen lists `po.f7z.io (server error 500)`; two central `/register`
  calls; the failing operator excluded from the final set.
- Pre-flight down operator (probe non-2xx) → dropped up front, "not responding",
  not registered.
- Clean at 320 px; console clean apart from the (mocked) dead announcement relay.

## Upstream notes for fiatjaf (outside mill)

- Operators should persist the shard **before** acking central (or ack with a
  rollback); today a save failure after the ack can leave central with an
  operational account missing a shard.
- `po.f7z.io` / `po.jumble.social` run a pre-`db8df07` build: no different-pubkey
  protection, no email normalisation; f7z answered `500` on `/po/register` on
  2026-09-08 (its only 500 path is the DB save).
