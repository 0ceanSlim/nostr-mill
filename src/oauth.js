/**
 * MILL — oauth.js
 * Client half of the cloud-login popup handshake. The other half is the static
 * page in shim/mill-oauth.html, which the host deploys at a stable origin.
 *
 * Why a popup and not an in-page flow: Google validates the OAuth flow against
 * the origin running it, and drive.appdata is scoped per OAuth client. A
 * drop-in library on arbitrary host origins therefore cannot run the flow
 * itself. The shim is one fixed, registered origin that every host shares, so
 * "log in with Google" resolves to the same identity everywhere. See the shim
 * file header for the full rationale.
 *
 * This module is provider-agnostic on purpose: it knows how to open a shim and
 * receive a token by postMessage. Google specifics live in drive.js; a future
 * OneDrive/Dropbox shim would reuse this untouched.
 */

function randomNonce() {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(b).map(x => x.toString(16).padStart(2, '0')).join('');
}

/**
 * Open the OAuth shim in a popup and resolve with the access token.
 *
 * @param {string} shimUrl  Absolute URL of the deployed shim page.
 * @returns {Promise<{ accessToken: string, expiresIn?: number, scope?: string }>}
 */
export function requestCloudToken(shimUrl, { timeoutMs = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    let shimOrigin;
    try { shimOrigin = new URL(shimUrl, location.href).origin; }
    catch { reject(new Error('Invalid OAuth shim URL')); return; }

    const nonce = randomNonce();
    // Our origin and the nonce travel in the fragment, never the query — a
    // fragment is not sent to the server, so neither value lands in an access
    // log or a Referer header.
    const url = `${shimUrl}#origin=${encodeURIComponent(location.origin)}&nonce=${nonce}`;

    // A centered, modest popup reads as "sign-in window" rather than a new tab.
    const w = 460, h = 640;
    const left = Math.max(0, (screen.width  - w) / 2);
    const top  = Math.max(0, (screen.height - h) / 2);
    const popup = window.open(url, 'mill-oauth', `width=${w},height=${h},left=${left},top=${top},noopener=no`);
    if (!popup) { reject(new Error('Popup blocked. Allow popups for this site and try again.')); return; }

    let settled = false;
    const finish = (fn, val) => {
      if (settled) return;
      settled = true;
      window.removeEventListener('message', onMsg);
      clearInterval(closedTimer);
      clearTimeout(timer);
      fn(val);
    };

    const onMsg = (e) => {
      // Three independent checks: the message must come from the shim's exact
      // origin, from our popup, and carry our one-time nonce. Any token that
      // fails these is not ours.
      if (e.origin !== shimOrigin) return;
      if (e.source !== popup) return;
      const d = e.data;
      if (!d || d.source !== 'mill-oauth' || d.nonce !== nonce) return;

      if (d.ok && d.accessToken) {
        finish(resolve, { accessToken: d.accessToken, expiresIn: d.expiresIn, scope: d.scope, sub: d.sub || null });
      } else {
        finish(reject, new Error(oauthErrorMessage(d.error)));
      }
    };
    window.addEventListener('message', onMsg);

    // If the user closes the popup without finishing, don't hang forever.
    const closedTimer = setInterval(() => {
      if (popup.closed) finish(reject, new Error('Sign-in was cancelled.'));
    }, 500);

    const timer = setTimeout(() => {
      try { popup.close(); } catch {}
      finish(reject, new Error('Sign-in timed out.'));
    }, timeoutMs);
  });
}

function oauthErrorMessage(code) {
  switch (code) {
    case 'popup_failed':
    case 'popup_closed':      return 'The Google window closed before sign-in finished.';
    case 'access_denied':     return 'You declined the Google permission. Sign-in needs access to its own hidden app folder to store your key.';
    case 'no_token':          return 'Google did not return access. Please try again.';
    default:                  return code ? `Sign-in failed (${code}).` : 'Sign-in failed.';
  }
}
