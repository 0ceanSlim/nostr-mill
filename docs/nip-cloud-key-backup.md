# NIP-XX (draft): Cloud-Account Key Backup

`draft` `optional`

Portable, cross-client backup and recovery of a Nostr secret key, anchored to a
third-party cloud account (e.g. "Sign in with Google") and protected by a
passphrase. A user who creates their key in one client can sign into any other
client that implements this NIP, with the same cloud account and passphrase, and
recover the same key.

## Motivation

Onboarding non-technical users to Nostr is hard because the private key is the
account, and there is no reset. Several clients have independently built "sign in
with Google" flows that stash an encrypted key in the user's cloud storage — but
each is a silo. In particular, Google Drive's `appDataFolder` is scoped **per
OAuth client**: two different apps accessing the same user's Drive get separate,
mutually invisible folders ([Google Drive docs](https://developers.google.com/drive/api/guides/appdata)).
So a key created in app A is unreachable from app B, even with the same Google
account. The result is that "log in with Google" means a *different* Nostr
identity in every app — the opposite of what users expect.

This NIP defines a storage-and-encryption convention that is **not** tied to any
one provider's storage. It publishes the encrypted key to **relays** — the one
shared, permissionless medium Nostr already has — at an address **derived from
the cloud account and the passphrase**, so any implementing client can find and
decrypt it. The cloud account supplies a stable per-user *salt* and a familiar
login; the passphrase supplies the actual security.

This is a convenience-grade custody layer, not a replacement for a user saving
their `nsec` or `ncryptsec`. See [Security considerations](#security-considerations).

## Terminology

- **Provider**: an OpenID Connect identity provider, identified by a lowercase
  ASCII label (`google`, ...).
- **Account subject** (`sub`): the provider's stable, unique identifier for the
  user. It **MUST** be globally stable across OAuth clients — i.e. every app that
  authenticates the same user receives the same `sub`. Google satisfies this
  ([OIDC docs](https://developers.google.com/identity/openid-connect/openid-connect),
  [cross-client identity](https://developers.google.com/identity/protocols/oauth2/cross-client-identity)).
  **Sign in with Apple does NOT** (its `sub` is per–developer-team) and therefore
  cannot be used with this NIP.
- **Passphrase**: a user-chosen secret, the sole cryptographic protection of the
  backup. NFKC-normalized. Implementations **MUST** require it and **SHOULD**
  enforce meaningful strength (see [Security considerations](#security-considerations)).
- **Backup identity**: a throwaway Nostr keypair, deterministically derived from
  the passphrase and account, used *only* to author and address the backup event.
  It is never the user's real identity key.

## Derivation

All KDF parameters are fixed so that any client reproduces the same values.

Let `account = provider || ":" || sub` (ASCII, provider lowercased).

1. **Salt** (per-user separation; not secret):
   `salt = SHA-256( UTF8("nostr-cloud-backup:v1:" || account) )`  → 32 bytes.

2. **Root key** from the passphrase:
   `root = scrypt(passphrase = NFKC(passphrase), salt, N = 2^16, r = 8, p = 1, dkLen = 32)`.
   (Same scrypt family and default cost as [NIP-49](https://github.com/nostr-protocol/nips/blob/master/49.md).)

3. **Backup identity key**:
   `backup_seckey = SHA-256( root || UTF8("index") )`, interpreted as a 32-byte
   secp256k1 secret key (reduce mod the curve order if ≥ n; negligible
   probability). `backup_pubkey = schnorr_pubkey(backup_seckey)`.

Because `salt` includes the account, two users who choose the same passphrase
derive different backup identities. Because the passphrase is an input, nobody
can compute `backup_pubkey` — and therefore cannot even locate the backup —
without it.

## Encryption

The payload is a standard **NIP-49** `ncryptsec`, so the encrypted key is in a
format the wider ecosystem already understands:

`payload = nip49_encrypt(user_seckey, passphrase, log_n = 16, key_security_byte = 0x02)`

Using NIP-49 (rather than a bespoke format) is deliberate: it is self-describing
(carries its own salt and parameters), passphrase-based, and already implemented
across clients. This resolves the format-divergence problem that otherwise keeps
independent implementations from reading each other's blobs.

## The backup event

A **parameterized replaceable event**, authored and signed by `backup_seckey`:

```jsonc
{
  "kind": 30049,                         // PROVISIONAL — to be assigned
  "pubkey": "<backup_pubkey>",
  "content": "ncryptsec1...",            // the NIP-49 payload
  "tags": [
    ["d", "<identity label>"],           // "" for the primary identity
    ["v", "1"]                           // format version
  ],
  "created_at": <unix seconds>,
  "sig": "<signed by backup_seckey>"
}
```

- Signing with the derived **backup** key — never the user's real key — is what
  keeps the event from publicly linking the cloud account to the user's `npub`.
  Implementations **MUST NOT** sign the backup event with the user's identity key.
- The `d` tag allows multiple identities under one account+passphrase; `""` is the
  default/primary. Replaceable semantics mean only the latest per `(backup_pubkey,
  kind, d)` is retained.
- No provider name or account data appears in the event.

## Relays

For two independent clients to find the same backup, they must look in the same
place. Implementations:

- **SHOULD** publish to a small set of well-known, reliable relays that accept
  writes from previously-unseen pubkeys, in addition to any relays the user
  configures. (A recommended default relay set should be maintained alongside
  this NIP.)
- **SHOULD** publish to several relays for durability, and re-publish
  periodically, because relays are under no obligation to retain events —
  especially from a fresh pubkey with no social graph, which some write policies
  reject or garbage-collect.
- **MUST** treat a missing backup as "not found" and fall back to
  create/import, since a wrong passphrase is indistinguishable from no backup
  (both yield a `backup_pubkey` with no event).

Relay durability is the weakest link; this is why the scheme is convenience-grade
and users should still keep an independent copy of their key.

## Flows

### Create / import (first backup)

1. Obtain the user's `user_seckey` (generate a new key, or import an existing one).
2. Authenticate with the provider; obtain `sub`.
3. Prompt for a passphrase (twice).
4. Derive `backup_seckey`; compute `payload = nip49_encrypt(user_seckey, passphrase)`.
5. Build the kind-`30049` event, sign with `backup_seckey`, publish to the relay set.

### Restore (returning user, any client)

1. Authenticate with the provider; obtain `sub`.
2. Prompt for the passphrase.
3. Derive `backup_seckey` → `backup_pubkey`.
4. Query relays: `{ "authors": ["<backup_pubkey>"], "kinds": [30049], "#d": ["<label>"] }`.
5. On a hit: `user_seckey = nip49_decrypt(content, passphrase)`. Done.
6. On no hit: treat as a new user (or wrong passphrase) and offer create/import.

## Test vector (derivation)

The backup-identity derivation is deterministic and reproducible across
implementations. The NIP-49 payload is **not** deterministic (NIP-49 uses a
random salt/nonce), so verify it by decrypting rather than by byte-comparison.

```
provider     = "google"
sub          = "103547991597142817347"
passphrase   = "correct horse battery staple"

salt (hex)   = 4e4554f0ea39e9544bc062e25baa87dbcdccbd0028235a086119ac0e29ffb7d9
backup_pubkey = 02d10998a61d96704a0a1f1e4d9759c3d6f95e4247d16e9ab728c4984fd244e3
```

(`salt = SHA-256("nostr-cloud-backup:v1:google:103547991597142817347")`;
`backup_pubkey` is the x-only schnorr public key of the derived backup secret.)

## Security considerations

- **The passphrase is the only real protection.** The ciphertext is public on
  relays, so anyone who obtains it can attempt an offline crack. A short numeric
  PIN (~13–27 bits) is **not** acceptable here and **MUST NOT** be used — it
  falls in seconds to minutes against a GPU. Implementations **MUST** require a
  genuine passphrase and **SHOULD** guide users toward high-entropy choices
  (e.g. multi-word). This differs from a provider-access-controlled local copy
  (e.g. Drive `appDataFolder`), where the cloud account's own auth adds
  protection a public relay cannot. NIP-49 itself warns against publishing
  encrypted keys to relays for exactly this reason; this NIP accepts that risk in
  exchange for portability, and pushes back with a mandatory passphrase.
- **Bulk harvesting.** Relays can be scraped for all kind-`30049` events,
  yielding a corpus of `ncryptsec` blobs to crack at leisure. A passphrase-derived
  address prevents *targeted* lookup (you cannot fetch a known user's blob without
  their passphrase) but not bulk collection of the kind. Passphrase entropy is the
  defense. *Optional hardening:* wrap the event with [NIP-59](https://github.com/nostr-protocol/nips/blob/master/59.md)
  so the kind is not visible in plaintext; a future version may specify this.
- **No recovery.** If the user forgets the passphrase, the backup is
  unrecoverable — the cloud account alone cannot decrypt it. Clients **MUST** be
  honest that there is no "forgot password," and **SHOULD** still offer the user
  their raw `nsec`/`ncryptsec` to keep independently.
- **Privacy / linkage.** The event is authored by the derived backup key, not the
  user's identity key, so it does not reveal that a given `npub` has a cloud
  backup, nor link the `npub` to the provider account. No provider identifier is
  stored in the event.
- **Salt is not secret.** `sub` may be known to every app the user logs into;
  its role here is per-user separation, not confidentiality. All confidentiality
  comes from the passphrase.
- **Provider requirement.** `sub` MUST be globally stable across OAuth clients or
  two clients will derive different addresses for the same user. Verify per
  provider before adding it.

## Relationship to local storage

This NIP standardizes the **cross-client** path (relay + passphrase). A client
MAY *additionally* keep a faster, more private local copy — e.g. a
PIN-encrypted blob in Google Drive `appDataFolder` — for its own users. That
local copy is an implementation detail and is explicitly **not** interoperable
(appDataFolder is per-OAuth-client). The relay event defined here is the
interoperability contract.

## Prior art

- [NIP-49](https://github.com/nostr-protocol/nips/blob/master/49.md) — the
  `ncryptsec` encrypted-key format used as the payload.
- [NIP-199 proposal](https://github.com/nostr-protocol/nips/issues/639) —
  username/password → derived, relay-stored encrypted key; the closest existing
  pattern.
- [NIP-46](https://github.com/nostr-protocol/nips/blob/master/46.md) and
  nsec.app / [noauth](https://github.com/nostrband/noauth) — remote-signer
  portability (a different trust model: the key stays on a signer).
- [NIP-59](https://github.com/nostr-protocol/nips/blob/master/59.md) — optional
  gift-wrap hardening.

## Open questions

- Final `kind` assignment (30049 is a placeholder).
- The recommended default relay set, and whether to name it in-spec or maintain
  it separately.
- Whether v2 should mandate NIP-59 gift-wrapping of the backup event.
- Multiple-identity discovery: listing a user's `d` labels without knowing them
  in advance (currently a client must know the label, defaulting to `""`).
- Optional single-KDF variant (derive the payload key from `root` via NIP-44
  instead of running scrypt twice) if the double-scrypt cost proves noticeable.
