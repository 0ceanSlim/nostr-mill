# MILL — Multi-Interface Login Layer

**Lightweight, drop-in Nostr signer UI as a Web Component.**  
One `<script>` tag, every Nostr signing method — plus an optional
**"Continue with Google"** onboarding path for non-technical users, who can take
full control of their key whenever they choose.

> Core signing methods carry no runtime dependencies of note. The opt-in Google
> paths pull in crypto libraries (`@noble/*`, `@scure/bip39`, and — for
> pomegranate — `@fiatjaf/promenade-trusted-dealer`); these ship in the bundle
> but only run when a user actually uses those paths.

[![npm](https://img.shields.io/npm/v/nostr-mill)](https://www.npmjs.com/package/nostr-mill)
[![license](https://img.shields.io/npm/l/nostr-mill)](LICENSE)

---

## Supported Methods

| Method | NIP | Description |
|---|---|---|
| Browser Extension | NIP-07 | Alby, nos2x, Flamingo, Nostore |
| Remote Signer | NIP-46 | Bunker URL or QR scan |
| Android Signer | NIP-55 | Amber — clipboard return by default, no server needed |
| Private Key | — | nsec/hex, AES-256 encrypted in sessionStorage |
| Read Only | — | Public key / npub view-only access |
| New Identity | — | Generate keypair in-browser |
| **Google — Pomegranate** † | — | "Continue with Google", **cross-client**: FROST-sharded key, never stored whole. Client of fiatjaf's pomegranate. |
| **Google — Drive+PIN** † | — | "Continue with Google", per-app: encrypted key in the user's own Drive, unlocked by a PIN. Import/export anytime. |

† Both are **opt-in and off by default** — each appears only when configured
(`pomegranate` for the FROST path, `oauthShim` for Drive+PIN); pomegranate takes
precedence if both are set. Existing hosts see no change to the picker until they
opt in. See [Continue with Google](#continue-with-google-pomegranate--frost--experimental-cross-client).

For private-key signing, MILL also acts as the signer and shows a **per-event
consent card** (approve/reject with a remember-my-choice duration) — see
[Signing consent](#signing-consent-private-key-only).

---

## Public API (SemVer surface)

These are the only symbols and shapes covered by SemVer. Anything else in `src/` or `dist/` is internal and may change in a patch release.

- `MILL.open(options)` — options: `theme`, `methods`, `onConnected`, `onClose`, `amberCallback`, `appName`, `oauthShim`, `pomegranate`, `header`, `footer`, `tip`
- `MILL.restore({ method, pubkey })`
- `MILL.openSettings()` — per-kind signing permissions (private-key signing only)
- `MILL.installAsWindowNostr(signer)`
- `deliverAmberCallback({ autoClose })`
- `<nostr-signer>` attributes: `theme`, `amber-callback`, `app-name`, `oauth-shim`
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
      console.log(result.method);   // 'nip07' | 'nip46' | 'nip55' | 'privatekey' | 'readonly' | 'newkey' | 'google' | 'pomegranate'
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

## Header & footer branding

Brand the modal with your own header and footer.

```js
MILL.open({
  header: {
    logo: 'https://yourapp.com/logo.png',   // image URL (PNG/SVG/…) at natural size, or an emoji/short text
    logoHeight: 48,                          // px height for image logos (default 44)
    title: 'YourApp',                        // main title
    message: 'Your keys, your Nostr.',       // short line under the title
    align: 'center',                         // 'left' (default) | 'center'
    label: 'Secure Login',                   // the top strip eyebrow (default "Account Access"); '' hides it
  },
  tip: false,                                 // hide the "Not sure? …" line under the methods (or pass a string)
  footer: {
    text: 'Your identity · Your data · Your money',
    links: [
      { label: 'Terms',   href: 'https://yourapp.com/terms' },
      { label: 'Privacy', href: 'https://yourapp.com/privacy' },
    ],
    attribution: true,                        // "Signer by MILL" link — ON by default
    attributionHref: 'https://…',             // optional: override where it points
  },
});
```

Every field is optional. As soon as you set any of `logo` / `title` / `message`,
the header becomes fully yours — no mill wording appears. Leave `header` unset and
you get mill's default header. A broken image URL is dropped silently (no
broken-image icon). `label: ''` hides the top strip label (the close button
stays); `tip: false` hides the recommendation line, or pass a string to replace it.

## Footer (Terms / Privacy / attribution)

The method picker can show a configurable footer — your own tagline and links
(Terms, Privacy, …), plus a small **"Signer by MILL"** attribution.

```js
MILL.open({
  footer: {
    text: 'Your identity · Your data · Your money',   // optional left tagline
    links: [                                          // optional links (open in a new tab)
      { label: 'Terms',   href: 'https://yourapp.com/terms' },
      { label: 'Privacy', href: 'https://yourapp.com/privacy' },
    ],
    attribution: true,                    // "Signer by MILL" link — ON by default
    attributionHref: 'https://…',         // optional: override where it points
  },
});
```

- The attribution is **on by default**; set `attribution: false` to hide it.
- Omit `footer` entirely and you still get just the attribution. Pass
  `{ attribution: false }` with no links/text for no footer at all.
- Links open with `target="_blank" rel="noopener noreferrer"`.

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
  method:    'nip07' | 'nip46' | 'nip55' | 'privatekey' | 'readonly' | 'newkey' | 'google' | 'pomegranate';
  pubkey:    string;          // hex-encoded public key, always present
  perms?:    SigningPerms;    // per-category pre-approval (privatekey / newkey / google)
  bunkerUrl?: string;         // NIP-46 only
  nsec?:     string;          // newkey flow only — the generated nsec (handle carefully)
};

// { notes | profile | contacts | dms | zaps | other → 'session' | 'prompt' }
//   'session' — auto-approve this category until the tab closes
//   'prompt'  — show the consent card and let the user decide
type SigningPerms = Record<string, 'session' | 'prompt'>;
```

---

## Continue with Google (Pomegranate / FROST) — experimental, cross-client

The **cross-client** Google path: a user signs in with Google in *any*
implementing client and gets the *same* Nostr identity. This is a client of
fiatjaf's [pomegranate](https://fiatjaf.com/pomegranate) — the key is
**FROST-sharded** across independent operator servers and never stored whole (no
app, including mill, ever holds it); Google only authenticates the user to the
operators; signing runs over NIP-46 through a `central` coordinator. To any
client it is a normal NIP-46 bunker.

```js
MILL.open({
  pomegranate: {
    central:   'https://central.yourdomain.com',        // pomegranate central server
    operators: ['https://op1…', 'https://op2…', 'https://op3…'],
    threshold: 2,                                         // m-of-n (default ~2/3 of n)
    relays:    ['wss://relay.damus.io', /* … */],         // discovery relays (optional)
  },
});
```

- **Opt-in**, off unless configured. When set it takes precedence over the
  Drive+PIN path so there's never a double "Continue with Google".
- It needs a running **`central` + `operator` servers** you (or someone) host —
  see the [handoff/deploy guide](docs/pomegranate-deploy.md). The central is the
  Google OAuth handler, so mill needs no shim for this path.
- Signup FROST-shards a new key and offers the nsec once for optional backup;
  returning users are discovered by Google account across clients; "Recover my
  key from operators" reconstructs the key from a threshold of shards.

> **Experimental:** pomegranate is new and has no NIP yet — kinds/endpoints are
> provisional and may change. It adds a FROST dependency
> (`@fiatjaf/promenade-trusted-dealer`). Trust model: any *threshold* of
> colluding operators, or a malicious Google OAuth, could reconstruct the key;
> availability needs a threshold of operators online.

> **Superseded:** 1.6's experimental relay-published cross-client backup (the
> [cloud-key-backup NIP draft](docs/nip-cloud-key-backup.md)) is removed in 1.7
> in favour of this — it avoided pomegranate's public-honeypot problem is the
> reason. The NIP draft is kept for the record.

---

## Continue with Google (Drive + PIN) — per-app, no external servers

A simpler path with **no servers to run**: mill generates and holds the key, the
user sets a PIN (4–8 letters or numbers), and their nsec is encrypted into
**their own** Google Drive (the hidden `appDataFolder`). It is **per-app** —
Drive's app-data folder is scoped per OAuth client, so this is *not* cross-client
(use pomegranate for that). Returning users sign in with their PIN; at setup they
can **import an existing key**; "Take control of my keys" reveals the nsec and
exports a portable NIP-49 `ncryptsec`.

It needs a small static OAuth shim on an origin you own —
see [`shim/mill-oauth.html`](shim/mill-oauth.html).

```js
MILL.open({ oauthShim: 'https://auth.yourdomain.com/mill-oauth.html' });
```

When either Google path is configured, **Google** appears as a first-class sign-in option
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
