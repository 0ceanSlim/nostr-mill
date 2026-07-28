# MILL — Multi-Interface Login Layer

**Zero-dependency Nostr signer UI as a Web Component.**  
Drop it into any web app with a `<script>` tag. Works with every Nostr signing method.

[![npm](https://img.shields.io/npm/v/nostr-mill)](https://www.npmjs.com/package/nostr-mill)
[![license](https://img.shields.io/npm/l/nostr-mill)](LICENSE)

---

## Supported Methods

| Method | NIP | Description |
|---|---|---|
| Browser Extension | NIP-07 | Alby, nos2x, Flamingo, Nostore |
| Remote Signer | NIP-46 | Bunker URL or QR scan |
| Android Signer | NIP-55 | Amber (via Android intents) |
| Private Key | — | nsec/hex, AES-256 encrypted in sessionStorage |
| Read Only | — | Public key / npub view-only access |
| New Identity | — | Generate keypair in-browser |

---

## Public API (SemVer surface)

These are the only symbols and shapes covered by SemVer. Anything else in `src/` or `dist/` is internal and may change in a patch release.

- `MILL.open(options)` — options: `theme`, `methods`, `onConnected`, `onClose`, `amberCallback`, `appName`, `oauthShim`, `backupRelays`
- `MILL.restore({ method, pubkey })`
- `MILL.openSettings()` — per-kind signing permissions (private-key signing only)
- `MILL.installAsWindowNostr(signer)`
- `deliverAmberCallback({ autoClose })`
- `<nostr-signer>` attributes: `theme`, `amber-callback`, `app-name`
- Events: `mill:connected`, `mill:disconnected`
- The `MillResult` object (see "Return value" below)
- The CSS variables listed under "Theming"
- Named exports from `nostr-mill/themes`: `brandTheme`, `applyTheme`

---

## Install

### CDN (zero config)

```html
<!-- Self-hosted -->
<script src="https://cdn.happytavern.co/mill/mill.umd.js"></script>

<!-- Or via jsDelivr -->
<script src="https://cdn.jsdelivr.net/npm/nostr-mill/dist/mill.umd.js"></script>
```

### npm

```bash
npm install nostr-mill
# nostr-tools is an optional peer dep for real key derivation:
npm install nostr-tools
```

---

## Usage

### Script tag / CDN

```html
<script src="mill.umd.js"></script>

<button onclick="MILL.open({ onConnected: console.log })">
  Connect Nostr Account
</button>
```

### Web Component

```html
<nostr-signer id="signer" theme="dark"></nostr-signer>

<script>
  const signer = document.getElementById('signer');

  // Open programmatically
  signer.open({
    onConnected: (result) => {
      console.log(result.method);   // 'nip07' | 'nip46' | 'nip55' | 'privatekey' | 'readonly' | 'newkey'
      console.log(result.pubkey);   // hex pubkey
    }
  });

  // Or listen via events
  signer.addEventListener('mill:connected', (e) => {
    const { method, pubkey } = e.detail;
  });

  signer.addEventListener('mill:disconnected', () => {
    console.log('user disconnected');
  });
</script>
```

### ESM / bundler

```js
import MILL from 'nostr-mill';

MILL.open({
  theme: 'dark',
  onConnected: (result) => {
    // result.method  — which method the user chose
    // result.pubkey  — hex public key
    // result.signer  — window.nostr-compatible interface (where available)
  },
  onClose: () => console.log('modal closed'),
});
```

---

## Theming

MILL uses CSS custom properties scoped to the Shadow DOM `:host`. Override them externally:

```css
nostr-signer {
  --mill-accent:   #00c896;
  --mill-bg:       #0a0a0a;
  --mill-radius:   8px;
  --mill-font:     'Your App Font', sans-serif;
}
```

### Built-in themes

```js
// Named themes: 'dark' (default), 'light', 'minimal', 'grain'
MILL.open({ theme: 'light' });

// Or pass a partial token object — merged onto the dark baseline
MILL.open({
  theme: {
    '--mill-accent':     '#ff6b35',
    '--mill-bg':         '#0f0f0f',
    '--mill-radius':     '4px',
    '--mill-font':       "'IBM Plex Sans', sans-serif",
  }
});

// Or use brandTheme() helper — pass just a few inputs
import { brandTheme } from 'nostr-mill/themes';
MILL.open({ theme: brandTheme({ accent: '#7c3aed', radius: '6px' }) });
```

### Full CSS variable reference

| Variable | Default | Description |
|---|---|---|
| `--mill-bg` | `#09080f` | Modal backdrop background |
| `--mill-surface` | `#100e1b` | Modal surface |
| `--mill-card` | `#181528` | Method card background |
| `--mill-card-hover` | `#1f1c35` | Method card hover |
| `--mill-border` | `#2a2544` | Default border |
| `--mill-border-light` | `#3e3860` | Highlighted border |
| `--mill-accent` | `oklch(0.67 0.28 282)` | Primary accent (purple) |
| `--mill-accent-dim` | `…/ 0.13` | Accent tint background |
| `--mill-teal` | `oklch(0.67 0.18 195)` | Secondary accent |
| `--mill-text` | `#ede8fc` | Primary text |
| `--mill-text-secondary` | `#9d94c0` | Secondary text |
| `--mill-muted` | `#5e5880` | Muted / placeholder text |
| `--mill-danger` | `oklch(0.65 0.24 15)` | Error / danger states |
| `--mill-warning` | `oklch(0.78 0.18 65)` | Caution states |
| `--mill-success` | `oklch(0.7 0.2 155)` | Success / positive states |
| `--mill-radius` | `14px` | Base border radius |
| `--mill-font` | `'Space Grotesk', system-ui` | UI font stack |
| `--mill-font-mono` | `'JetBrains Mono', monospace` | Monospace font stack |

---

## Events

| Event | `e.detail` | Description |
|---|---|---|
| `mill:connected` | `{ method, pubkey, signer?, perms? }` | User successfully connected |
| `mill:disconnected` | `{}` | User disconnected |

---

## Return value (`result` object)

```ts
type MillResult = {
  method:    'nip07' | 'nip46' | 'nip55' | 'privatekey' | 'readonly' | 'newkey';
  pubkey:    string;          // hex-encoded public key, always present
  perms?:    SigningPerms;    // per-category pre-approval (privatekey / newkey only)
  bunkerUrl?: string;         // NIP-46 only
  nsec?:     string;          // newkey flow only — the generated nsec (handle carefully)
};

// { notes | profile | contacts | dms | zaps | other → 'session' | 'prompt' }
//   'session' — auto-approve this category until the tab closes
//   'prompt'  — show the consent card and let the user decide
type SigningPerms = Record<string, 'session' | 'prompt'>;
```

---

## Continue with Google (cloud-backed key) — opt-in

A "normie" onboarding path: mill generates and holds the key, the user sets a
PIN (4–8 letters or numbers), and their nsec is encrypted and stored in **their
own** Google Drive (the hidden `appDataFolder`). Returning users sign in on any
device with their PIN. At setup a user can also **import an existing key**
instead of generating one, to bring their own identity into cloud login.
"Take control of my keys" (on the connected screen) reveals the nsec and exports
a portable NIP-49 `ncryptsec` whenever they choose.

This is **off unless you configure it**, and existing hosts see no change to the
picker until they do. It needs a small amount of setup because Google binds
OAuth to a registered origin — see [`shim/mill-oauth.html`](shim/mill-oauth.html).

```js
MILL.open({ oauthShim: 'https://auth.yourdomain.com/mill-oauth.html' });
// or: <nostr-signer oauth-shim="https://auth.yourdomain.com/mill-oauth.html">
```

### Cross-app recovery (experimental — draft NIP)

Optionally, mill can publish an **interoperable** backup so a user can recover
the *same* identity in **other** Nostr clients (not just other mill apps) with
their Google account. This implements the draft
[cloud-key-backup NIP](docs/nip-cloud-key-backup.md): an encrypted key, addressed
by the account + a strong **recovery phrase**, stored on relays.

It is **off unless you provide relays** — and it needs *dedicated* relays,
because the backup is authored by a fresh keypair that ordinary relays reject
(see the NIP). The shim must also request the `openid` scope (the updated
`shim/mill-oauth.html` does this) so mill can read the account's stable `sub`.

```js
MILL.open({
  oauthShim: 'https://auth.you.com/mill-oauth.html',
  backupRelays: ['wss://backup.you.com'],   // dedicated relay(s) you run
});
```

When set, the Google setup flow offers "Use this account in other apps?" →
generates a 7-word recovery phrase (≥70 bits) the user saves, and publishes the
backup. A returning user (in any implementing client) picks "Recover an account
from another app", signs in with Google, and enters the phrase.

> This is **experimental and low-assurance**: the encrypted key is public on
> relays, protected only by the phrase; the draft may change; relay durability is
> best-effort. Mill still forces the user to keep their own key ("Take control of
> my keys"). Read the NIP's Security Considerations before enabling.

Once `oauthShim` is set, **Google** appears as a first-class sign-in option
(with the real Google logo) — both as a card in the picker and under
"I'm new here", so new *and* returning users can reach it. It also slots into an
explicit `methods` list like any other method, in whatever order you want:

```js
MILL.open({ oauthShim: '…', methods: ['google', 'nip07', 'privatekey'] });
```

Without an `oauthShim`, `google` is hidden from the default picker (listing it
explicitly still shows it, then a clear "not configured" screen). The Google
mark keeps its brand colours; everything around it — card, badge, buttons —
follows your theme.

**One-time setup (free, no billing account):**

1. Deploy [`shim/mill-oauth.html`](shim/mill-oauth.html) to a stable origin you
   own, and set `MILL_CLIENT_ID` + `MILL_ALLOWED_ORIGINS` inside it.
2. Google Cloud Console → create an **OAuth Client ID (Web application)**, add
   the shim's origin under *Authorized JavaScript origins*, and enable the
   **Drive API**.

Why the shim exists: `drive.appdata` is scoped **per OAuth client**, so a
per-host client id would give each app a *separate* folder for the same user and
fragment their identity. One shared client id on one origin makes "log in with
Google" mean the same Nostr identity everywhere. The shim holds no secret — a
client id is public, and the registered origin is the security boundary. Because
the data belongs to the *GCP project*, not the domain, you can move the shim to
a new origin later and users keep their backups.

`drive.appdata` is classified **non-sensitive**, so the consent screen needs no
Google security review to publish.

> **On the PIN, honestly:** a 4-digit PIN is ~13 bits of entropy. Measured
> against the 600k-iteration KDF, the whole PIN space falls in ~1s at modest
> parallelism *once an attacker already has the ciphertext*. The PIN stops
> casual access; the real protection is the user's Google account and its 2FA.
> The UI says as much rather than implying more. For at-rest security that does
> not depend on the account, users export a passphrase-protected `ncryptsec`.

---

## Signing consent (private key only)

When mill holds the key itself, it acts as the signer — so it owns the approval
UX. NIP-07, NIP-46 and NIP-55 approve requests inside their own extension or
app, and mill stays out of the way.

There are **two independent gates**, deliberately not fused:

| Gate | Question | Cost |
|---|---|---|
| **Unlock** | Do we have your key? | Password, once per session |
| **Consent** | Do you approve *this* event? | Approve/reject, per kind |

Fusing them forces a choice between a password per signature (which users turn
off immediately) and no review at all. Splitting them means a request can be
shown to you without costing a password. This mirrors Amber, whose biometric
gate wraps the app and is skipped entirely once a permission is remembered.

The key is encrypted at rest, so the **first** signature after a page load
always costs a password — that's the cipher, not policy.

### Consent card

Shown when neither a per-kind grant nor the category pre-approval has already
authorised a request. It names what is being signed (`wants you to sign an
Article`), identifies the account, and hides the payload behind **Show
details** — kind, date, decoded content and tags. Unknown kinds fall back to
the event's `alt` tag, then to `Event kind N`.

The user picks how long to remember the answer — `Just this time` (default,
stores nothing), `5 minutes`, `1 hour`, `This session`, `Always` — and the
choice applies to **Reject** as well as **Approve**, so "block this kind for
this session" is one interaction.

Grants are keyed per kind, so approving a `Note` never authorises an `Article`.
`Always` grants persist in `localStorage`; everything else lives in
`sessionStorage` and dies with the tab, alongside the key it authorises.

### Managing permissions

The consent card links to a permissions manager, so **no host wiring is
required** — mill is only on screen when it's asking for something, which makes
that the natural entry point. If you'd rather offer a direct route:

```js
MILL.openSettings();   // per-kind grants: Allow / Block / Ask, plus Forget all
```

---

## Security notes

- **Private key flows**: nsec is encrypted with AES-256-GCM (PBKDF2, 100k iterations) and stored only in `sessionStorage` — wiped on tab close.  
- **Signing consent**: the password is a session unlock, not a per-event gate. Once unlocked, the decrypted key is held in memory for the tab — so a remembered grant signs without further prompting. Consent limits *what* gets signed; it is not a defence against script execution on your own origin.  
- **NIP-07**: MILL never sees the private key. Only the public key and completed signed events pass through.  
- **NIP-46**: Only signed event payloads travel over the relay — never the key.  
- **NIP-55**: On-device intent — no network between apps.  

---

## NIP-55 (Amber direct) — opt-in only

NIP-55 is **hidden from the default modal**, but not because it fails to connect — as of v1.6.0 mill returns results via the clipboard, which needs no callback route, no server, and no host-app code at all.

It stays hidden because **Amber 6.2.2+ deliberately refuses to remember approvals for browser callers.** Web pages arrive with no calling package, so they all share a single `null` identity; rather than let them share one grant, Amber forces always-ask. The practical effect is that every single signature costs a full app switch — fine for signing in, painful for anything else.

**For most apps, use NIP-46 with Amber-as-bunker instead.** Amber registers the `nostrconnect://` scheme, so mill's Remote Signer flow hands off to it directly: the user approves once, and all later signing happens over relays with no app switching. This is what Coracle, nostr-login, and most other web clients do.

To opt in to NIP-55 anyway:

```js
MILL.open({
  methods: ['nip07', 'nip46', 'nip55', 'newkey', 'privatekey', 'readonly'],
  onConnected: handleSignIn,
});
```

### How the result comes back

Amber's `sendResult()` has three branches, chosen by what you send:

| You send | Amber does |
|---|---|
| A calling package (native app) | `setResult()` back to the caller |
| A `callbackUrl` | Fires `ACTION_VIEW` at `callbackUrl + urlEncode(result)` |
| **Neither** | **Copies the result to the clipboard** ← mill's default |

Mill defaults to the clipboard branch. It snapshots the clipboard before firing the intent (so stale content is never misread), then reads it back on `visibilitychange`/`focus` when you return from Amber, validating that the text looks like a pubkey, signature, or signed event. Requires HTTPS and a one-time clipboard-read permission grant.

### If you want a callback URL instead

Set `amber-callback` / `amberCallback`. Two things are worth knowing, because both have bitten people:

**Amber does not append a parameter name.** It literally concatenates: `callbackUrl + Uri.encode(result)`. A URL like `https://yoursite.com/amber-callback` therefore produces `https://yoursite.com/amber-callbackab12cd…` — the result is glued onto the path and the `?event=` you were expecting never exists. Your callback URL must already end in the separator and parameter name.

**Amber ≥ 6.0.0 shreds query strings in the callback URL.** It URL-decodes the whole intent URI and *then* splits on `?`, so anything after a `?` inside your callback URL is silently dropped ([regression in `18db8c3d`](https://github.com/greenart7c3/Amber/commit/18db8c3d)). Percent-encoding does not help — the decode happens first. This broke every `?event=` callback in the wild as of Amber 6.0.0 (April 2026).

Mill handles both for you: it normalises whatever you pass to a **`#event=` fragment**, which survives both the old and new parsers. Fragments are also never sent to the server, so the signature stays out of your access logs.

```html
<nostr-signer amber-callback="https://yoursite.com/amber-callback" app-name="My App"></nostr-signer>
<!-- mill sends: https://yoursite.com/amber-callback#event= -->
```

Because the result now arrives in a fragment, **a purely static page is enough** — there is no server-side step. If the callback lands on a different page from the one that opened Amber, call `deliverAmberCallback()` there to forward it.

#### What `deliverAmberCallback()` does

When the callback page is in a popup / new tab opened by mill:

- Reads the result from `#event=` (or a legacy `?event=` / `?error=`) in the URL
- Writes it to `localStorage` (key: `mill:amber:result`) — survives reloads
- Posts a message to `window.opener` if present
- Auto-closes the callback window if `autoClose: true`

Mill's host-page `awaitAmberResult` listener picks it up via the storage event, `hashchange`, or postMessage, and the original modal advances to the success step. `localStorage` is the load-bearing path here — Amber's `ACTION_VIEW` usually opens a *fresh* tab (possibly in a different browser) with no `window.opener`, so postMessage often has nothing to talk to.

---

## Browser support

Modern browsers with Shadow DOM v1, CSS custom properties, and `crypto.subtle` (all evergreen browsers). No IE11.

---

## License

MIT © 0ceanslim
