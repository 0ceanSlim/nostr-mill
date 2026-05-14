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

- `MILL.open(options)` — options: `theme`, `methods`, `onConnected`, `onClose`, `amberCallback`, `appName`
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
  perms?:    SigningPerms;    // per-kind signing preferences (privatekey / newkey only)
  bunkerUrl?: string;         // NIP-46 only
  nsec?:     string;          // newkey flow only — the generated nsec (handle carefully)
};
```

---

## Security notes

- **Private key flows**: nsec is encrypted with AES-256-GCM (PBKDF2, 100k iterations) and stored only in `sessionStorage` — wiped on tab close.  
- **NIP-07**: MILL never sees the private key. Only the public key and completed signed events pass through.  
- **NIP-46**: Only signed event payloads travel over the relay — never the key.  
- **NIP-55**: On-device intent — no network between apps.  

---

## NIP-55 (Amber direct) — opt-in only

NIP-55 is **hidden from the default modal** because the browser → Amber → browser round trip relies on Android's intent + custom-URI behavior, which is inconsistent across mobile browsers. Without a server-side callback handler, sign-in often appears to stall after the user approves in Amber.

The code path is intact — NIP-55 is fully implemented and works when wired up correctly. To enable it, opt in via `methods`:

```js
MILL.open({
  methods: ['nip07', 'nip46', 'nip55', 'newkey', 'privatekey', 'readonly'],
  onConnected: handleSignIn,
});
```

**For static sites (no backend), use NIP-46 with Amber-as-bunker instead** — it works on every mobile browser without any of NIP-55's redirect-handoff problems. Amber's QR-scanned bunker mode is the recommended mobile flow for purely client-side apps.

### Server-side callback for full NIP-55 support

If your host application has a backend, you make NIP-55 reliable by giving Amber a callback URL on your server. The server captures the result and creates a session, so the browser tab/state mismatch doesn't matter.

#### Wire-up

**1.** When opening mill, set the callback URL via the host element attribute or pass via the `<nostr-signer amber-callback="…">` attribute:

```html
<nostr-signer
  id="signer"
  amber-callback="https://yoursite.com/amber-callback"
  app-name="My App">
</nostr-signer>

<script>
  document.getElementById('signer').open({
    methods: ['nip07', 'nip46', 'nip55', 'newkey'],
    onConnected: handleSignIn,
  });
</script>
```

**2.** Implement the callback route on your server. It receives `?event=<pubkey-hex>` from Amber and is responsible for:

- Reading the pubkey from the query
- Creating a session for that user (cookie / JWT / whatever)
- Returning a small HTML page that closes itself or redirects back

#### Go example (matches grain / pubkey-quest patterns)

```go
// /amber-callback handler
func AmberCallback(w http.ResponseWriter, r *http.Request) {
    pubkey := r.URL.Query().Get("event")
    if pubkey == "" {
        http.Error(w, "missing event param", http.StatusBadRequest)
        return
    }

    // Validate it's a 64-char hex pubkey
    if len(pubkey) != 64 {
        http.Error(w, "invalid pubkey", http.StatusBadRequest)
        return
    }

    // Create the user's session — your existing auth logic
    sessionID, err := sessions.Create(pubkey, "amber")
    if err != nil {
        http.Error(w, "session creation failed", http.StatusInternalServerError)
        return
    }

    http.SetCookie(w, &http.Cookie{
        Name:     "session",
        Value:    sessionID,
        Path:     "/",
        HttpOnly: true,
        Secure:   true,
        SameSite: http.SameSiteLaxMode,
    })

    // Render a tiny page that signals success back to the original tab
    // and then closes itself / redirects.
    fmt.Fprintf(w, `
<!doctype html><html><body>
  <script type="module">
    import { deliverAmberCallback } from 'https://cdn.jsdelivr.net/npm/nostr-mill/dist/mill.esm.js';
    deliverAmberCallback({ autoClose: true });
    // Or redirect to your app:
    // setTimeout(() => location.href = '/', 200);
  </script>
  <p>Signed in via Amber. Redirecting…</p>
</body></html>`)
}
```

Register the route:

```go
mux.HandleFunc("/amber-callback", AmberCallback)
```

**3.** When the user opens mill on a page that already has a session cookie, your existing session-check code picks it up — no further mill involvement needed.

#### What `deliverAmberCallback()` does

When the callback page is in a popup / new tab opened by mill:

- Reads `?event=` and `?error=` from the URL
- Writes the result to `localStorage` (key: `mill:amber:result`) — survives reloads
- Posts a message to `window.opener` if present
- Auto-closes the callback window if `autoClose: true`

Mill's host-page `awaitAmberResult` listener picks it up via the storage event or postMessage, and the original modal advances to the success step.

---

## Browser support

Modern browsers with Shadow DOM v1, CSS custom properties, and `crypto.subtle` (all evergreen browsers). No IE11.

---

## License

MIT © 0ceanslim
