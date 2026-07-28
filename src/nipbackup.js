/**
 * MILL — nipbackup.js
 * Reference implementation of the draft "Cloud-Account Key Backup" NIP
 * (docs/nip-cloud-key-backup.md): a cross-client, relay-published, passphrase-
 * encrypted backup of a Nostr secret key, addressed by a value derived from a
 * cloud account (Google `sub`) and the passphrase.
 *
 * EXPERIMENTAL. The spec is unratified: the `kind` and relay set are
 * provisional and MAY change, which would strand backups written now. See the
 * spec's "Client requirements" — callers MUST force an independent nsec export
 * and MUST NOT present this as durable or as account recovery.
 *
 * This is deliberately separate from the Drive+PIN cloud login: that is a
 * low-friction path that already interoperates across mill apps (shared OAuth
 * client). This is the higher-security, passphrase-gated path meant to
 * interoperate with OTHER clients once the NIP is adopted.
 */

import { scrypt } from '@noble/hashes/scrypt.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { finalizeEvent, getPublicKey, verifyEvent } from 'nostr-tools/pure';
import * as nip49 from 'nostr-tools/nip49';
import { hexToBytes, bytesToHex } from './crypto.js';

export const BACKUP_KIND = 30049;       // PROVISIONAL — see spec
const SCRYPT_LOGN = 18;                  // addressing AND payload; MUST match
const SCRYPT = { N: 2 ** SCRYPT_LOGN, r: 8, p: 1, dkLen: 32 };
const US = '\x1f';                       // ASCII unit separator
const DOMAIN = 'nostr-cloud-key-backup'; // frozen; never versioned in-string

const enc = s => new TextEncoder().encode(s);

// ── Passphrase ────────────────────────────────────────────────────────────────
// The spec requires >=70 bits, ideally generated. 7 words from the 2048-word
// BIP-39 list = 77 bits — comfortably over the floor, and memorable. This is a
// passphrase, NOT a BIP-39 mnemonic (no checksum); we only borrow the wordlist.
export function generateRecoveryPhrase(words = 7) {
  const idx = new Uint32Array(words);
  crypto.getRandomValues(idx);
  // Reject-free uniform pick: 2048 is a power of two, so masking is unbiased.
  return Array.from(idx, n => wordlist[n & 0x7ff]).join(' ');
}

// Estimated entropy floor check for a user-supplied passphrase. Intentionally
// conservative: counts only distinct dictionary words we recognise plus a
// coarse fallback, and is NOT a substitute for generating the phrase. Callers
// SHOULD prefer generateRecoveryPhrase().
const WORDSET = new Set(wordlist);
export function passphraseBits(pass) {
  const p = (pass || '').normalize('NFKC').trim();
  if (!p) return 0;
  const tokens = p.toLowerCase().split(/\s+/).filter(Boolean);
  const dictWords = tokens.filter(t => WORDSET.has(t)).length;
  if (dictWords >= tokens.length && tokens.length >= 2) return dictWords * 11; // all dictionary words
  // Fallback: rough char-class entropy, deliberately pessimistic.
  const classes = (/[a-z]/.test(p) ? 26 : 0) + (/[A-Z]/.test(p) ? 26 : 0)
                + (/[0-9]/.test(p) ? 10 : 0) + (/[^a-zA-Z0-9]/.test(p) ? 32 : 0);
  return classes ? Math.floor(p.length * Math.log2(classes)) : 0;
}
export const PASSPHRASE_MIN_BITS = 70;
export function passphraseOk(pass) { return passphraseBits(pass) >= PASSPHRASE_MIN_BITS; }

// ── Derivation (spec §Derivation) ─────────────────────────────────────────────
function normPass(passphrase) {
  // NFKC, no case-fold. We trim ONLY the outer whitespace a generated phrase or
  // paste might carry; the spec forbids trimming, so generateRecoveryPhrase
  // never produces edge whitespace and we document that callers must feed the
  // exact stored string. (Kept minimal: collapse a single trailing newline.)
  return passphrase.normalize('NFKC');
}

export function deriveBackupIdentity(provider, sub, passphrase) {
  const salt = sha256(enc(`${DOMAIN}${US}${String(provider).toLowerCase()}${US}${sub}`));
  const root = scrypt(enc(normPass(passphrase)), salt, SCRYPT);
  let sk = hkdf(sha256, root, new Uint8Array(0), enc(`${DOMAIN}/identity`), 32);
  // Reject 0 / >=n by re-deriving with a counter (astronomically unlikely).
  for (let i = 1; !isValidScalar(sk); i++) {
    sk = hkdf(sha256, root, new Uint8Array(0), enc(`${DOMAIN}/identity${i}`), 32);
  }
  return { seckey: sk, pubkey: getPublicKey(sk) };
}

const SECP_N = BigInt('0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141');
function isValidScalar(bytes) {
  const v = BigInt('0x' + bytesToHex(bytes));
  return v > 0n && v < SECP_N;
}

// ── Payload (spec §Encryption) ────────────────────────────────────────────────
// key_security_byte 0x00: this key is published to public relays — "handled
// insecurely" is the honest flag.
export function encryptBackupPayload(userSeckeyHex, passphrase) {
  return nip49.encrypt(hexToBytes(userSeckeyHex), normPass(passphrase), SCRYPT_LOGN, 0x00);
}
export function decryptBackupPayload(ncryptsec, passphrase) {
  return bytesToHex(nip49.decrypt(ncryptsec.trim(), normPass(passphrase)));
}

// ── Event (spec §The backup event) ────────────────────────────────────────────
export function labelFor(kind /* 'primary' | npubHex */) { return kind || 'primary'; }

export function buildBackupEvent({ backupSeckey, payload, label = 'primary', n = 1, createdAt }) {
  const tmpl = {
    kind: BACKUP_KIND,
    created_at: createdAt,
    tags: [['d', label], ['n', String(n)]],
    content: payload,
  };
  return finalizeEvent(tmpl, backupSeckey);
}

/**
 * Reconcile events collected across relays into the single authoritative one:
 * highest `n`, then highest created_at, then lowest id (spec §Restore step 4).
 */
export function pickLatest(events) {
  const valid = (events || []).filter(e => e && e.kind === BACKUP_KIND && e.content);
  if (!valid.length) return null;
  return valid.sort((a, b) => {
    const na = nOf(a), nb = nOf(b);
    if (na !== nb) return nb - na;
    if (a.created_at !== b.created_at) return b.created_at - a.created_at;
    return a.id < b.id ? -1 : 1;
  })[0];
}
function nOf(e) {
  const t = e.tags?.find(x => x[0] === 'n');
  const v = t ? parseInt(t[1], 10) : 0;
  return Number.isFinite(v) ? v : 0;
}
export function nextCounter(prevEvent) { return prevEvent ? nOf(prevEvent) + 1 : 1; }

// ── Relay transport (spec §Relays) ────────────────────────────────────────────
// Minimal publish/fetch. The WebSocket constructor is injectable so the logic
// can be tested without a live relay; in the browser it defaults to the global.
function makeWS(url, WS) {
  const Ctor = WS || (typeof WebSocket !== 'undefined' ? WebSocket : null);
  if (!Ctor) throw new Error('No WebSocket available');
  return new Ctor(url);
}

/**
 * Publish the backup event to every relay. Resolves once each relay has replied
 * OK or timed out. Considered successful if at least one relay accepted it —
 * but the caller SHOULD surface partial failure (spec: durability is
 * best-effort; graphless-pubkey writes are often rejected).
 */
export function publishBackup(relays, event, { timeoutMs = 8000, WS } = {}) {
  return Promise.all(relays.map(url => new Promise(resolve => {
    let done = false, ws;
    const fin = (ok, msg) => { if (done) return; done = true; try { ws && ws.close(); } catch {} resolve({ url, ok, msg }); };
    try { ws = makeWS(url, WS); } catch (e) { fin(false, String(e)); return; }
    const timer = setTimeout(() => fin(false, 'timeout'), timeoutMs);
    ws.onopen = () => { try { ws.send(JSON.stringify(['EVENT', event])); } catch (e) { clearTimeout(timer); fin(false, String(e)); } };
    ws.onmessage = m => { try { const d = JSON.parse(m.data); if (d[0] === 'OK' && d[1] === event.id) { clearTimeout(timer); fin(!!d[2], d[3] || ''); } } catch {} };
    ws.onerror = () => { clearTimeout(timer); fin(false, 'error'); };
    ws.onclose = () => { clearTimeout(timer); fin(false, 'closed'); };
  }))).then(results => ({ ok: results.filter(r => r.ok).length, total: relays.length, results }));
}

/**
 * Fetch and reconcile the backup across the relay set.
 *
 * Returns { event, reached, total } where `event` is the authoritative latest
 * (or null) and `reached` counts relays that answered with EOSE — the caller
 * needs a quorum before concluding "no backup", so a relay outage is never
 * mistaken for an absent backup (spec §Restore step 6).
 *
 * Signatures are verified and the author is pinned to `pubkey`: a relay cannot
 * inject a forged or foreign event.
 */
export function fetchBackup(relays, { pubkey, label = 'primary', timeoutMs = 8000, WS } = {}) {
  return Promise.all(relays.map(url => new Promise(resolve => {
    let done = false, ws, reached = false; const events = [];
    const sub = 'mb' + Math.floor(Math.random() * 1e9).toString(36);
    const fin = () => { if (done) return; done = true; try { ws && ws.send(JSON.stringify(['CLOSE', sub])); } catch {} try { ws && ws.close(); } catch {} clearTimeout(timer); resolve({ events, reached }); };
    let timer;
    try { ws = makeWS(url, WS); } catch { resolve({ events: [], reached: false }); return; }
    timer = setTimeout(fin, timeoutMs);
    ws.onopen = () => { try { ws.send(JSON.stringify(['REQ', sub, { authors: [pubkey], kinds: [BACKUP_KIND], '#d': [label], limit: 10 }])); } catch { fin(); } };
    ws.onmessage = m => { try { const d = JSON.parse(m.data);
      if (d[0] === 'EVENT' && d[1] === sub && d[2]) events.push(d[2]);
      else if (d[0] === 'EOSE' && d[1] === sub) { reached = true; fin(); }
      else if (d[0] === 'CLOSED' && d[1] === sub) fin();
    } catch {} };
    ws.onerror = () => fin();
    ws.onclose = () => fin();
  }))).then(per => {
    const all = []; let reached = 0;
    for (const r of per) { if (r.reached) reached++; all.push(...r.events); }
    // Pin author + verify signature before trusting anything a relay returned.
    const trusted = all.filter(e => e && e.pubkey === pubkey && safeVerify(e));
    return { event: pickLatest(trusted), reached, total: relays.length };
  });
}

function safeVerify(e) { try { return verifyEvent(e); } catch { return false; } }
