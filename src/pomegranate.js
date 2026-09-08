/**
 * MILL — pomegranate.js
 * Client for fiatjaf's **pomegranate** — FROST threshold signing with "Login
 * with Google". Unlike mill's Drive+PIN or the (retired) relay-NIP, no full key
 * is ever stored: the key is generated in the browser, split into FROST shards
 * across independent operator servers, and erased. Google authenticates the
 * user to those operators; signing happens over NIP-46 through a `central`
 * coordinator. A pomegranate account is, to any client, a normal NIP-46 bunker.
 *
 * Implemented against the authoritative spec at fiatjaf.com/pomegranate
 * (README + admin reference client), pinned to the protocol as of 2026-09.
 * EXPERIMENTAL: no NIP yet; kinds/endpoints are provisional and may change.
 *
 * Requires a running `central` + `operator` servers (the host configures which).
 */

import { finalizeEvent, getPublicKey, generateSecretKey } from 'nostr-tools/pure';
import { SimplePool } from 'nostr-tools/pool';
import * as nip19 from 'nostr-tools/nip19';
import { argon2id } from '@noble/hashes/argon2.js';
import {
  trustedKeyDeal, hexPubShard, hexShard, aggregateSecretKeyShards, decodeShard,
} from '@jsr/fiatjaf__promenade-trusted-dealer';
import { bytesToHex, hexToBytes } from './crypto.js';

export const POM_KINDS = { ANNOUNCE: 16440, TOKEN: 20443, OP_REG: 20444, CENTRAL_REG: 20445 };

// Where setup-announcement (kind 16440) discovery events are published/queried.
// Must match across clients or cross-client discovery fails; mirrors the
// reference client's list. Hosts may override.
export const DEFAULT_DISCOVERY_RELAYS = [
  'wss://relay.damus.io', 'wss://relay.primal.net', 'wss://nos.lol',
  'wss://nostr.mom', 'wss://offchain.pub',
];

const ARGON = { t: 1, m: 65536, p: 4 };   // MUST match the spec exactly
const enc = new TextEncoder();

/** Normalise a server URL to its origin (http→https unless localhost). */
export function massageURL(input) {
  let url = String(input || '').trim();
  if (!url.startsWith('http')) url = 'http' + (url.startsWith('localhost') ? '' : 's') + '://' + url;
  return new URL(url).origin;
}

/**
 * The `#m` discovery tag: argon2id(email, "pomegranate", {t:1,m:65536,p:4}) hex.
 * This is how any client finds a user's setup from their Google email alone.
 */
export function discoveryTag(email) {
  return bytesToHex(argon2id(enc.encode(String(email)), 'pomegranate', ARGON));
}

// ── Token ─────────────────────────────────────────────────────────────────────
// `central`'s Google login returns a base64 kind:20443 event; the email lives in
// its `email` tag, and created_at bounds its freshness.
export function tokenEmail(token) {
  try {
    const evt = JSON.parse(atob(token));
    return evt.tags?.find(t => t[0] === 'email')?.[1] || '';
  } catch { return ''; }
}
export function tokenCreatedAt(token) {
  try { const c = JSON.parse(atob(token)).created_at; return typeof c === 'number' ? c * 1000 : null; } catch { return null; }
}

// ── OAuth popup ────────────────────────────────────────────────────────────────
// `central` (and each operator, for recovery) IS the Google OAuth handler — mill
// just opens it and receives the result by postMessage. No mill-hosted shim.
function oauthPopup(url, expectOrigin, { timeoutMs = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    let origin;
    try { origin = new URL(expectOrigin).origin; } catch { reject(new Error('Invalid server URL')); return; }
    const w = window.open(url, 'pomegranate', 'width=600,height=680');
    if (!w) { reject(new Error('Popup blocked. Allow popups for this site and try again.')); return; }
    let done = false;
    const finish = (fn, v) => { if (done) return; done = true; cleanup(); fn(v); };
    const onMsg = e => {
      if (e.origin !== origin || e.source !== w) return;
      if (e.data && typeof e.data === 'object') finish(resolve, e.data);
    };
    const closed = setInterval(() => { if (w.closed) finish(reject, new Error('Sign-in was cancelled.')); }, 500);
    const timer = setTimeout(() => { try { w.close(); } catch {} finish(reject, new Error('Sign-in timed out.')); }, timeoutMs);
    function cleanup() { window.removeEventListener('message', onMsg); clearInterval(closed); clearTimeout(timer); try { w.close(); } catch {} }
    window.addEventListener('message', onMsg);
  });
}

/** Google login against a central; resolves the auth token. */
export async function authenticate(centralURL) {
  const c = massageURL(centralURL);
  const data = await oauthPopup(`${c}/login/google`, c);
  if (!data.token) throw new Error('Sign-in did not return a token.');
  return data.token;
}

// ── central REST ────────────────────────────────────────────────────────────────
async function centralGET(centralURL, path, token) {
  const r = await fetch(massageURL(centralURL) + path, { headers: { Authorization: 'Token ' + token } });
  return r;
}
export async function getAccount(centralURL, token) {
  const r = await centralGET(centralURL, '/account', token);
  if (!r.ok) return null;   // 401/404 → no account yet
  return r.json();          // { operators, threshold, pubkey }
}
export async function getProfiles(centralURL, token) {
  const r = await centralGET(centralURL, '/profiles', token);
  if (!r.ok) throw new Error('Could not load profiles.');
  return r.json();          // [{ name, handler_pubkey }]
}
export async function createProfile(centralURL, token, name = 'default', restrictions) {
  const r = await fetch(massageURL(centralURL) + '/profiles', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Token ' + token },
    body: JSON.stringify({ name, restrictions }),
  });
  if (!r.ok) throw new Error('Could not create profile.');
}
async function ensureDefaultProfile(centralURL, token) {
  let profiles = await getProfiles(centralURL, token);
  if (!profiles.find(p => p.name === 'default')) {
    await createProfile(centralURL, token, 'default');
    profiles = await getProfiles(centralURL, token);
  }
  const def = profiles.find(p => p.name === 'default') || profiles[0];
  if (!def) throw new Error('No signing profile available.');
  return def.handler_pubkey;
}

/** bunker://<handler_pubkey>?relay=<central-as-ws> — a standard NIP-46 URI. */
export function bunkerURI(handlerPubkey, centralURL) {
  const ws = massageURL(centralURL).replace(/^http/, 'ws');
  return `bunker://${handlerPubkey}?relay=${encodeURIComponent(ws)}`;
}

// ── Discovery ────────────────────────────────────────────────────────────────
/** Find where (if anywhere) this email already set up. Returns { centralURL } or null. */
export async function discover(email, relays = DEFAULT_DISCOVERY_RELAYS) {
  if (!email) return null;
  const pool = new SimplePool();
  try {
    // Collect all matching announcements and prefer the newest: replacing the key
    // publishes a fresh 16440 while the old one lingers on relays, so a single
    // `get` could hand back the stale pointer.
    const events = await pool.querySync(relays, { kinds: [POM_KINDS.ANNOUNCE], '#m': [discoveryTag(email)] }, { maxWait: 5000 });
    if (!events || !events.length) return null;
    const evt = events.reduce((a, b) => (b.created_at > a.created_at ? b : a));
    const centralURL = evt.tags.find(t => t[0] === 'central')?.[1];
    return centralURL ? { centralURL: massageURL(centralURL), createdAt: evt.created_at } : null;
  } catch { return null; }
  finally { try { pool.close(relays); } catch {} }
}

async function publishAnnouncement(account, centralURL, secretKey, relays = DEFAULT_DISCOVERY_RELAYS) {
  const event = finalizeEvent({
    kind: POM_KINDS.ANNOUNCE,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['m', discoveryTag(account.email)],
      ['central', massageURL(centralURL)],
      ...account.operators.map(op => ['operator', massageURL(typeof op === 'string' ? op : op.url)]),
      ['threshold', String(account.threshold)],
    ],
    content: '',
  }, secretKey);
  const pool = new SimplePool();
  try { await Promise.allSettled(pool.publish(relays, event)); }
  finally { try { pool.close(relays); } catch {} }
}

// ── Login (returning / cross-client) ───────────────────────────────────────────
/**
 * Resolve an existing pomegranate account to a NIP-46 bunker URI. Returns
 * { pubkey, bunkerURI } or null if there's no account at this central.
 */
export async function loginExisting(centralURL, token) {
  const account = await getAccount(centralURL, token);
  if (!account) return null;
  const handler = await ensureDefaultProfile(centralURL, token);
  return { pubkey: account.pubkey, bunkerURI: bunkerURI(handler, centralURL) };
}

// ── Signup (create account: FROST-shard + register) ────────────────────────────
/**
 * Create a new pomegranate account. Generates a key (or uses `secretKey`),
 * FROST-shards it across `operators` with `threshold`, registers with central
 * and each operator, publishes the discovery announcement, and returns a bunker.
 * The raw nsec is returned ONCE so the caller can offer a backup, then callers
 * MUST drop it — the key is not stored anywhere after this.
 */
export async function signup({ centralURL, token, email, operators, threshold, secretKey, relays }) {
  const c = massageURL(centralURL);
  const ops = operators.map(massageURL);
  if (!(threshold >= 1 && threshold <= ops.length)) throw new Error('Invalid threshold for operator count.');
  const sk = secretKey || generateSecretKey();
  const pubkey = getPublicKey(sk);
  const session = crypto.randomUUID();

  // FROST-shard the key.
  const skBig = Array.from(sk).reduce((a, b) => (a << 8n) + BigInt(b), 0n);
  const { shards } = trustedKeyDeal(skBig, threshold, ops.length);

  // Register with central (kind 20445: threshold + public shards).
  const regEvent = finalizeEvent({
    kind: POM_KINDS.CENTRAL_REG,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['threshold', String(threshold)], ...ops.map((op, i) => ['operator', op, hexPubShard(shards[i].pubShard)])],
    content: '',
  }, sk);
  const regResp = await fetch(c + '/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Token ' + token, 'X-Pomegranate-Session': session },
    body: JSON.stringify(regEvent),
  });
  if (!regResp.ok) {
    const e = new Error('Central registration failed.');
    e.status = regResp.status;
    try { e.body = await regResp.text(); } catch {}
    throw e;
  }

  // Register the secret shard with each operator (kind 20444).
  for (let i = 0; i < ops.length; i++) {
    const opEvent = finalizeEvent({
      kind: POM_KINDS.OP_REG,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['central', c], ['email', email]],
      content: hexShard(shards[i]),
    }, sk);
    const opToken = bytesToHex(await sha256Utf8(session + ':' + ops[i]));
    const opResp = await fetch(ops[i] + '/po/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Pomegranate-Operator-Token': opToken },
      body: JSON.stringify(opEvent),
    });
    if (!opResp.ok) {
      const e = new Error(`Operator registration failed for ${ops[i]}.`);
      e.operator = ops[i];
      e.status = opResp.status;
      try { e.body = await opResp.text(); } catch {}
      throw e;
    }
  }

  // Wait for central to see the account come online.
  let account = null;
  for (let i = 0; i < 15 && !account; i++) {
    account = await getAccount(c, token);
    if (account?.pubkey === pubkey) break;
    account = null;
    await new Promise(r => setTimeout(r, 1000));
  }
  if (!account) throw new Error('Account did not come online — check the operators.');

  await publishAnnouncement({ ...account, email }, c, sk, relays);
  const handler = await ensureDefaultProfile(c, token);
  return { pubkey, bunkerURI: bunkerURI(handler, c), nsec: nip19.nsecEncode(sk) };
}

// ── Replace the key behind an account ───────────────────────────────────────────
/**
 * DELETE the pomegranate account at `central` (clears the account, its profiles
 * and handler keys, and any pending registration; existing bunker URIs stop
 * working). Idempotent — a `204` or any 2xx counts as done. Errors carry
 * `status`/`body` so a `401` can trigger one re-auth + retry by the caller.
 */
export async function deleteAccount(centralURL, token) {
  const c = massageURL(centralURL);
  const r = await fetch(c + '/account', { method: 'DELETE', headers: { Authorization: 'Token ' + token } });
  if (r.ok || r.status === 204) return true;
  const e = new Error('Could not erase the existing account.');
  e.status = r.status;
  try { e.body = await r.text(); } catch {}
  throw e;
}

/**
 * Open one operator's erase page (`/po/erase/google`). That page runs its own
 * Google OAuth and closes itself on BOTH "erase" and "cancel", sending no
 * message — so all we can observe is the window closing. Resolves then; the real
 * proof an erase happened is a later `/po/register` succeeding (a 403 means it
 * did not). Rejects only if the popup was blocked.
 */
export function erasePopup(operatorURL, { timeoutMs = 300_000 } = {}) {
  return new Promise((resolve, reject) => {
    const o = massageURL(operatorURL);
    const w = window.open(`${o}/po/erase/google`, 'pomegranate', 'width=600,height=680');
    if (!w) { reject(new Error('Popup blocked. Allow popups for this site and try again.')); return; }
    let done = false;
    const finish = () => { if (done) return; done = true; clearInterval(closed); clearTimeout(timer); resolve(); };
    const closed = setInterval(() => { if (w.closed) finish(); }, 500);
    const timer = setTimeout(() => { try { w.close(); } catch {} finish(); }, timeoutMs);
  });
}

/** True when an operator refused re-registration because its old shard wasn't erased. */
export function isShardConflict(err) {
  return !!(err && err.status === 403 && /different pubkey/i.test(err.body || ''));
}

// ── Recovery ────────────────────────────────────────────────────────────────
/** OAuth against one operator to retrieve that operator's stored shard (hex). */
export async function requestOperatorShard(operatorURL) {
  const o = massageURL(operatorURL);
  const data = await oauthPopup(`${o}/po/recover/google`, o);
  const shard = data.shard || data.token;
  if (!shard) throw new Error('Operator did not return a shard.');
  return shard;
}
/** Reconstruct the secret key from >= threshold recovered shard hexes. */
export function reconstructFromShards(shardHexes) {
  const sk = aggregateSecretKeyShards(shardHexes.map(hexToBytes).map(decodeShard));
  const skBytes = sk instanceof Uint8Array ? sk : hexToBytes(sk.toString(16).padStart(64, '0'));
  return { privHex: bytesToHex(skBytes), nsec: nip19.nsecEncode(skBytes), npub: nip19.npubEncode(getPublicKey(skBytes)) };
}

// sha256 of a utf-8 string → bytes (WebCrypto; avoids importing another hash).
async function sha256Utf8(s) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s)));
}
