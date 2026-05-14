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
import { buildAmberURL, openAmberIntent, awaitAmberResult } from './nip55.js';

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
    const url = buildAmberURL({ type, callbackUrl, appName, pubkey, eventJson, ...extra });
    openAmberIntent(url);
    const raw = await awaitAmberResult({ timeoutMs: 60_000 });
    return raw;
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
// `perms` is { categoryId: 'ask'|'session'|'always' }.
// `promptPassword` is a function the host provides to ask the user for the
// session password (returns Promise<string>). MILL's modal supplies one.
export function createPrivateKeySigner({ pubkey, perms, promptPassword }) {
  let cachedKey = null;        // Uint8Array(32) when unlocked for session
  let cachedAt  = 0;

  async function getPrivBytes(category) {
    const policy = perms?.[category] ?? 'prompt';
    // 'session' = cache after first unlock; 'prompt' = re-ask every time
    if (policy === 'session' && cachedKey) return cachedKey;

    const enc = loadEncryptedNsec();
    if (!enc) throw new Error('No stored nsec — login again');
    const password = await promptPassword({ category, policy });
    if (!password) throw new Error('Password required');
    const hex = await decryptNsec(enc, password);
    const bytes = hexToBytes(hex);
    if (policy === 'session') { cachedKey = bytes; cachedAt = Date.now(); }
    return bytes;
  }

  function categoryFor(event) {
    const k = event.kind;
    if (k === 1 || k === 6 || k === 7 || k === 16) return 'notes';
    if (k === 0) return 'profile';
    if (k === 3) return 'contacts';
    if (k === 4 || k === 14 || k === 1059) return 'dms';
    if (k === 9734) return 'zaps';
    return 'other';
  }

  return {
    method: 'privatekey',
    pubkey,
    npub: hexToNpub(pubkey),
    canSign: true,
    getPublicKey: async () => pubkey,
    signEvent: async (event) => {
      const priv = await getPrivBytes(categoryFor(event));
      return finalizeEvent(event, priv);
    },
    nip04: {
      encrypt: async (pk, pt) => nip04.encrypt(await getPrivBytes('dms'), pk, pt),
      decrypt: async (pk, ct) => nip04.decrypt(await getPrivBytes('dms'), pk, ct),
    },
    nip44: {
      encrypt: async (pk, pt) => nip44.v2.encrypt(pt, nip44.v2.utils.getConversationKey(await getPrivBytes('dms'), pk)),
      decrypt: async (pk, ct) => nip44.v2.decrypt(ct, nip44.v2.utils.getConversationKey(await getPrivBytes('dms'), pk)),
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
