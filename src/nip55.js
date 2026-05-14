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
if (typeof window !== 'undefined' && typeof localStorage !== 'undefined') {
  try {
    const sp = new URL(window.location.href).searchParams;
    const event = sp.get('event');
    const error = sp.get('error');
    if (event || error) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ event, error, ts: Date.now() }));
      // Notify any opener (cross-window callback flow)
      if (window.opener) {
        try { window.opener.postMessage({ amberEvent: event, amberError: error }, '*'); } catch {}
      }
      // Clean URL so a refresh doesn't keep re-firing
      try {
        const url = new URL(window.location.href);
        url.searchParams.delete('event');
        url.searchParams.delete('error');
        history.replaceState(null, '', url.pathname + (url.search ? url.search : '') + url.hash);
      } catch {}
    }
  } catch {}
}

export function buildAmberURL({
  type = 'get_public_key',
  callbackUrl,
  appName = 'Nostr App',
  pubkey,
  eventJson,
  permissions,
}) {
  const params = new URLSearchParams();
  params.set('compressionType', 'none');
  params.set('returnType', 'signature');
  params.set('type', type);
  if (callbackUrl) params.set('callbackUrl', callbackUrl);
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
        const sp = new URL(window.location.href).searchParams;
        const event = sp.get('event');
        const error = sp.get('error');
        if (error) finish(reject, new Error(error));
        else if (event) finish(resolve, event);
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

    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('focus', onFocus);
    window.addEventListener('message', onMsg);
    window.addEventListener('storage', onStorage);
    const poll = setInterval(checkStorage, 1500);
    const timer = setTimeout(() => finish(reject, new Error('Amber callback timed out')), timeoutMs);

    function cleanup() {
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('message', onMsg);
      window.removeEventListener('storage', onStorage);
      clearInterval(poll);
      clearTimeout(timer);
    }

    // Initial check in case we're already on the callback URL
    setTimeout(() => { checkURL(); checkStorage(); }, 100);
  });
}

/**
 * Helper for the host app's callback page:
 * call this once at the top of the callback route to forward the result.
 * Pass autoClose: true to close the popup after writing.
 */
export function deliverAmberCallback({ autoClose = false } = {}) {
  try {
    const sp = new URL(window.location.href).searchParams;
    const event = sp.get('event');
    const error = sp.get('error');
    if (event || error) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ event, error }));
      if (window.opener) {
        try { window.opener.postMessage({ amberEvent: event, amberError: error }, '*'); } catch {}
      }
      if (autoClose) setTimeout(() => window.close(), 200);
    }
  } catch {}
}
