# NIP-XX (draft): Cloud-Account Key Backup

`draft` `optional`

A **low-assurance convenience** mechanism for cross-client backup and recovery of
a Nostr secret key, anchored to a third-party cloud account (e.g. "Sign in with
Google") and protected by a strong passphrase. A user who creates their key in
one client can sign into any other client that implements this NIP — same cloud
account, same passphrase — and recover the same key.

> **This is not custody and not a recovery service.** It publishes a
> passphrase-encrypted secret key to public relays. It exists to lower the
> friction of *starting* on Nostr while preserving the option to take full
> control later. It is **not** a replacement for the user independently saving
> their `nsec`/`ncryptsec`, and clients **MUST** treat it as such (see
> [Client requirements](#client-requirements)). Read the
> [Security considerations](#security-considerations) before implementing —
> several risks are inherent to the approach and can only be disclosed, not
> engineered away.

## Motivation

Onboarding non-technical users to Nostr is hard because the private key *is* the
account and there is no reset. Several clients have independently built "sign in
with Google" flows that stash an encrypted key in the user's cloud storage — but
each is a silo. Google Drive's `appDataFolder` is scoped **per OAuth client**:
two different apps get separate, mutually invisible folders for the same user
([Google docs](https://developers.google.com/drive/api/guides/appdata)). So "log
in with Google" yields a *different* Nostr identity in every app.

This NIP uses the one shared, permissionless medium Nostr already has —
**relays** — as the rendezvous, at an address derived from the cloud account and
passphrase, so any implementing client can find and decrypt the backup. The
cloud account supplies a stable per-user *salt* and a familiar login; **all
confidentiality comes from the passphrase**, which is therefore required to be
strong.

## Terminology

- **Provider**: an OpenID Connect identity provider, lowercase ASCII (`google`).
- **Account subject** (`sub`): the provider's stable identifier for the user. It
  **MUST** be globally stable across OAuth clients (Google satisfies this;
  [Sign in with Apple does NOT](https://developer.apple.com/documentation/sign_in_with_apple)
  — its `sub` is per-team — and cannot be used).
- **Passphrase**: the sole cryptographic protection. Because the ciphertext is
  public and permanent, the passphrase **MUST** meet a real entropy floor
  (see [Passphrase](#passphrase)).
- **Backup identity**: a keypair derived from the passphrase and account, used
  *only* to author and address the backup event — never the user's real key.

## Derivation

All parameters are fixed constants so that independent clients reproduce the same
values. **These constants are frozen for the lifetime of this format version;
changing any of them is a new `kind`, not a new value here** (see
[Versioning](#versioning)).

Let `provider` be lowercased and `sub` the raw subject string.

1. **Salt** (public, per-user separation; not secret). With `US` = the ASCII unit
   separator byte `0x1F`:
   `salt = SHA-256( UTF8("nostr-cloud-key-backup" ‖ US ‖ provider ‖ US ‖ sub) )`  (32 bytes)

2. **Root** from the passphrase:
   `root = scrypt( password = NFKC(passphrase) as UTF-8, salt, N = 2^18, r = 8, p = 1, dkLen = 32 )`.
   - NFKC only. **No** trimming, **no** case-folding. The *same* normalized byte
     string MUST be used here and for the payload (step 4), or the address is
     found but decryption fails.

3. **Backup identity key** via HKDF (domain-separated):
   `backup_seckey = HKDF-SHA256( ikm = root, salt = "" (empty), info = UTF8("nostr-cloud-key-backup/identity"), L = 32 )`.
   Interpret as a secp256k1 scalar. If it is `0` or `≥ n` (curve order),
   **reject and re-derive** with `info` suffixed by an incrementing counter byte
   (probability ≈ 2^-128; specified only for determinism).
   `backup_pubkey` = the BIP-340 x-only public key.

### Why `scrypt` cost is a security parameter, not just UX

`backup_pubkey` is published in cleartext and is a deterministic function of the
passphrase, so it is an **offline passphrase-verification oracle**: an attacker
guesses a passphrase, runs the derivation, and checks for a match — no ciphertext
needed. This caps the whole scheme's strength at the *addressing* `scrypt` cost,
which — unlike the NIP-49 payload's self-describing cost — cannot be raised
later without moving every user's address. Two consequences the spec commits to:

- The addressing `scrypt` cost and the payload `log_n` are **both fixed at 18**
  and MUST be equal. Raising only the payload buys nothing (the attacker attacks
  the cheaper oracle). `N = 2^18` (256 MiB) is chosen as the highest cost broadly
  feasible in browsers and on mobile; it is above the OWASP 2^17 password-storage
  minimum but is **not** by itself sufficient against a determined attacker.
- Therefore **the passphrase entropy floor is the primary control**, not the KDF
  cost. See below.

## Passphrase

For a permanent, public, offline-crackable blob, a short passphrase is
equivalent to no protection. At `N = 2^18`, a human-chosen 8-character passphrase
(~28 bits) falls to a rented GPU cluster in minutes; a 5-word diceware phrase
(~65 bits) does not. Therefore:

- Clients **MUST** enforce a floor of **≥ 70 bits** of estimated entropy, using a
  real estimator (e.g. zxcvbn) or, preferably, by **generating** the passphrase
  for the user as **≥ 6 diceware-style words**. A raw length check is NOT
  sufficient and MUST NOT be the only gate.
- Clients **MUST** warn that the encrypted key is published publicly and can
  never be un-published, so a weak passphrase means eventual compromise as
  hardware improves.
- A numeric PIN **MUST NOT** be used for this NIP (it is acceptable only for a
  provider-access-controlled *local* copy, which is out of scope here).

## Encryption

`payload = nip49_encrypt( user_seckey, passphrase, log_n = 18, key_security_byte = 0x00 )`

- [NIP-49](https://github.com/nostr-protocol/nips/blob/master/49.md) `ncryptsec`
  is the payload so the encrypted key is a format the ecosystem already reads.
  It is self-describing (carries its own salt/nonce/log_n), so readers decrypt
  without pre-agreeing on `log_n`; verify by decrypting, not by byte comparison.
- `key_security_byte = 0x00` ("handled insecurely") is **required**: this key is
  encrypted and then published to public relays, which is exactly that
  condition. Importing clients should treat it as potentially exposed.

## The backup event

A **parameterized replaceable event** ([NIP-01](https://github.com/nostr-protocol/nips/blob/master/01.md),
range 30000–39999), authored and signed by `backup_seckey`:

```jsonc
{
  "kind": 30049,                         // PROVISIONAL — pending assignment
  "pubkey": "<backup_pubkey>",
  "content": "ncryptsec1...",            // the NIP-49 payload
  "tags": [
    ["d", "primary"],                    // identity label; "primary" for the default
    ["n", "<monotonic counter>"]         // integer, increments each write
  ],
  "created_at": <unix seconds>,
  "sig": "<signed by backup_seckey>"
}
```

- Signing with the **derived backup key**, never the user's identity key, is what
  keeps the event from publicly linking the cloud account to the user's `npub`,
  and is what makes the address unforgeable: only a holder of the passphrase can
  write or overwrite it. Clients **MUST NOT** sign with the user's real key.
- **`d` label.** The primary identity uses the literal `"primary"` — a non-empty
  value, because relay indexing of empty-string tag values is inconsistent.
  Additional identities under one account+passphrase use `d = <hex npub of that
  identity>`. Because all identities share one `backup_pubkey`, a client holding
  the passphrase enumerates them by querying `{authors:[backup_pubkey],
  kinds:[30049]}` with no `#d` filter.
- **`n` counter.** An integer that MUST increase on every write. Restoring
  clients reconcile on `n` (then `created_at`) to defeat clock-skew and
  stale-relay hazards (see [Retrieval](#retrieval)).
- No provider name, `sub`, or account data appears in the event.

## Relays

A rendezvous needs an agreed meeting point. Two facts make "just use the user's
relays / the open network" unworkable, so this NIP pins a set:

1. `backup_pubkey` is a brand-new key with no profile, no NIP-05, no follows, no
   payment — the exact profile that modern write policies (WoT gates, paid
   allowlists, anti-spam plugins) reject. Generic public relays will refuse the
   write.
2. Two independent clients must publish and read at the **same** relays or they
   never meet.

Therefore:

- This NIP defines a **pinned, versioned relay set** (bound to the `kind`).
  *Provisional for v1:* `["wss://TBD-backup-relay-1", "wss://TBD-backup-relay-2"]`
  — to be replaced with concrete, purpose-run relays before assignment. These
  relays accept `kind:30049` from any pubkey but bound abuse structurally.
- Backup relays **SHOULD** enforce: one event per `(pubkey, d)` (addressable
  semantics already bound this), a per-pubkey quota, and either a small
  [NIP-13](https://github.com/nostr-protocol/nips/blob/master/13.md) proof-of-work
  on the event or [NIP-42](https://github.com/nostr-protocol/nips/blob/master/42.md)
  AUTH as `backup_pubkey`, to price spam.
- Clients **MUST** connect over `wss://` only, and **MUST NOT** publish or fetch
  the backup on the user's identity relays or over a connection multiplexed with
  identity traffic (a relay could otherwise link `backup_pubkey` to the user's
  `npub`). Use a separate connection; jitter timing after login.
- Generic public relays are **not** a viable transport for this NIP; do not rely
  on them.

## Flows

### Create / import (first backup)

1. Obtain `user_seckey` (generate, or import an existing key).
2. Authenticate with the provider; obtain `sub`. Prompt for a passphrase meeting
   the [floor](#passphrase) (generate one by default).
3. Derive `backup_seckey`; `payload = nip49_encrypt(user_seckey, passphrase, 18, 0x00)`.
4. Build the kind-`30049` event with `n = 1`, sign with `backup_seckey`, publish
   to the pinned relay set.
5. Before treating the backup as usable, the client **MUST** have offered the
   user their raw `nsec`/`ncryptsec` (see [Client requirements](#client-requirements)).

### Restore (returning user, any client)

1. Authenticate; obtain `sub`. Prompt for the passphrase.
2. Derive `backup_seckey` → `backup_pubkey`.
3. Query **all** pinned relays: `{ "authors": ["<backup_pubkey>"], "kinds": [30049], "#d": ["<label>"] }`.
4. **Reconcile:** collect all matching events across relays; select the one with
   the highest `n`, breaking ties by highest `created_at`, then lowest event id
   (NIP-01). A single relay's response is not authoritative.
5. On a hit: `user_seckey = nip49_decrypt(content, passphrase)`.
6. On **no** hit, the client **MUST NOT** silently create a new identity. It MUST
   distinguish (a) *relay unreachable* — a quorum of the pinned relays did not
   respond → surface "couldn't verify, retry", never new-key; from (b)
   *authoritatively absent* — quorum responded, no event → this may be a first-time
   user **or a mistyped passphrase**, which are indistinguishable, so the client
   MUST require an explicit, informed confirmation ("If you have used this Google
   account before, your passphrase is mistyped. Only continue to create a NEW
   account if this is genuinely your first time.") before generating a key.

## Versioning

The [derivation](#derivation) constants (salt string, `scrypt` params, HKDF
`info`) are **frozen**. Any incompatible change MUST use a **new `kind`**, so
distinct formats occupy distinct addresses and cannot silently clobber each
other. The `n` tag is a per-record counter, not a format version. Do **not**
put a format version inside the salt (it would fork every address on a bump).

## Security considerations

### Inherent — disclose, cannot be fixed

- **Permanent public honeypot.** Every backup is a passphrase-encrypted secret
  key, public and immutable on relays, scrapable into a corpus that is attacked
  offline forever, with compute only getting cheaper. Each crack is a full,
  irreversible account takeover plus retroactive DM decryption. NIP-49 explicitly
  warns against publishing `ncryptsec` to relays for this reason. This NIP accepts
  that risk in exchange for permissionless portability and pushes back only with
  a mandatory strong passphrase — which is **unenforceable at the protocol level**
  (one non-compliant client permanently poisons the corpus). Implementers who are
  unwilling to accept a public corpus should use a provider-access-controlled
  store instead (which sacrifices cross-client interop — the tradeoff is real and
  unavoidable).
- **Irrevocable; rotation ≠ revocation.** You cannot un-publish. Changing the
  passphrase orphans the old blob at its old address (still crackable under the
  old passphrase); rotating the key while keeping the passphrase reuses the
  address but old ciphertext may linger on non-compliant relays. A passphrase or
  key change MUST be treated as: the previously-published key is potentially
  compromised.
- **Best-effort durability.** Relays may drop events, especially from
  graphless pubkeys — exactly the returning/inactive user this feature targets.
  Clients MUST NOT claim "safely backed up". See [Client requirements](#client-requirements).
- **No recovery, no lockout.** Forgotten passphrase = permanent loss. There is no
  rate-limiting (offline against the corpus; unmetered online against relays).
  "Sign in with Google" normally implies recoverability and lockout; here Google
  is only a lookup salt. This gap MUST be disclosed prominently.

### Threat model

- **Google account compromise alone ≠ key compromise** — but only because the
  passphrase is needed to both locate and decrypt. This is a real property, and it
  reduces to passphrase entropy: an attacker who learns the victim's `sub` (which
  every app the user authorizes receives) can grind passphrases offline and
  precompute against the known per-user salt. State this property *with* the
  caveat; do not imply passphrase-derived addressing adds anti-targeting strength
  beyond entropy.
- **Malicious client** sees the passphrase, `sub`, and `user_seckey` in the clear
  — total compromise, inherent. This NIP additionally trains users to type a
  key-protecting passphrase into many clients (a larger phishing surface than an
  `nsec`, which users are told never to paste) and lets a client that captured the
  passphrase once overwrite the backup later. Clients SHOULD present a provenance
  story; users SHOULD be warned to enter the passphrase only into trusted clients.
- **Malicious relay** cannot forge signatures (so cannot overwrite/poison without
  the passphrase) but can omit or serve a stale version — mitigated by the `n`
  counter and cross-relay reconciliation, not eliminated.

### Privacy

The backup event is authored by the derived key, so it does not link the `npub`
to the provider account *in content*. That protection is defeated if backup and
identity traffic share a relay/connection — hence the [relay](#relays) isolation
requirements. `d` labels other than `"primary"` are hex npubs (opaque); do not
use human-meaningful labels, which leak in cleartext. Note that anyone querying
learns `backup_pubkey ↔ their own IP`; and a lone kind-30049 from a graphless
pubkey on the pinned relays self-identifies as a backup user.

## Client requirements

A conforming client:

- **MUST** offer the user their raw `nsec`/`ncryptsec` and confirm they have
  saved it, before presenting this backup as usable. This is the escape hatch
  that makes best-effort durability acceptable.
- **MUST NOT** describe this as durable, guaranteed, or "safely backed up", and
  **MUST NOT** present Google as a recovery method.
- **MUST NOT** silently create a new identity on a failed restore (see
  [Restore](#restore)).
- **MUST** enforce the passphrase [floor](#passphrase).
- **SHOULD** gate the feature as explicitly experimental while the `kind` and
  relay set are provisional, and plan for a format migration.

## Test vector

The backup-identity derivation is deterministic. The NIP-49 payload is **not**
(random salt/nonce) — verify it by decrypting.

```
provider      = "google"
sub           = "103547991597142817347"
passphrase    = "raven ledger cactus plume amber tunnel"     // illustrative; NOT a safe reuse

salt          = ab3b151969ba0b598b9f3caaf97d34710274a4a5590da48e8b777494c3c60199
root          = b2b42084c2ab00cf65a6caae9561b04137088dbd72c5d1639297034e46e1169d
backup_seckey = 50f4cf826d272bb1ed29b595453f1abc5d308405d2b90b828fe90379f89b4fdf
backup_pubkey = 759d333bfbe82b961dec0cf1971873d50b649ce3c8a2780aca97f6181725bf53   (x-only)
```

`salt = SHA-256("nostr-cloud-key-backup" ‖ 0x1F ‖ "google" ‖ 0x1F ‖ "103547991597142817347")`;
`root = scrypt(NFKC(passphrase), salt, N=2^18, r=8, p=1, 32)`;
`backup_seckey = HKDF-SHA256(root, "", "nostr-cloud-key-backup/identity", 32)`;
`backup_pubkey` is the x-only schnorr public key of `backup_seckey`.

## Prior art

- [NIP-49](https://github.com/nostr-protocol/nips/blob/master/49.md) — the
  `ncryptsec` payload format.
- [NIP-199 proposal](https://github.com/nostr-protocol/nips/issues/639) —
  username/password → derived, relay-stored encrypted key; closest prior pattern.
- [NIP-46](https://github.com/nostr-protocol/nips/blob/master/46.md), nsec.app /
  [noauth](https://github.com/nostrband/noauth) — remote-signer portability, a
  different (non-copy) trust model.

## Open questions

- Final `kind` assignment (30049 is provisional).
- The concrete pinned relay set, and who operates it (an open-ended,
  spam-resistant, free-hosting commitment).
- Whether a strong-secret second factor (a cloud-stored high-entropy value mixed
  into the KDF) should be offered for users who accept reduced portability, to
  remove reliance on human passphrase entropy.
- Multi-identity `d`-label canonicalization beyond "hex npub".
