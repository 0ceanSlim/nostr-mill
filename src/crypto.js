/**
 * MILL — crypto.js
 * Real key encoding + AES-256-GCM session encryption.
 * Requires nostr-tools (bundled in UMD, peer dep otherwise).
 */

import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import * as nip19 from 'nostr-tools/nip19';

// ── Hex helpers ───────────────────────────────────────────────────────────────
export function hexToBytes(hex) {
  if (hex.length % 2) throw new Error('Odd-length hex');
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2)
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  return bytes;
}

export function bytesToHex(bytes) {
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
}

// ── nsec / npub via nostr-tools nip19 (checksum-validated) ────────────────────
export function nsecToHex(nsec) {
  if (/^[0-9a-f]{64}$/i.test(nsec)) return nsec.toLowerCase();
  const decoded = nip19.decode(nsec.trim());
  if (decoded.type !== 'nsec') throw new Error('Not an nsec');
  return bytesToHex(decoded.data);
}

export function npubToHex(npub) {
  if (/^[0-9a-f]{64}$/i.test(npub)) return npub.toLowerCase();
  const decoded = nip19.decode(npub.trim());
  if (decoded.type !== 'npub') throw new Error('Not an npub');
  return decoded.data;
}

export function hexToNsec(hex) { return nip19.nsecEncode(hexToBytes(hex)); }
export function hexToNpub(hex) { return nip19.npubEncode(hex); }

export function isValidNsec(v) {
  if (!v) return false;
  if (/^[0-9a-f]{64}$/i.test(v)) return true;
  try { return nip19.decode(v.trim()).type === 'nsec'; } catch { return false; }
}

export function isValidNpub(v) {
  if (!v) return false;
  if (/^[0-9a-f]{64}$/i.test(v)) return true;
  try { return nip19.decode(v.trim()).type === 'npub'; } catch { return false; }
}

export function isValidBunker(v) {
  return typeof v === 'string' && (/^bunker:\/\//.test(v) || /^nostrconnect:\/\//.test(v));
}

// ── Real keypair generation (secp256k1 via nostr-tools) ───────────────────────
export async function generateKeypair() {
  const privBytes = generateSecretKey();           // Uint8Array(32)
  const privHex   = bytesToHex(privBytes);
  const pubHex    = getPublicKey(privBytes);       // real schnorr x-only pubkey
  return {
    privBytes,
    privHex,
    pubHex,
    nsec: nip19.nsecEncode(privBytes),
    npub: nip19.npubEncode(pubHex),
  };
}

// ── AES-256-GCM session encryption for nsec at rest ───────────────────────────
async function deriveKey(password, salt) {
  const enc = new TextEncoder();
  const keyMat = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 100_000, hash: 'SHA-256' },
    keyMat, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
  );
}

export async function encryptNsec(nsecHex, password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv   = crypto.getRandomValues(new Uint8Array(12));
  const key  = await deriveKey(password, salt);
  const ct   = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, key, new TextEncoder().encode(nsecHex)
  );
  const out = new Uint8Array(16 + 12 + ct.byteLength);
  out.set(salt, 0); out.set(iv, 16); out.set(new Uint8Array(ct), 28);
  return btoa(String.fromCharCode(...out));
}

export async function decryptNsec(b64, password) {
  const raw  = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  const salt = raw.slice(0, 16);
  const iv   = raw.slice(16, 28);
  const ct   = raw.slice(28);
  const key  = await deriveKey(password, salt);
  const pt   = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  return new TextDecoder().decode(pt);
}

const STORAGE_KEY = 'mill:nsec:enc';
export function storeEncryptedNsec(encrypted) { sessionStorage.setItem(STORAGE_KEY, encrypted); }
export function loadEncryptedNsec()           { return sessionStorage.getItem(STORAGE_KEY); }
export function clearStoredNsec()             { sessionStorage.removeItem(STORAGE_KEY); }

// ── Restore state (sessionStorage; wiped on tab close, same as the nsec blob) ──
//
// Persisted at login so MILL.restore() can rebuild a signer after a page reload
// without re-opening the picker. Nothing here is the user's private key:
//   - perms: the private-key signing-permission map (user's choices)
//   - bunker: the NIP-46 client identity + remote pubkey/relays. The client
//     secret is mill's own connection key, NOT the user's nsec, so persisting
//     it only lets us re-present the same already-authorized client to the
//     bunker. The user's key never leaves their bunker.

const PERMS_KEY = 'mill:perms';
export function storeSignPerms(perms) { sessionStorage.setItem(PERMS_KEY, JSON.stringify(perms)); }
export function loadSignPerms()       { const s = sessionStorage.getItem(PERMS_KEY); try { return s ? JSON.parse(s) : null; } catch { return null; } }
export function clearSignPerms()      { sessionStorage.removeItem(PERMS_KEY); }

const BUNKER_KEY = 'mill:nip46:state';
export function storeBunkerState(state) { sessionStorage.setItem(BUNKER_KEY, JSON.stringify(state)); }
export function loadBunkerState()       { const s = sessionStorage.getItem(BUNKER_KEY); try { return s ? JSON.parse(s) : null; } catch { return null; } }
export function clearBunkerState()      { sessionStorage.removeItem(BUNKER_KEY); }
