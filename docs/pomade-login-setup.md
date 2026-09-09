# Setting up "Sign in with email" (Pomade)

This guide wires up mill's email-and-password login. Unlike
[Continue with Google](google-login-setup.md), there is no OAuth client to
register and no shim page to host — but there **is** a runtime dependency to
supply, and you have to decide which signer services your users' keys are split
across.

---

## Background

[`@pomade/core`](https://www.npmjs.com/package/@pomade/core) splits a Nostr
secret key into FROST shares and hands one to each of several independent
**signer services**. Signing is a two-round protocol: the client asks a
threshold of signers to commit to a nonce, then to produce a partial signature,
and combines the results locally. The key is reassembled **only** during
recovery, and only in the user's browser.

What that buys, compared to the other easy-onboarding path:

| | Continue with Google | Sign in with email (pomade) |
|---|---|---|
| Who can access the key | Google account holder (+ PIN on the blob) | a colluding threshold of signer services |
| Setup you must do | register an OAuth client, host a shim page | pick signer services, ship `@pomade/core` |
| Works offline | yes (key is in the tab) | no — every signature is a network round trip |
| Encryption support | nip04 + nip44 | nip44 only |
| Credential | Google account + PIN | email + password |

Neither is self-custody. Mill treats both the same way — onboarding now, and
"take control of my keys" whenever the user is ready.

---

## Part A — Choose signer services

Pomade signers are ordinary HTTP services speaking pomade's RPC (see
[`@pomade/signer`](https://www.npmjs.com/package/@pomade/signer) for a
batteries-included one). Two rules matter more than which you pick:

1. **Use services under separate control.** Three signers run by one operator
   protect against nothing, since that operator alone reaches the threshold.
2. **Three or more.** Below three there is no useful gap between "enough to
   sign" and "all of them", so a single outage locks users out.

Mill defaults to a **two-thirds threshold over every configured signer** — three
signers gives 2-of-3. Override with `threshold` / `total` if you have a reason.

Write each URL exactly as the signer's own `origin`: scheme and host, no
trailing slash, no path, no default port. The URL string is the argon2 salt for
the email hash, and the signer salts with `new URL(its own url).origin`, so any
divergence means email lookups miss and no codes are ever sent. Mill trims
whitespace and a trailing slash; it does not rewrite anything else.

---

## Part B — Ship `@pomade/core`

Mill does **not** bundle it. Between FROST, the welshman stack, a wasm argon2
and zod it is an order of magnitude larger than mill itself, and most hosts
never turn this method on. So you supply it, one of three ways.

### Bundler hosts (recommended)

```bash
npm install @pomade/core
```

```js
import MILL from 'nostr-mill';

MILL.open({
  pomade: {
    module: import('@pomade/core'),
    signerUrls: ['https://signer-a.example', 'https://signer-b.example', 'https://signer-c.example'],
    // argon2id runs on the main thread by default and janks the modal for a
    // few hundred ms per hash. Worth wiring up:
    argonWorker: import('@pomade/core/argon-worker.js?worker'),
  },
  onConnected: result => console.log(result.method, result.pubkey),
});
```

`module` accepts a namespace, a promise for one, or a function returning either.
Passing the bare `import(...)` promise keeps it lazy, so the code downloads only
when a user picks email login.

### Script-tag hosts

Set `window.PomadeCore` before opening the modal, then configure signer URLs
only:

```html
<script type="module">
  import * as PomadeCore from 'https://esm.sh/@pomade/core@0.3';
  window.PomadeCore = PomadeCore;
</script>
<script src="https://cdn.jsdelivr.net/npm/nostr-mill/dist/mill.umd.js"></script>
<script>
  MILL.open({ pomade: { signerUrls: ['https://signer-a.example', '…'] } });
</script>
```

### Runtime URL

If neither is convenient, give mill a URL to `import()` at the moment it is
needed:

```js
MILL.open({ pomade: { moduleUrl: 'https://esm.sh/@pomade/core@0.3', signerUrls: [...] } });
```

The import is a plain dynamic `import()` of a URL, with no `eval`, so it needs
no `unsafe-eval` in your CSP. It does need the origin in `script-src`. Pin an
exact version rather than a range.

---

## Part C — Restoring after a reload

Mill persists the pomade **ClientOptions** bundle (the FROST group description,
this browser's client secret and the signer URLs) in `sessionStorage`.
`MILL.restore()` rebuilds a signer from it:

```js
// Config first — restoring needs @pomade/core, and may run before any open().
MILL.configurePomade({ module: import('@pomade/core'), signerUrls: [...] });

const signer = await MILL.restore({ method: 'pomade', pubkey: savedPubkey });
if (!signer) MILL.open({ /* … */ });   // session gone — ask them to sign in
```

The client secret authorises signing requests to the signers. The user's key
never exists here, so a stolen copy can sign until the session is deactivated
but reveals nothing about the identity itself. "Disconnect & Switch Account"
deactivates it server-side.

---

## Part D — Verify

1. Open the picker. **Email & Password** should appear, and "I'm new here!"
   should offer **Sign up with email**.
2. Sign up. Registration mines a small proof of work and argon2-hashes the
   password once per signer, so expect a few seconds — the "Creating your
   account…" screen says so.
3. Check your inbox for the confirmation code, and confirm.
4. Sign a note. Then reload and confirm `MILL.restore()` gives you a working
   signer without a prompt.
5. On the connected screen, run **Take control of my keys** end to end. If it
   fails, users are stuck with the login rather than choosing it.

---

## Common failure modes

| Symptom | Cause |
|---|---|
| "Email Login Not Configured" screen | `signerUrls` empty — you listed `'pomade'` in `methods` but never configured it |
| "@pomade/core is not loaded" | no `module`, no `window.PomadeCore`, no `moduleUrl` |
| "Could not reach the signer services" | every RPC failed at the transport level — signers down, or CORS blocking the browser |
| "That email and password did not match an account" | signers answered and said no. Genuinely wrong credentials, or a rate limit |
| Sign-up succeeds, no email arrives | the signer accepted the registration but its mailer is broken. The account exists; users can still sign in with their password |
| Codes rejected on retry | codes are single-use and consumed on the attempt. Request a new set |
| No codes arrive, no error shown | `/challenge` emails only an address confirmed at sign-up, and answers `ok` either way so nobody can test addresses for membership. Check the signer's own logs — the client cannot tell |
| No codes for an address that definitely has an account | `hashEmail` salts with the signer URL string, and the signer stores its hash salted with `new URL(url).origin`. If your configured URL differs from that origin by anything more than a trailing slash — a path, an explicit `:443`, a capitalised host — every lookup misses silently |
| `signer.nip04` is `undefined` | expected — pomade implements nip44 only. Feature-detect rather than assuming |

---

## Guardrails

- **Say who the signers are.** Users are trusting a threshold of named
  operators, so put that list in your own UI rather than only in a config file.
- **Email and password are the only way back.** There is no support desk that
  can reset them, and mill's sign-up screen says so. Don't undercut that with
  copy implying you can help.
- **Don't hide "take control of my keys."** It is what a user reaches for if
  the signer services disappear.
