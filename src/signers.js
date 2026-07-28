/**
 * MILL — signers.js
 * Uniform signer-object factory for all 6 methods.
 * Every signer exposes:
 *   { method, pubkey, npub, canSign, getPublicKey, signEvent,
 *     nip04?: { encrypt, decrypt }, nip44?: { encrypt, decrypt },
 *     disconnect() }
 */

import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import { nip04, nip44 } from 'nostr-tools';
import { hexToBytes, hexToNpub, decryptNsec, loadEncryptedNsec, clearStoredNsec } from './crypto.js';
import { buildAmberURL, openAmberIntent, awaitAmberResult, awaitAmberClipboard, snapshotClipboard } from './nip55.js';
import { kindLabel, categoryFor } from './kinds.js';
import { grantFor, saveGrant } from './grants.js';

// ── NIP-07 (browser extension) ────────────────────────────────────────────────
export function createNIP07Signer(pubkey) {
  if (!window.nostr) throw new Error('NIP-07 extension not available');
  return {
    method: 'nip07',
    pubkey,
    npub: hexToNpub(pubkey),
    canSign: true,
    getPublicKey: () => window.nostr.getPublicKey(),
    signEvent:    (e) => window.nostr.signEvent(e),
    nip04: window.nostr.nip04 ? {
      encrypt: (pk, pt) => window.nostr.nip04.encrypt(pk, pt),
      decrypt: (pk, ct) => window.nostr.nip04.decrypt(pk, ct),
    } : undefined,
    nip44: window.nostr.nip44 ? {
      encrypt: (pk, pt) => window.nostr.nip44.encrypt(pk, pt),
      decrypt: (pk, ct) => window.nostr.nip44.decrypt(pk, ct),
    } : undefined,
    disconnect() {},
  };
}

// ── NIP-46 (remote bunker) ────────────────────────────────────────────────────
export function createNIP46Signer(client, userPubkey) {
  return {
    method: 'nip46',
    pubkey: userPubkey,
    npub: hexToNpub(userPubkey),
    canSign: true,
    getPublicKey: () => client.getPublicKey(),
    signEvent:    (e) => client.signEvent(e),
    nip04: {
      encrypt: (pk, pt) => client.nip04Encrypt(pk, pt),
      decrypt: (pk, ct) => client.nip04Decrypt(pk, ct),
    },
    nip44: {
      encrypt: (pk, pt) => client.nip44Encrypt(pk, pt),
      decrypt: (pk, ct) => client.nip44Decrypt(pk, ct),
    },
    disconnect() { client.disconnect(); },
  };
}

// ── NIP-55 (Amber) ────────────────────────────────────────────────────────────
// Each signEvent fires a fresh nostrsigner: intent and awaits the callback.
export function createNIP55Signer({ pubkey, callbackUrl, appName }) {
  async function intentRoundtrip(type, eventJson, extra = {}) {
    // No callbackUrl → Amber returns via the clipboard, which needs no host
    // route. Snapshot first so stale clipboard content isn't misread.
    const before = callbackUrl ? '' : await snapshotClipboard();
    const url = buildAmberURL({ type, callbackUrl, appName, pubkey, eventJson, ...extra });
    openAmberIntent(url);
    return callbackUrl
      ? await awaitAmberResult({ timeoutMs: 60_000 })
      : await awaitAmberClipboard({ timeoutMs: 60_000, before });
  }

  return {
    method: 'nip55',
    pubkey,
    npub: hexToNpub(pubkey),
    canSign: true,
    getPublicKey: async () => pubkey,
    signEvent: async (event) => {
      const signedJson = await intentRoundtrip('sign_event', JSON.stringify(event));
      return JSON.parse(signedJson);
    },
    nip04: {
      encrypt: (pk, pt) => intentRoundtrip('nip04_encrypt', pt, { /* Amber reads pubkey + plaintext via params; consult Amber docs */ }),
      decrypt: (pk, ct) => intentRoundtrip('nip04_decrypt', ct),
    },
    nip44: {
      encrypt: (pk, pt) => intentRoundtrip('nip44_encrypt', pt),
      decrypt: (pk, ct) => intentRoundtrip('nip44_decrypt', ct),
    },
    disconnect() {},
  };
}

// ── Private key (encrypted nsec, prompts for password per perms) ──────────────
//
// `perms` is { categoryId: 'session'|'prompt' } — the coarse pre-approval
// chosen at setup. 'session' auto-approves the category; 'prompt' shows the
// consent card, where the user can then remember an answer per kind.
// `promptPassword` is a function the host provides to ask the user for the
// session password (returns Promise<string>). MILL's modal supplies one.
// Two independent gates, deliberately not fused:
//
//   unlock  — "do we have the key?"      → password, once per session
//   consent — "do you approve THIS event?" → per-kind grant, its own lifetime
//
// Amber works this way: its biometric gate wraps the app and is time-boxed,
// and a remembered permission signs in a ContentProvider without launching an
// Activity at all — so the biometric is skipped too. Fusing the two means
// either a password per signature (which users disable immediately) or no
// review at all.
export function createPrivateKeySigner({ pubkey, perms, promptPassword, requestConsent }) {
  let cachedKey = null;        // Uint8Array(32) once unlocked for this session

  // Gate 1: unlock. The key is encrypted at rest, so the first signature after
  // a page load always costs a password — that's the cipher, not policy.
  async function unlock() {
    if (cachedKey) return cachedKey;
    const enc = loadEncryptedNsec();
    if (!enc) throw new Error('No stored nsec — login again');
    const password = await promptPassword({});
    if (!password) throw new Error('Password required');
    const hex = await decryptNsec(enc, password);
    cachedKey = hexToBytes(hex);
    return cachedKey;
  }

  // Gate 2: consent. Resolution order — an explicit per-kind grant beats the
  // coarse category policy chosen at setup, which beats asking.
  async function authorize(event, type = 'sign_event') {
    const kind  = event?.kind;
    const grant = grantFor(kind);
    if (grant === 'deny')  throw new Error(`Blocked by your permissions: ${kindLabel(event)}`);
    if (grant === 'allow') return;

    const category = categoryFor(event);
    if ((perms?.[category] ?? 'prompt') === 'session') return;   // pre-approved at setup

    // No consent handler (someone building a signer by hand) — fall back to
    // the password gate rather than silently allowing.
    if (!requestConsent) {
      const password = await promptPassword({ category, policy: 'prompt' });
      if (!password) throw new Error('Password required');
      return;
    }

    const decision = await requestConsent({ event, kind, category, type, label: kindLabel(event) });
    if (!decision?.approved) {
      if (decision?.duration) saveGrant(kind, 'deny', decision.duration);
      throw new Error(`Signing rejected: ${kindLabel(event)}`);
    }
    saveGrant(kind, 'allow', decision.duration || 'once');
  }

  // nip04/nip44 encrypt+decrypt are not sign_event; they map to the 'dms'
  // category and carry no event to review.
  async function dmKey(type) {
    await authorize({ kind: 4, tags: [] }, type);
    return unlock();
  }

  return {
    method: 'privatekey',
    pubkey,
    npub: hexToNpub(pubkey),
    canSign: true,
    getPublicKey: async () => pubkey,
    signEvent: async (event) => {
      await authorize(event);
      return finalizeEvent(event, await unlock());
    },
    nip04: {
      encrypt: async (pk, pt) => nip04.encrypt(await dmKey('nip04_encrypt'), pk, pt),
      decrypt: async (pk, ct) => nip04.decrypt(await dmKey('nip04_decrypt'), pk, ct),
    },
    nip44: {
      encrypt: async (pk, pt) => nip44.v2.encrypt(pt, nip44.v2.utils.getConversationKey(await dmKey('nip44_encrypt'), pk)),
      decrypt: async (pk, ct) => nip44.v2.decrypt(ct, nip44.v2.utils.getConversationKey(await dmKey('nip44_decrypt'), pk)),
    },
    disconnect() {
      if (cachedKey) cachedKey.fill(0);
      cachedKey = null;
      clearStoredNsec();
    },
  };
}

// ── Read-only ─────────────────────────────────────────────────────────────────
export function createReadOnlySigner(pubkey) {
  return {
    method: 'readonly',
    pubkey,
    npub: hexToNpub(pubkey),
    canSign: false,
    getPublicKey: async () => pubkey,
    signEvent: async () => { throw new Error('Read-only signer cannot sign events'); },
    disconnect() {},
  };
}

// ── window.nostr installer ────────────────────────────────────────────────────
// Optional: replace window.nostr so existing nostr-aware code Just Works.
let _previousWindowNostr = undefined;
export function installAsWindowNostr(signer) {
  if (typeof window === 'undefined') return;
  if (_previousWindowNostr === undefined) _previousWindowNostr = window.nostr;
  window.nostr = {
    getPublicKey: () => signer.getPublicKey(),
    signEvent:    (e) => signer.signEvent(e),
    nip04: signer.nip04,
    nip44: signer.nip44,
  };
}
export function uninstallWindowNostr() {
  if (typeof window === 'undefined') return;
  if (_previousWindowNostr !== undefined) {
    window.nostr = _previousWindowNostr;
    _previousWindowNostr = undefined;
  }
}
