/**
 * MILL — nip55.js
 * NIP-55 Android signer (Amber) intent helpers. Framework-agnostic.
 *
 * Amber returns results either as URL query params (?event=…) on the
 * configured callbackUrl, OR as a localStorage entry written by a callback
 * page. Mill exposes both: a one-shot openAmberIntent() + setupCallbackListener(),
 * and a long-lived AmberSigner that fires a fresh intent for every signEvent.
 */

const STORAGE_KEY = 'mill:amber:result';

// On script load (browser only), capture any `?event=` from the URL into
// localStorage. Amber's callback may trigger a full page reload, destroying
// the awaitAmberResult listener — this snapshot lets a freshly-loaded page
// (or a fresh awaitAmberResult call) recover the result.
// Read an Amber result from either the `#event=` fragment (what mill now asks
// for) or a legacy `?event=` query param.
function readCallbackResult(href) {
  try {
    const url = new URL(href);
    const hash = url.hash.replace(/^#/, '');
    if (/^event=/.test(hash)) {
      return { event: decodeURIComponent(hash.slice(6)), error: null, from: 'hash' };
    }
    const sp = url.searchParams;
    const event = sp.get('event');
    const error = sp.get('error');
    if (event || error) return { event, error, from: 'query' };
  } catch {}
  return null;
}

if (typeof window !== 'undefined' && typeof localStorage !== 'undefined') {
  try {
    const hit = readCallbackResult(window.location.href);
    const event = hit?.event || null;
    const error = hit?.error || null;
    if (event || error) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ event, error, ts: Date.now() }));
      // Notify any opener (cross-window callback flow)
      if (window.opener) {
        try { window.opener.postMessage({ amberEvent: event, amberError: error }, '*'); } catch {}
      }
      // Clean URL so a refresh doesn't keep re-firing. Must clear the fragment
      // too, otherwise the hash form replays on every reload.
      try {
        const url = new URL(window.location.href);
        url.searchParams.delete('event');
        url.searchParams.delete('error');
        const hash = hit?.from === 'hash' ? '' : url.hash;
        history.replaceState(null, '', url.pathname + (url.search || '') + hash);
      } catch {}
    }
  } catch {}
}

/**
 * Normalise a host-supplied callback URL for Amber's concatenation behaviour.
 *
 * Amber does NOT append a param name — it literally does
 * `callbackUrl + Uri.encode(result)`. So the URL must already end in the
 * separator + param name, or the result is glued onto the path and lost.
 *
 * We use a `#event=` fragment rather than `?event=` because Amber ≥ 6.0.0
 * fully URL-decodes the intent URI and *then* splits on `?`, which shreds any
 * query string inside the callback URL (regression in commit 18db8c3d). A
 * fragment survives both old and new parsers — and, as a bonus, never reaches
 * the host's server, so the signature stays out of access logs.
 */
export function normalizeCallbackUrl(url) {
  if (!url) return url;
  if (/[?#]event=$/.test(url)) return url;          // already correct
  const bare = url.replace(/[?#]$/, '');
  return `${bare}#event=`;
}

export function buildAmberURL({
  type = 'get_public_key',
  callbackUrl,
  appName = 'Nostr App',
  pubkey,
  eventJson,
  permissions,
  // get_public_key returns a bare hex pubkey; sign_event needs the full event
  // JSON back, which only returnType=event provides.
  returnType = type === 'sign_event' ? 'event' : 'signature',
}) {
  const params = new URLSearchParams();
  params.set('compressionType', 'none');
  params.set('returnType', returnType);
  params.set('type', type);
  // Omitting callbackUrl is deliberate and supported: Amber then copies the
  // result to the clipboard, which is how mill reads it back with no host-side
  // callback route at all. See awaitAmberClipboard().
  if (callbackUrl) params.set('callbackUrl', normalizeCallbackUrl(callbackUrl));
  if (appName)     params.set('appName', appName);
  if (pubkey)      params.set('pubKey', pubkey);
  if (permissions) params.set('permissions', JSON.stringify(permissions));

  const base = `nostrsigner:${eventJson ? encodeURIComponent(eventJson) : ''}?${params.toString()}`;
  return base;
}

export function isLocalhost() {
  if (typeof window === 'undefined') return false;
  return /^(localhost|127\.0\.0\.1|0\.0\.0\.0)$/.test(window.location.hostname);
}

/**
 * Fire-and-forget: open Amber via best available method.
 * Returns true if at least one method seemed to fire.
 */
export function openAmberIntent(url) {
  try {
    const a = document.createElement('a');
    a.href = url; a.target = '_blank'; a.rel = 'noopener';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => a.remove(), 250);
    return true;
  } catch {
    try { window.location.href = url; return true; } catch {}
    try { const w = window.open(url, '_blank'); if (w) { w.close(); return true; } } catch {}
  }
  return false;
}

/**
 * Listen for an Amber callback. Resolves with the raw `event` query param
 * (which is either a pubkey hex for get_public_key, or a signed event JSON).
 *
 * The host app must have a callback route that captures `?event=…` and either:
 *   - redirects back to the page that opened Amber (then we read URL or storage)
 *   - writes localStorage[mill:amber:result] = JSON({ event, error? })
 *
 * Or the same page is the callback (single-page setup).
 */
export function awaitAmberResult({ timeoutMs = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn, val) => { if (done) return; done = true; cleanup(); fn(val); };

    const checkURL = () => {
      try {
        const hit = readCallbackResult(window.location.href);
        if (!hit) return;
        if (hit.error) finish(reject, new Error(hit.error));
        else if (hit.event) finish(resolve, hit.event);
      } catch {}
    };

    const checkStorage = () => {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      try {
        const data = JSON.parse(raw);
        // Discard entries older than 10 minutes — stale callbacks shouldn't trigger fresh flows
        if (data.ts && Date.now() - data.ts > 10 * 60 * 1000) {
          localStorage.removeItem(STORAGE_KEY);
          return;
        }
        localStorage.removeItem(STORAGE_KEY);
        if (data.error) finish(reject, new Error(data.error));
        else if (data.event) finish(resolve, data.event);
      } catch (e) {
        localStorage.removeItem(STORAGE_KEY);
      }
    };

    const onVis    = () => { if (!document.hidden) setTimeout(() => { checkURL(); checkStorage(); }, 400); };
    const onFocus  = () => { setTimeout(() => { checkURL(); checkStorage(); }, 400); };
    const onMsg    = e => { if (e.data?.amberEvent) finish(resolve, e.data.amberEvent); };
    const onStorage = e => { if (e.key === STORAGE_KEY) checkStorage(); };
    // A `#event=` callback that lands on the page already open is a
    // same-document navigation — no reload, so only hashchange fires.
    const onHash   = () => checkURL();

    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('focus', onFocus);
    window.addEventListener('message', onMsg);
    window.addEventListener('storage', onStorage);
    window.addEventListener('hashchange', onHash);
    const poll = setInterval(() => { checkURL(); checkStorage(); }, 1500);
    const timer = setTimeout(() => finish(reject, new Error('Amber callback timed out')), timeoutMs);

    function cleanup() {
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('message', onMsg);
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('hashchange', onHash);
      clearInterval(poll);
      clearTimeout(timer);
    }

    // Initial check in case we're already on the callback URL
    setTimeout(() => { checkURL(); checkStorage(); }, 100);
  });
}

const HEX64  = /^[0-9a-f]{64}$/i;
const HEX128 = /^[0-9a-f]{128}$/i;

/** Does this clipboard string look like an Amber result rather than junk? */
function looksLikeAmberResult(s) {
  if (!s) return false;
  const t = s.trim();
  if (HEX64.test(t) || HEX128.test(t)) return true;      // pubkey / signature
  if (/^npub1[023-9ac-hj-np-z]+$/.test(t)) return true;
  if (t.startsWith('{')) {                                // signed event JSON
    try { const o = JSON.parse(t); return !!(o.sig || o.pubkey); } catch { return false; }
  }
  return false;
}

/**
 * Read an Amber result back off the clipboard.
 *
 * When no callbackUrl is supplied, Amber copies the result to the clipboard and
 * shows a toast — this is the documented no-callback behaviour and the path
 * used by applesauce and Nostria. It needs no callback route, no server, and no
 * host-app code, so it is mill's default.
 *
 * Caveats: navigator.clipboard.readText() needs a secure context and, on
 * Chromium, a clipboard-read permission grant (prompted once per origin). We
 * snapshot the clipboard before opening Amber so pre-existing content is never
 * mistaken for a result.
 */
export function awaitAmberClipboard({ timeoutMs = 60_000, before = '' } = {}) {
  return new Promise((resolve, reject) => {
    if (!navigator?.clipboard?.readText) {
      reject(new Error('Clipboard read unavailable — needs HTTPS and a supporting browser.'));
      return;
    }
    let done = false;
    const finish = (fn, val) => { if (done) return; done = true; cleanup(); fn(val); };

    const tryRead = async () => {
      if (done) return;
      try {
        const txt = (await navigator.clipboard.readText())?.trim();
        if (!txt || txt === before?.trim()) return;      // unchanged — not our result
        if (looksLikeAmberResult(txt)) finish(resolve, txt);
      } catch {
        // Permission denied or not focused yet — keep polling; the visibility
        // handler retries once the tab is actually foregrounded.
      }
    };

    // Amber returns by switching back to the browser, so foregrounding is the
    // signal. The delay lets the clipboard settle before the first read.
    const onVis   = () => { if (!document.hidden) setTimeout(tryRead, 300); };
    const onFocus = () => setTimeout(tryRead, 300);

    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('focus', onFocus);
    const poll  = setInterval(tryRead, 700);
    const timer = setTimeout(
      () => finish(reject, new Error('Timed out waiting for Amber. If you approved the request, allow clipboard access and try again.')),
      timeoutMs,
    );

    function cleanup() {
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('focus', onFocus);
      clearInterval(poll);
      clearTimeout(timer);
    }
  });
}

/** Best-effort snapshot of current clipboard text, to ignore stale content. */
export async function snapshotClipboard() {
  try { return (await navigator.clipboard.readText()) || ''; } catch { return ''; }
}

/**
 * Helper for the host app's callback page:
 * call this once at the top of the callback route to forward the result.
 * Pass autoClose: true to close the popup after writing.
 */
export function deliverAmberCallback({ autoClose = false } = {}) {
  try {
    const hit = readCallbackResult(window.location.href);
    const event = hit?.event || null;
    const error = hit?.error || null;
    if (event || error) {
      // ts included so awaitAmberResult's staleness check works on this path too
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ event, error, ts: Date.now() }));
      if (window.opener) {
        try { window.opener.postMessage({ amberEvent: event, amberError: error }, '*'); } catch {}
      }
      if (autoClose) setTimeout(() => window.close(), 200);
    }
  } catch {}
}
