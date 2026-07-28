# Setting up "Continue with Google" for a mill demo

This guide wires up the cloud-backed Google login on a live site. It has two
halves: **what a human must do in Google Cloud Console** (no automation can do
this), and **what can be done on the server** (deploy the shim, wire the demo).

Nothing here touches the published npm `latest` tag. The demo loads a pinned
**beta** build from jsDelivr.

---

## Background (why a shim exists)

Google binds an OAuth client to a registered **origin**, and the `drive.appdata`
scope is scoped **per OAuth client**. A drop-in library on arbitrary host
origins therefore cannot run the flow itself — every host would get a separate
Drive folder for the same user and fragment their identity.

The fix is one static page — `shim/mill-oauth.html` — deployed at a single
stable origin, holding one shared client id. Mill opens it in a popup and
receives the access token by `postMessage`. The shim holds **no secret**: an
OAuth client id is public by design, and the registered origin is the security
boundary.

---

## Part A — What the human must do (Google Cloud Console)

All free. No billing account required.

1. **Create or pick a project** at <https://console.cloud.google.com>.

2. **Enable the Drive API**: APIs & Services → Library → search "Google Drive
   API" → Enable.

3. **Configure the OAuth consent screen**: APIs & Services → OAuth consent
   screen.
   - User type: **External**.
   - App name, user support email, developer contact — fill in.
   - **Scopes**: add `.../auth/drive.appdata` (search "appdata"). It is
     classified **non-sensitive**, so there is **no security review** to
     publish.
   - **Publishing status**: while in **Testing**, only Google accounts you add
     under "Test users" can complete sign-in (and refresh tokens expire in 7
     days — irrelevant to this popup token flow, but the test-user gate is not).
     To let anyone sign in, click **Publish app** — no review is required for
     this scope. For a first test, either add your own account as a test user or
     publish.

4. **Create the OAuth client**: APIs & Services → Credentials → Create
   Credentials → **OAuth client ID** → Application type **Web application**.
   - **Authorized JavaScript origins**: add the exact origin that will serve the
     shim — scheme + host (+ port), **no path, no trailing slash**. Examples:
     - `https://yourdomain.com`
     - `http://localhost:8123` (for local testing)
   - **Authorized redirect URIs**: leave empty. The Google Identity Services
     token flow uses JavaScript origins only; no redirect URI is needed.
   - Create, then copy the **Client ID** (looks like
     `1234-abc.apps.googleusercontent.com`). It is public — safe to share and to
     commit into the shim. **Never** use the client *secret*; this flow does not
     need one.

**Hand the server two things:** the Client ID, and the origin(s) that will host
the demo page.

---

## Part B — What to do on the server

### 1. Get the code

```bash
git fetch origin
git checkout feat/silent-restore
git pull
```

### 2. Deploy the shim

Copy `shim/mill-oauth.html` to a path served over **HTTPS** on the origin you
registered in Part A step 4 (simplest: the same origin as the demo). Then edit
the two constants near the top of the served copy:

```js
var MILL_CLIENT_ID = '1234-abc.apps.googleusercontent.com';   // from Part A
var MILL_ALLOWED_ORIGINS = [
  'https://yourdomain.com',        // every origin whose demo may open this shim
];
```

- `MILL_CLIENT_ID` must be the client id whose Authorized JavaScript origins
  include **this page's** origin.
- `MILL_ALLOWED_ORIGINS` must include the origin of the **demo page** that opens
  the popup. Leaving it empty allows any site — do not do that in production.

### 3. Wire the demo page

Load the pinned beta from jsDelivr and pass the shim URL. In the demo's HTML:

```html
<script src="https://cdn.jsdelivr.net/npm/nostr-mill@1.6.0-beta.0/dist/mill.umd.min.js"></script>
<script>
  document.querySelector('#login-button').addEventListener('click', () => {
    MILL.open({
      appName: 'Your Demo',
      oauthShim: 'https://yourdomain.com/mill-oauth.html',   // where you deployed the shim
      onConnected: (result) => { /* result.pubkey, result.signer */ },
    });
  });
</script>
```

Pin the exact version (`@1.6.0-beta.0`) rather than `@beta`, so a later beta
can't change the demo without a deliberate edit.

> Note: the repo's own `examples/index.html` loads `../dist/mill.umd.js`
> (a local build) and does **not** set `oauthShim`. It is not the file to point
> at production. Either wire a copy as above, or serve a locally-built `dist/`
> (run `npm install && npm run build`) and add the `oauthShim` option.

### 4. Verify

- Open the demo, choose **I'm new here → Continue with Google**. With
  `oauthShim` set, the chooser appears; without it, the picker is unchanged.
- The Google popup should open, ask for `drive.appdata` permission, then close.
- First run: choose a 4-digit PIN → an account is created and a
  `mill_bk_<uuid>.bin` file appears in the Google account's hidden app-data
  folder (visible at <https://drive.google.com> → Settings → Manage apps).
- Second run (same Google account): the PIN unlocks the existing key.
- On the connected screen, **Take control of my keys** re-prompts for the PIN,
  reveals the nsec, and exports an `ncryptsec`.

---

## Common failure modes

| Symptom | Cause |
|---|---|
| Popup: "not configured yet" | `MILL_CLIENT_ID` still the placeholder in the deployed shim. |
| Popup: "This site is not authorized" | Demo origin missing from `MILL_ALLOWED_ORIGINS`. |
| Google error `redirect_uri_mismatch` / `origin_mismatch` | The shim's origin isn't in the client's **Authorized JavaScript origins**, or has a trailing slash/path. |
| Sign-in works only for you | Consent screen is in **Testing**; publish it or add the tester's account. |
| "Access blocked: … has not completed verification" | Only appears for *sensitive* scopes — `drive.appdata` is not one. If seen, an extra scope was added; remove it. |
| Popup opens then nothing | Shim not served over HTTPS (Google Identity Services needs a secure context), or the browser blocked the popup. |

## Guardrails

- Do **not** run `npm version` or `npm publish` — the beta is already published
  and `latest` must stay at 1.5.0.
- Do **not** put the client *secret* anywhere. This flow uses only the public
  client id.
- The 4-digit PIN protects against casual access, not against an attacker who
  already has the encrypted blob. The real protection is the Google account and
  its 2FA. The UI says so; keep it that way.
