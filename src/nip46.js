/**
 * MILL — nip46.js
 * NIP-46 Nostr Connect client. Framework-agnostic: no DOM, no globals.
 *
 * Supports both:
 *   - bunker://<remote-pk>?relay=…&secret=…  (user pastes their bunker URI)
 *   - nostrconnect://<client-pk>?relay=…&secret=…  (we generate, user scans/pastes into bunker)
 *
 * Exposes: NIP46Client class with connect(), getPublicKey(), signEvent(),
 * nip04 / nip44 encrypt/decrypt, disconnect().
 */

import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import { nip04, nip44 } from 'nostr-tools';
import { SimplePool } from 'nostr-tools/pool';
import { bytesToHex } from './crypto.js';

// Default relays for NIP-46. Picked for: ephemeral-event support, broad reach,
// and uptime. relay.nostr.band was removed because it's primarily a search
// index and frequently rejects/drops kind 24133 messages.
export const DEFAULT_RELAYS = [
  'wss://relay.nsec.app',          // purpose-built for NIP-46 traffic
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.primal.net',
];

// Curated list users can pick from in the UI. The first entry is recommended
// as the most reliable for NIP-46 ephemeral events.
export const SUGGESTED_RELAYS = [
  'wss://relay.nsec.app',
  'wss://wheat.happytavern.co',
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://nostr.wine',
];

export function parseBunkerURI(uri) {
  const m = uri.match(/^bunker:\/\/([0-9a-f]{64})\?(.+)$/i);
  if (!m) throw new Error('Invalid bunker:// URI');
  const params = new URLSearchParams(m[2]);
  return {
    remotePubkey: m[1].toLowerCase(),
    relays: params.getAll('relay'),
    secret: params.get('secret') || '',
  };
}

export function buildNostrConnectURI({ clientPubkey, relays, secret, metadata = {}, perms }) {
  // Spec-compliant params (NIP-46): relay(s), secret, then optional name/url/
  // image and perms as discrete query params. Older mill emitted a single
  // `metadata=<json>` blob, which some signers (e.g. Amber) don't parse.
  const parts = relays.map(r => `relay=${encodeURIComponent(r)}`);
  parts.push(`secret=${secret}`);
  if (perms) parts.push(`perms=${encodeURIComponent(perms)}`);
  if (metadata.name) parts.push(`name=${encodeURIComponent(metadata.name)}`);
  if (metadata.url) parts.push(`url=${encodeURIComponent(metadata.url)}`);
  if (metadata.image) parts.push(`image=${encodeURIComponent(metadata.image)}`);
  return `nostrconnect://${clientPubkey}?${parts.join('&')}`;
}

function randomHex(bytes = 16) {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(bytes)));
}

export class NIP46Client {
  constructor({ relays = DEFAULT_RELAYS, metadata = {}, debug = false, onLog = null, onAuthChallenge = null, clientSecretKey = null } = {}) {
    this.relays = relays;
    this.metadata = metadata;
    this.debug = debug;
    this.onLog = onLog;                   // optional callback for surfacing logs in UI
    this.onAuthChallenge = onAuthChallenge; // optional: fired with the auth_url the signer asks the user to approve
    // A provided key (Uint8Array) restores a prior client identity so the
    // bunker recognizes us after a reload; otherwise generate a fresh one.
    this.clientSecretKey = clientSecretKey || generateSecretKey();
    this.clientPubkey = getPublicKey(this.clientSecretKey);
    this.remotePubkey = null;
    this.userPubkey = null;
    this.pool = null;
    this.sub = null;
    this.pending = new Map();
    this.connected = false;
    this._closed = false;
    this._eventCount = 0;
    this._publishedCount = 0;
    this._decryptFailures = 0;
  }

  _log(level, ...args) {
    const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
    if (this.debug) console[level === 'err' ? 'warn' : 'log']('[NIP-46]', ...args);
    this.onLog?.({ level, msg, ts: Date.now() });
  }

  /**
   * Outbound (mill is initiator): user paste a bunker:// URI we connect to.
   * Returns a promise that resolves with userPubkey.
   */
  async connectViaBunker(bunkerUri, { timeoutMs = 60_000 } = {}) {
    const parsed = parseBunkerURI(bunkerUri);
    this.remotePubkey = parsed.remotePubkey;
    if (parsed.relays.length) this.relays = parsed.relays;

    this._openPool();

    // Send connect request, then get_public_key
    const connectArgs = parsed.secret ? [this.remotePubkey, parsed.secret] : [this.remotePubkey];
    await this._request('connect', connectArgs, { timeoutMs });
    const pk = await this._request('get_public_key', [], { timeoutMs });
    this.userPubkey = pk;
    this.connected = true;
    return pk;
  }

  /**
   * Inbound (bunker is initiator): we display nostrconnect:// URI for user
   * to scan/paste into their bunker. Returns a promise that resolves when
   * the bunker contacts us back, with userPubkey.
   *
   * onURI callback fires once with the URI (so caller can render QR).
   */
  async connectAsListener({ timeoutMs = 120_000, onURI } = {}) {
    const secret = randomHex(16);
    const uri = buildNostrConnectURI({
      clientPubkey: this.clientPubkey,
      relays: this.relays,
      secret,
      metadata: this.metadata,
      // Pre-request the perms we actually use so the signer can authorize them
      // up front instead of challenging on the first sign.
      perms: 'sign_event,nip44_encrypt,nip44_decrypt,nip04_encrypt,nip04_decrypt',
    });
    onURI?.(uri);

    this._openPool();

    // Wait for first inbound 24133 event from any pubkey, then validate secret.
    const remotePubkey = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('NIP-46 connection timed out')), timeoutMs);
      this._connectListener = { resolve: pk => { clearTimeout(timer); resolve(pk); }, reject: e => { clearTimeout(timer); reject(e); }, secret };
    });

    this.remotePubkey = remotePubkey;
    // Discover the user pubkey. Most signers answer get_public_key (the user
    // key MAY differ from the remote-signer key, so we must ask). But some —
    // notably Amber in the nostrconnect flow — never reply: the connect
    // message's author IS the user key. Try get_public_key, and fall back to
    // the connect author so those signers still connect instead of hanging.
    try {
      this.userPubkey = await this._request('get_public_key', [], { timeoutMs: 15_000 });
    } catch (e) {
      this._log('info', `get_public_key unanswered (${e.message}); using connect author ${remotePubkey.slice(0, 8)}… as the user pubkey`);
      this.userPubkey = remotePubkey;
    }
    this.connected = true;
    return this.userPubkey;
  }

  /**
   * Restore a previously-established session after a page reload. The bunker
   * already authorized our client pubkey during the original pairing, so we
   * only need to re-open the relay subscription — no new connect handshake.
   * Construct the client with the persisted `clientSecretKey` first, then call
   * this with the saved remote pubkey / relays / user pubkey.
   *
   * If the bunker has since forgotten the client, the first signEvent will
   * time out and the caller should fall back to a fresh pairing.
   */
  async restore({ remotePubkey, relays, userPubkey } = {}) {
    if (!remotePubkey) throw new Error('restore requires remotePubkey');
    this.remotePubkey = remotePubkey;
    if (Array.isArray(relays) && relays.length) this.relays = relays;
    this.userPubkey = userPubkey || null;
    this._closed = false;
    this._openPool();
    this.connected = true;
    this._log('info', `Restored NIP-46 session for ${this.clientPubkey.slice(0, 8)}… → ${remotePubkey.slice(0, 8)}…`);
    return this.userPubkey;
  }

  async getPublicKey() {
    if (this.userPubkey) return this.userPubkey;
    return this._request('get_public_key', []);
  }

  async signEvent(event) {
    const result = await this._request('sign_event', [JSON.stringify(event)]);
    return typeof result === 'string' ? JSON.parse(result) : result;
  }

  async nip04Encrypt(thirdPartyPubkey, plaintext) {
    return this._request('nip04_encrypt', [thirdPartyPubkey, plaintext]);
  }
  async nip04Decrypt(thirdPartyPubkey, ciphertext) {
    return this._request('nip04_decrypt', [thirdPartyPubkey, ciphertext]);
  }
  async nip44Encrypt(thirdPartyPubkey, plaintext) {
    return this._request('nip44_encrypt', [thirdPartyPubkey, plaintext]);
  }
  async nip44Decrypt(thirdPartyPubkey, ciphertext) {
    return this._request('nip44_decrypt', [thirdPartyPubkey, ciphertext]);
  }

  disconnect() {
    if (this._closed) return;
    this._closed = true;
    this.connected = false;
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error('NIP-46 disconnected')); }
    this.pending.clear();
    try { this.sub?.close?.(); } catch {}
    try { this.pool?.close?.(this.relays); } catch {}
    this.pool = null;
    this.sub = null;
  }

  // ── internals ──────────────────────────────────────────────────────────────
  _openPool() {
    if (this.pool) return;
    this.pool = new SimplePool();
    this._log('info', `Subscribing to ${this.relays.length} relays:`, this.relays.join(', '));
    this._log('info', `Client pubkey: ${this.clientPubkey}`);
    // CRITICAL: SimplePool.subscribeMany takes a SINGLE filter object, not an array.
    // Passing an array silently sends a malformed REQ that all relays reject with
    // "bad req: provided filter is not an object" — mill never receives any events.
    this.sub = this.pool.subscribeMany(
      this.relays,
      { kinds: [24133], '#p': [this.clientPubkey], since: Math.floor(Date.now() / 1000) - 60 },
      {
        onevent: e => { this._eventCount++; this._log('info', `← Event ${this._eventCount} from ${e.pubkey.slice(0,8)}…`); this._onEvent(e); },
        oneose:  () => { this._log('info', 'Subscription EOSE — relays ready'); },
        onclose: (reasons) => { this._log('err', 'Subscription closed:', reasons); },
      }
    );
  }

  // Try NIP-44 v2 first, fall back to NIP-04 — older bunkers and some Amber
  // versions still use NIP-04 for kind 24133. Remember which one worked so
  // we encrypt the response with the same scheme.
  async _decrypt(senderPk, ciphertext) {
    let nip44Err = null, nip04Err = null;
    try {
      const convKey = nip44.v2.utils.getConversationKey(this.clientSecretKey, senderPk);
      const pt = nip44.v2.decrypt(ciphertext, convKey);
      this._lastEncScheme = 'nip44';
      this._log('info', '✓ Decrypted with NIP-44');
      return pt;
    } catch (e) { nip44Err = e?.message || String(e); }
    try {
      const pt = await nip04.decrypt(this.clientSecretKey, senderPk, ciphertext);
      this._lastEncScheme = 'nip04';
      this._log('info', '✓ Decrypted with NIP-04');
      return pt;
    } catch (e) { nip04Err = e?.message || String(e); }
    this._decryptFailures++;
    this._log('err', `✗ Decrypt failed (NIP-44: ${nip44Err}; NIP-04: ${nip04Err})`);
    return null;
  }

  async _encrypt(remotePk, plaintext, scheme) {
    const s = scheme || this._lastEncScheme || 'nip44';
    if (s === 'nip04') {
      return nip04.encrypt(this.clientSecretKey, remotePk, plaintext);
    }
    const convKey = nip44.v2.utils.getConversationKey(this.clientSecretKey, remotePk);
    return nip44.v2.encrypt(plaintext, convKey);
  }

  async _onEvent(event) {
    const senderPk = event.pubkey;
    const decrypted = await this._decrypt(senderPk, event.content);
    if (!decrypted) return;            // can't decrypt — ignore
    let msg;
    try { msg = JSON.parse(decrypted); } catch { return; }

    // Inbound nostrconnect:// from bunker. Different bunkers/Amber versions use
    // slightly different shapes — be permissive: accept the secret in any of
    // params[0], params[1], or result. Some bunkers also send `result: 'ack'`
    // and rely on the relay-tag pubkey for identity (we use senderPk for that).
    if (this._connectListener) {
      const sec = this._connectListener.secret;
      const secretMatches = msg.params?.[1] === sec || msg.params?.[0] === sec || msg.result === sec;
      const ackOnly = msg.result === 'ack' && !msg.method;
      this._log('info', `Candidate connect: method=${msg.method} result=${msg.result} params=${JSON.stringify(msg.params || [])} secretMatch=${secretMatches}`);
      // Accept if the secret matches anywhere — Amber sends `result: <secret>` with no method.
      // Some bunkers send `result: 'ack'` with no method. Both are valid handshake completions.
      if (secretMatches || ackOnly) {
        // Send ack back so bunker knows we accepted (only if they sent a connect request with id)
        if (msg.id) {
          try {
            const ack = JSON.stringify({ id: msg.id, result: 'ack' });
            const ackEnc = await this._encrypt(senderPk, ack);
            const ackEvent = finalizeEvent(
              { kind: 24133, created_at: Math.floor(Date.now() / 1000), tags: [['p', senderPk]], content: ackEnc },
              this.clientSecretKey
            );
            this.pool.publish(this.relays, ackEvent);
            this._log('info', `→ Sent ack to ${senderPk.slice(0,8)}…`);
          } catch (e) {
            this._log('err', `Ack publish failed: ${e?.message || e}`);
          }
        }
        const cb = this._connectListener;
        this._connectListener = null;
        cb.resolve(senderPk);
        return;
      }
    }

    // Response to one of our pending requests
    if (msg.id && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id);

      // Auth challenge (NIP-46): the signer needs the user to approve. The URL
      // lives in `error`, and the real response arrives LATER reusing the same
      // id. Surface the URL and keep waiting — do NOT reject or drop the
      // pending request. (Checked before the generic error branch because an
      // auth_url response also carries a truthy `error`.)
      if (msg.result === 'auth_url') {
        const url = msg.error || '';
        this._log('info', `Auth challenge — awaiting user approval: ${url}`);
        clearTimeout(p.timer);
        p.timer = setTimeout(() => {
          this.pending.delete(msg.id);
          p.reject(new Error('NIP-46 authorization timed out'));
        }, 120_000);
        try { this.onAuthChallenge?.(url); } catch (_) {}
        return;
      }

      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error));
      else p.resolve(msg.result);
    }
  }

  async _request(method, params, { timeoutMs = 30_000 } = {}) {
    if (!this.remotePubkey) throw new Error('NIP-46 not connected');
    if (this._closed) throw new Error('NIP-46 client closed');

    const id = randomHex(8);
    const payload = JSON.stringify({ id, method, params });
    const encrypted = await this._encrypt(this.remotePubkey, payload);

    const event = finalizeEvent(
      { kind: 24133, created_at: Math.floor(Date.now() / 1000), tags: [['p', this.remotePubkey]], content: encrypted },
      this.clientSecretKey
    );

    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`NIP-46 ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });

    // Publish to all relays, log per-relay outcome, succeed if any accept.
    const publishResults = this.pool.publish(this.relays, event);
    publishResults.forEach((p, i) => {
      Promise.resolve(p).then(
        () => { this._publishedCount++; this._log('info', `→ Published to ${this.relays[i]}`); },
        (err) => this._log('err', `✗ Publish to ${this.relays[i]} failed: ${err?.message || err}`),
      );
    });
    try {
      await Promise.any(publishResults);
      this._log('info', `→ Sent ${method} (id=${id.slice(0,4)}…) to ${this.remotePubkey.slice(0,8)}…`);
    } catch (e) {
      this.pending.delete(id);
      throw new Error('Failed to publish NIP-46 request to any relay');
    }
    return promise;
  }
}
