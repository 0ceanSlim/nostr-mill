/**
 * MILL — cloudkey.js
 * Encryption for cloud-backed key storage ("log in with Google" and friends).
 *
 * Design follows wisp (github.com/barrydeen/wisp), which does this natively on
 * Android. Two factors gate the backup:
 *
 *   1. Access to the cloud account (enforced by the provider, not by us)
 *   2. A short PIN the user sets
 *
 * All the entropy comes from the PIN, which is why the KDF is deliberately
 * slow. The salt is random per blob and stored alongside the ciphertext — see
 * deriveCloudKey for why that differs from wisp.
 *
 * Be honest about the strength, because wisp's own docstring is optimistic.
 * It claims a compromised account still costs an attacker "~weeks of compute".
 * Measured against this implementation (600k PBKDF2-SHA256, ~61ms/attempt on a
 * 2026 laptop core), exhaustive search of the whole PIN space is:
 *
 *   digits   1 core      1000x parallel (PBKDF2-SHA256 is GPU-friendly)
 *   ------   ---------   ------------------------------------------------
 *   4        ~10 min     ~1 second
 *   6        ~17 hours   ~1 minute
 *   8        ~71 days    ~2 hours
 *
 * So a numeric PIN does NOT meaningfully protect the ciphertext. Raising the
 * iteration count or switching to scrypt does not rescue it either — the
 * problem is ~13-27 bits of entropy, not the KDF. The PIN's real job is to stop
 * a casual "their laptop is unlocked / their Drive is open" grab; actual
 * security rests on the cloud account and its 2FA.
 *
 * Consequences, both deliberate:
 *   - `secret` is any string, not just digits, so the UI can offer a passphrase.
 *   - The portable export path uses NIP-49 with an enforced real passphrase,
 *     because an exported file has no cloud account protecting it.
 */

import { nip44 } from 'nostr-tools';
import * as nip49 from 'nostr-tools/nip49';
import { hexToBytes } from './crypto.js';

const KDF_ITERATIONS = 600_000;      // matches wisp


const BLOB_VERSION = 'mill1';
const SALT_BYTES   = 16;

const b64 = {
  enc: bytes => btoa(String.fromCharCode(...bytes)),
  dec: str   => Uint8Array.from(atob(str), c => c.charCodeAt(0)),
};

/**
 * Derive the 32-byte wrapping key from the user's PIN and a salt. Returns a
 * Uint8Array(32) suitable for use as a NIP-44 conversation key.
 *
 * DELIBERATE DEVIATION FROM WISP: wisp derives its salt from the Google
 * account id, HMAC-SHA256("wisp-google-backup", sub). That forces the app to
 * obtain a stable account identifier before it can decrypt anything, which on
 * the web means running an ID-token flow purely to read a `sub` claim.
 *
 * A salt is not a secret — its only job is to stop precomputation being shared
 * across users. A random per-blob salt does that just as well, and NIP-49 does
 * exactly this (16 random bytes inside its own payload). Storing the salt in
 * the blob makes it self-describing, removes the ID-token dependency and the
 * extra scope, and gives each backup its own salt rather than one per account.
 */
export async function deriveCloudKey(secret, salt) {
  if (!secret) throw new Error('PIN or passphrase required');
  if (!salt || !salt.length) throw new Error('Salt required');
  const keyMat = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(String(secret)), 'PBKDF2', false, ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: KDF_ITERATIONS, hash: 'SHA-256' },
    keyMat, 256,
  );
  return new Uint8Array(bits);
}

/**
 * Encrypt a private key for cloud storage.
 *
 * NIP-44 v2 is used as a general-purpose AEAD, with the PBKDF2 output
 * substituted for the usual ECDH conversation key. That gives us
 * ChaCha20 + HMAC-SHA256 encrypt-then-MAC and a padded, versioned wire format
 * for free, rather than hand-rolling one. The plaintext is the 32-byte key as
 * hex, matching wisp so the formats stay comparable.
 */
export async function encryptCloudBlob(privHex, secret) {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const key  = await deriveCloudKey(secret, salt);
  return `${BLOB_VERSION}:${b64.enc(salt)}:${nip44.v2.encrypt(privHex, key)}`;
}

/**
 * Decrypt a cloud blob. Throws on a wrong PIN — NIP-44's MAC check fails
 * before any plaintext is produced, so a bad PIN is indistinguishable from a
 * corrupt or unrelated file, which is what callers want when scanning several
 * backups with one PIN.
 */
export async function decryptCloudBlob(blob, secret) {
  const parts = String(blob).trim().split(':');
  if (parts.length !== 3 || parts[0] !== BLOB_VERSION) {
    throw new Error('Not a mill backup');
  }
  const salt = b64.dec(parts[1]);
  const key  = await deriveCloudKey(secret, salt);
  const hex  = nip44.v2.decrypt(parts[2], key);
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error('Decrypted payload is not a private key');
  return hex.toLowerCase();
}

/**
 * Portable export for the "take control of my keys" path.
 *
 * NIP-49 (scrypt + XChaCha20-Poly1305, bech32 `ncryptsec1`) rather than our own
 * format, because the entire point of this path is that another Nostr client
 * can import it. Takes a real passphrase, not the PIN — the PIN's entropy is
 * only defensible behind the provider's access control, and an exported file
 * has no such protection.
 */
export function exportNcryptsec(privHex, passphrase, logN = 16) {
  if (!passphrase || passphrase.length < 8) {
    throw new Error('Use a passphrase of at least 8 characters for an exported key');
  }
  // 0x02 = "key security unknown"; we cannot vouch for how the user stores it.
  return nip49.encrypt(hexToBytes(privHex), passphrase, logN, 0x02);
}

export function importNcryptsec(ncryptsec, passphrase) {
  const bytes = nip49.decrypt(ncryptsec.trim(), passphrase);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}
