/**
 * MILL — pomade.js
 * Client half of "sign in with email", backed by @pomade/core.
 *
 * Pomade splits the user's secret key into FROST shares held by independent
 * signer services. Signing is a two-round protocol against a threshold of them
 * and the key is never reassembled, so the user gets an ordinary email +
 * password login without any single party holding their identity. It sits
 * beside "Continue with Google" as an onboarding path, and like that one it
 * hands the real key back on request.
 *
 * WHY @pomade/core IS NOT BUNDLED
 * It pulls in FROST (@frostr/bifrost), the welshman stack, a wasm argon2 and
 * zod — an order of magnitude more code than mill itself — and most hosts never
 * turn this method on. So it stays a runtime dependency the host supplies,
 * exactly as the OAuth shim gates Continue-with-Google: hosts that don't
 * configure it see no change to the picker and ship no extra bytes.
 *
 * Three ways to supply it, checked in this order:
 *   1. pomade: { module: import('@pomade/core') }   — bundler hosts
 *   2. window.PomadeCore                            — script-tag hosts
 *   3. pomade: { moduleUrl: 'https://…/index.js' }  — runtime dynamic import
 */

// ── Host configuration ────────────────────────────────────────────────────────
// The module reference can't travel through an element attribute, so unlike
// oauth-shim this config lives in module scope. Signer URLs are mirrored onto
// the `pomade-signers` attribute so the picker can gate on them the same way.
const config = {
  module:      null,   // module namespace, a promise for one, or a thunk returning either
  moduleUrl:   '',     // absolute URL, imported at runtime when no module was passed
  signerUrls:  [],     // pomade signer services
  argonWorker: null,   // worker module/promise for context.setArgonWorker
  threshold:   0,      // 0 → derived from the signer count
  total:       0,      // 0 → every configured signer
  debug:       false,
};

const asList = v => (Array.isArray(v) ? v : String(v || '').split(','))
  .map(s => String(s).trim().replace(/\/+$/, ''))
  .filter(Boolean);

export function configurePomade(cfg = {}) {
  if (cfg.module     !== undefined) config.module      = cfg.module;
  if (cfg.moduleUrl  !== undefined) config.moduleUrl   = cfg.moduleUrl;
  if (cfg.argonWorker!== undefined) config.argonWorker = cfg.argonWorker;
  if (cfg.signerUrls !== undefined) config.signerUrls  = asList(cfg.signerUrls);
  if (cfg.signers    !== undefined) config.signerUrls  = asList(cfg.signers);
  if (cfg.threshold  !== undefined) config.threshold   = Number(cfg.threshold) || 0;
  if (cfg.total      !== undefined) config.total       = Number(cfg.total) || 0;
  if (cfg.debug      !== undefined) config.debug       = !!cfg.debug;
  return config;
}

/** Signer URLs from MILL.open({ pomade }) or the `pomade-signers` attribute. */
export function pomadeSignerUrls(host) {
  if (config.signerUrls.length) return config.signerUrls;
  return asList(host?.getAttribute?.('pomade-signers') || '');
}

/**
 * Whether to offer the method at all. Signer URLs are the meaningful signal:
 * without them there is nothing to talk to. A missing module is a
 * misconfiguration the flow reports precisely, rather than a reason to
 * silently hide a method the host asked for.
 */
export function pomadeAvailable(host) {
  return pomadeSignerUrls(host).length > 0;
}

/**
 * Group shape for a new registration. Default is a 2-of-3-style two-thirds
 * threshold over every configured signer: enough redundancy that one service
 * going down doesn't lock the user out, while still requiring a majority to
 * collude before they could sign as the user.
 */
export function pomadeGroupShape(host) {
  const urls  = pomadeSignerUrls(host);
  const total = Math.min(config.total || urls.length, urls.length);
  const threshold = Math.min(
    total,
    Math.max(1, config.threshold || Math.ceil((total * 2) / 3)),
  );
  return { total, threshold };
}

// ── Module loading ────────────────────────────────────────────────────────────
let _mod = null;
let _loading = null;

const MISSING_MODULE =
  '@pomade/core is not loaded. Pass it as MILL.open({ pomade: { module: import("@pomade/core") } }), ' +
  'set window.PomadeCore, or give a pomade.moduleUrl to import at runtime.';

async function resolveModule() {
  const src = config.module
    || (typeof globalThis !== 'undefined' ? globalThis.PomadeCore : null)
    || (config.moduleUrl ? import(/* webpackIgnore: true */ /* @vite-ignore */ config.moduleUrl) : null);
  if (!src) throw new Error(MISSING_MODULE);

  const resolved = await (typeof src === 'function' ? src() : src);
  // Accept a namespace, a default export, or a { Client } bag.
  const mod = resolved?.Client ? resolved : resolved?.default;
  if (!mod?.Client) throw new Error('The value supplied for @pomade/core has no Client export.');
  return mod;
}

/**
 * Load @pomade/core and apply the host's configuration to its global context.
 * Idempotent, and a failed load is not cached so the user can retry.
 */
export async function loadPomade(host) {
  if (_mod) return _mod;
  if (!_loading) {
    _loading = (async () => {
      const urls = pomadeSignerUrls(host);
      if (!urls.length) throw new Error('No pomade signer services are configured.');
      const mod = await resolveModule();
      mod.context.setSignerUrls(urls);
      mod.context.debug = config.debug;
      // argon2id runs on the main thread by default and janks the modal for a
      // few hundred ms per hash; a worker is worth wiring up when the host can.
      if (config.argonWorker) {
        try { mod.context.setArgonWorker(config.argonWorker); } catch (_) { /* keep the main-thread impl */ }
      }
      _mod = mod;
      return mod;
    })().catch(e => { _loading = null; throw e; });
  }
  return _loading;
}

// ── Error messages ────────────────────────────────────────────────────────────
// pomade's RPC layer swallows transport errors and returns a message with no
// `res`, so "every peer answered but said no" and "nobody answered" are only
// distinguishable by looking for any response at all. Getting this right
// matters: telling someone their password is wrong when their wifi is down
// sends them off to reset a password that was fine.
//
// `preferServer` decides who writes the rest. A signer's own wording is
// actionable when it reports a policy it enforces — a weak password, a name
// already taken — and useless on the login path, where a wrong password, an
// unknown email and a rate limit all come back as "No sessions found." So
// authentication failures get our copy, and the signer's text rides along on
// the Error as `detail` for whoever is debugging.
export function pomadeFailureMessage(messages, fallback = 'Sign-in failed.', { preferServer = false } = {}) {
  const answered = (messages || []).filter(m => m?.res !== undefined);
  if (!answered.length) return 'Could not reach the signer services. Check your connection and try again.';
  if (!preferServer) return fallback;
  const stated = answered.map(m => m.res?.message).find(m => typeof m === 'string' && m.trim());
  return stated ? stated.charAt(0).toUpperCase() + stated.slice(1) : fallback;
}

/** The signers' own wording, for `Error.detail` — never shown as the message. */
function serverDetail(messages) {
  return (messages || []).map(m => m?.res?.message).filter(Boolean).join(' · ') || undefined;
}

function failure(messages, fallback, opts) {
  const err = new Error(pomadeFailureMessage(messages, fallback, opts));
  err.detail = serverDetail(messages);
  return err;
}

const reachedCount = messages => (messages || []).filter(m => m?.res !== undefined).length;

// ── Flow steps ────────────────────────────────────────────────────────────────
// Each returns plain data or throws an Error whose message is safe to show.

/** Step 1 of sign-in: email + password. Returns the accounts held for them. */
export async function pomadeLogin(host, { email, password }) {
  const { Client } = await loadPomade(host);
  const { ok, options, messages, clientSecret } = await Client.loginWithPassword(email, password);
  if (!ok || !options.length) {
    throw failure(messages, 'That email and password did not match an account.');
  }
  return { options, clientSecret };
}

/**
 * Ask signers to email one-time codes. Each signer issues its own code carrying
 * a two-digit routing prefix, so the user gets one email PER SIGNER and has to
 * enter all of them — that's the price of no single service being able to log
 * them in alone.
 *
 * Two things about /challenge that the return value does not admit to:
 *
 *   1. It ALWAYS answers ok, whether it emailed anything or not. That is on
 *      purpose — an endpoint that reported "no account here" would let anyone
 *      test addresses for membership. So the aggregate `ok` only ever reflects
 *      transport, and treating a false as "wrong email address" is wrong twice
 *      over: it blames the user for a signer being down, and it blocks them
 *      from codes the reachable signers already sent.
 *   2. It does not filter the peer list. A session's peers array is padded
 *      with empty slots for signers that didn't answer at login, and an empty
 *      URL posts to the host app's own origin, burns a routing prefix, and
 *      drags the aggregate to false.
 *
 * Hence: filter, and report nothing about delivery. The caller's UI has to be
 * written the same way — "if that address has an account, codes are on their
 * way" — because that is genuinely all anyone knows.
 */
export async function pomadeRequestCodes(host, { email, peers }) {
  const { Client } = await loadPomade(host);
  const targets = (peers || []).filter(Boolean);
  const { peersByPrefix } = targets.length
    ? await Client.requestChallenge(email, targets)
    : await Client.requestChallenge(email);
  return peersByPrefix;
}

/** Step 1 of sign-in, code variant. */
export async function pomadeLoginWithCodes(host, { email, peersByPrefix, otps }) {
  const { Client } = await loadPomade(host);
  const { ok, options, messages, clientSecret } = await Client.loginWithChallenge(email, peersByPrefix, otps);
  if (!ok || !options.length) {
    throw failure(messages, 'Those codes did not work. They are single-use, so request a new set.');
  }
  return { options, clientSecret };
}

/**
 * Step 2 of sign-in: bind this browser to one account. Returns the client plus
 * the ClientOptions to persist — that bundle IS the session, and rebuilding a
 * Client from it after a reload is what MILL.restore() does.
 */
export async function pomadeSelectAccount(host, { clientSecret, option }) {
  const { Client } = await loadPomade(host);
  const { ok, messages, clientOptions } = await Client.selectLogin(clientSecret, option.client, option.peers);
  if (!ok || !clientOptions) throw failure(messages, 'Could not open that account.');
  return { client: new Client(clientOptions), clientOptions };
}

/**
 * Create an account: split `secret` across the signers, then attach the email
 * and password that can recover it. Registration mines a small proof of work
 * per signer and argon2-hashes the password once per signer, so it is
 * deliberately slow — seconds, not milliseconds.
 */
export async function pomadeRegister(host, { secret, email, password }) {
  const { Client } = await loadPomade(host);
  const { threshold, total } = pomadeGroupShape(host);
  if (total < 1) throw new Error('No pomade signer services are configured.');

  const { ok, messages, clientOptions } = await Client.register(threshold, total, secret);
  if (!ok || !clientOptions) {
    throw new Error(`Could not create your account — only ${reachedCount(messages)} of ${total} signer services accepted the request.`);
  }

  const client = new Client(clientOptions);
  const setup = await client.setupRecovery(email, password);
  // Registration succeeded but recovery didn't, which would leave an account
  // nobody can ever sign back into. Fail loudly rather than hand back a session
  // that silently dies when the tab closes.
  if (!setup.ok) throw failure(setup.messages, 'Could not attach your email to the new account.', { preferServer: true });

  return { client, clientOptions };
}

/**
 * Confirm the user can actually read the email they signed up with, by
 * replaying one code through the ordinary login check. It proves delivery
 * without creating anything: /login/start only validates and reports.
 *
 * The per-message `ok` is the answer, not the aggregate one: a single peer
 * can't produce a login option when the group threshold is 2, so the roll-up
 * would report failure for a perfectly good code. Note the signer consumes the
 * challenge either way, so a retry needs a fresh code.
 */
export async function pomadeVerifyCode(host, { email, peersByPrefix, otp }) {
  const { Client } = await loadPomade(host);
  const { messages } = await Client.loginWithChallenge(email, peersByPrefix, [otp.trim()]);
  return (messages || []).some(m => m?.res?.ok);
}

/**
 * "Take control of my keys": collect enough shares to reassemble the real
 * secret key. Gated on fresh email codes rather than the live session, because
 * a session that can sign is not the same as proof of ownership.
 */
export async function pomadeRecoverSecret(host, { email, peersByPrefix, otps, clientOptions }) {
  const { Client } = await loadPomade(host);
  const start = await Client.recoverWithChallenge(email, peersByPrefix, otps);
  if (!start.ok) throw failure(start.messages, 'Those codes did not work. They are single-use, so request a new set.');

  const clientPubkey = await new Client(clientOptions).getPubkey();
  const { ok, messages, userSecret } = await Client.selectRecovery(start.clientSecret, clientPubkey, clientOptions.peers);
  if (!ok || !userSecret) throw failure(messages, 'Could not reassemble your key.', { preferServer: true });
  return userSecret;
}

/** Rebuild a Client from persisted ClientOptions (MILL.restore). */
export async function pomadeClient(host, clientOptions) {
  const { Client } = await loadPomade(host);
  return new Client(clientOptions);
}

/**
 * Retire this browser's session on the signer services, so the persisted
 * ClientOptions stop working even if a copy leaked. Best-effort: the user has
 * already logged out locally by the time this runs, and a signer that can't be
 * reached must not turn logging out into an error.
 */
export async function pomadeDeactivate(client) {
  try {
    await client.deactivateSession(await client.getPubkey(), client.peers);
    return true;
  } catch (_) {
    return false;
  }
}
