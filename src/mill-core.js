/**
 * MILL — mill-core.js
 * Vanilla JS Web Component. Zero React. Zero framework deps.
 * Registers <nostr-signer> custom element + exposes MILL global API.
 *
 * Usage (script tag / CDN):
 *   <script src="mill-core.js"></script>
 *   <nostr-signer theme="dark"></nostr-signer>
 *   document.querySelector('nostr-signer').addEventListener('mill:connected', e => console.log(e.detail));
 *
 * Usage (ESM):
 *   import MILL from 'mill';
 *   MILL.open({ theme: 'dark', onConnected: signer => ... });
 */

import { applyTheme, brandTheme, THEMES } from './themes.js';
import {
  isValidNsec, isValidNpub, isValidBunker,
  nsecToHex, npubToHex, hexToNpub, hexToNsec,
  generateKeypair, encryptNsec, decryptNsec,
  storeEncryptedNsec, loadEncryptedNsec, clearStoredNsec,
  storeSignPerms, loadSignPerms, clearSignPerms,
  storeBunkerState, loadBunkerState, clearBunkerState,
  bytesToHex,
} from './crypto.js';
import { getPublicKey } from 'nostr-tools/pure';
import { hexToBytes } from './crypto.js';
import qrcode from 'qrcode-generator';
import { NIP46Client, parseBunkerURI, DEFAULT_RELAYS, SUGGESTED_RELAYS } from './nip46.js';
import { isLocalhost } from './nip55.js';
import {
  createNIP07Signer, createNIP46Signer, createNIP55Signer,
  createPrivateKeySigner, createReadOnlySigner, installAsWindowNostr,
} from './signers.js';
import { kindLabel, kindNip, kindArticle } from './kinds.js';
import {
  DURATIONS, listGrants, saveGrant, revokeGrant, revokeAllGrants, sweepExpiredGrants,
} from './grants.js';
import { requestCloudToken } from './oauth.js';
import { encryptCloudBlob, decryptCloudBlob, exportNcryptsec } from './cloudkey.js';
import { listBackups, downloadBackup, uploadBackup, deleteBackup, withAuth } from './drive.js';
import {
  authenticate as pomAuthenticate, tokenEmail as pomTokenEmail, discover as pomDiscover,
  loginExisting as pomLogin, getAccount as pomGetAccount, signup as pomSignup,
  deleteAccount as pomDeleteAccount, erasePopup as pomErasePopup, isShardConflict as pomIsShardConflict,
  requestOperatorShard, reconstructFromShards,
  massageURL as pomMassageURL, probeServer as pomProbeServer, isValidServerURL as pomIsValidServerURL,
} from './pomegranate.js';

// njump ecosystem defaults, used when a host enables pomegranate without naming
// its own servers (MILL.open({ pomegranate: true })). Mirrors fiatjaf's admin
// client: central auth.njump.me, four independently-run operators (3-of-4).
const POM_DEFAULT_CENTRAL = 'auth.njump.me';
const POM_DEFAULT_OPERATORS = ['po.f7z.io', 'po.coracle.social', 'po.njump.me', 'po.jumble.social'];

// ── Signing permission categories ─────────────────────────────────────────────
const SIGN_CATS = [
  { id: 'notes',    label: 'Text Notes & Reactions', desc: 'kind 1, 6, 7, 16', icon: '📝', def: 'session' },
  { id: 'profile',  label: 'Profile Updates',         desc: 'kind 0',            icon: '👤', def: 'prompt'  },
  { id: 'contacts', label: 'Follow List Changes',     desc: 'kind 3',            icon: '👥', def: 'prompt'  },
  { id: 'dms',      label: 'Encrypted Messages',      desc: 'kind 4, 13, 14, 1059', icon: '💬', def: 'prompt'  },
  { id: 'zaps',     label: 'Zap Requests',            desc: 'kind 9734, 9735',   icon: '⚡', def: 'prompt'  },
  { id: 'other',    label: 'All Other Event Kinds',   desc: 'everything else',   icon: '📋', def: 'prompt'  },
];

const defaultPerms = () => Object.fromEntries(SIGN_CATS.map(c => [c.id, c.def]));

// Map common host-side method aliases (e.g. grain's SigningMethod enum) onto
// mill's internal method ids so MILL.restore() accepts either spelling.
const RESTORE_METHOD_ALIASES = {
  browser_extension: 'nip07',
  bunker:            'nip46',
  amber:             'nip55',
  encrypted_key:     'privatekey',
  newkey:            'privatekey',
  none:              'readonly',
  // Google login builds a private-key signer from the cloud-recovered key;
  // after a reload the sessionStorage blob restores it exactly like privatekey.
  google:            'privatekey',
  // Pomegranate connects a NIP-46 bunker; restore rebuilds it from stored
  // bunker state exactly like a remote signer.
  pomegranate:       'nip46',
};

// These choose whether a category is PRE-APPROVED, not when a password is
// typed. The password is a separate, session-level unlock — see
// createPrivateKeySigner's two-gate split. Wire values stay 'session'/'prompt'
// because they're part of the public `perms` shape and persisted state.
const PERM_OPTS = [
  { id: 'session', label: 'Auto-approve', sublabel: 'this session', color: 'var(--mill-success)', icon: '✅',
    desc: 'Signs without asking, until you close this tab.' },
  { id: 'prompt',  label: 'Review',       sublabel: 'each time',    color: 'var(--mill-warning)', icon: '👀',
    desc: 'Shows you what is being signed, and you approve or reject it.' },
];

const METHOD_META = {
  readonly:   { label: 'Read-Only',         icon: '👁',  color: 'var(--mill-muted)'   },
  privatekey: { label: 'Private Key',       icon: '🔑',  color: 'var(--mill-warning)' },
  nip07:      { label: 'Browser Extension', icon: '🧩',  color: 'var(--mill-accent)'  },
  nip46:      { label: 'Remote Signer',     icon: '📡',  color: 'var(--mill-teal)'    },
  nip55:      { label: 'Android Signer',    icon: '📱',  color: 'var(--mill-teal)'    },
  newkey:     { label: 'New Identity',      icon: '✨',  color: 'var(--mill-success)' },
  google:     { label: 'Google',            icon: googleLogo, color: 'var(--mill-accent)' },
  pomegranate:{ label: 'Google',            icon: googleLogo, color: 'var(--mill-accent)' },
};

const METHODS_LIST = [
  { id: 'google',     label: 'Google',             sub: 'Cloud login',   icon: googleLogo, secLabel: 'Easiest', secColor: 'var(--mill-success)' },
  { id: 'pomegranate',label: 'Google',             sub: 'Secure login',  icon: googleLogo, secLabel: 'Easiest', secColor: 'var(--mill-success)' },
  { id: 'nip07',      label: 'Browser Extension', sub: 'NIP-07',        icon: '🧩', secLabel: 'Recommended',  secColor: 'var(--mill-success)' },
  { id: 'nip46',      label: 'Remote Signer',     sub: 'NIP-46 Bunker', icon: '📡', secLabel: 'High security', secColor: 'var(--mill-teal)'    },
  { id: 'nip55',      label: 'Android Signer',    sub: 'NIP-55 · Amber',icon: '📱', secLabel: 'Android only',  secColor: 'var(--mill-warning)'    },
  { id: 'privatekey', label: 'Private Key',        sub: 'nsec / hex',    icon: '🔑', secLabel: 'Use with care', secColor: 'var(--mill-warning)' },
  { id: 'readonly',   label: 'Read Only',          sub: 'Public key',    icon: '👁', secLabel: 'View only',     secColor: 'var(--mill-muted)'   },
  { id: 'newkey',     label: 'New Identity',       sub: 'Generate keys', icon: '✨', secLabel: 'Brand new',     secColor: 'var(--mill-accent)'  },
];

// Methods hidden from the default modal — code is intact, but hosts must opt in
// via methods config. NIP-55 stays hidden not because it fails to connect (the
// clipboard return path works with no host wire-up) but because Amber 6.2.2+
// refuses to remember approvals for browser callers, so every signature costs a
// full app switch. NIP-46 with Amber as a bunker is the better default.
const DEFAULT_HIDDEN_METHODS = new Set(['nip55']);

// ── Base CSS injected into Shadow DOM ─────────────────────────────────────────
const BASE_CSS = `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  :host {
    --mill-bg:             #09080f;
    --mill-surface:        #100e1b;
    --mill-card:           #181528;
    --mill-card-hover:     #1f1c35;
    --mill-inset:          var(--mill-inset);
    --mill-inset-strong:   var(--mill-inset-strong);
    --mill-overlay:        rgba(4,3,10,0.78);
    --mill-border:         #2a2544;
    --mill-border-light:   #3e3860;
    --mill-accent:         oklch(0.67 0.28 282);
    --mill-accent-hover:   oklch(0.73 0.28 282);
    --mill-accent-dim:     oklch(0.67 0.28 282 / 0.13);
    --mill-teal:           oklch(0.67 0.18 195);
    --mill-teal-dim:       oklch(0.67 0.18 195 / 0.13);
    --mill-text:           #ede8fc;
    --mill-text-secondary: #9d94c0;
    --mill-muted:          #5e5880;
    --mill-danger:         oklch(0.65 0.24 15);
    --mill-danger-dim:     oklch(0.65 0.24 15 / 0.13);
    --mill-warning:        oklch(0.78 0.18 65);
    --mill-warning-dim:    oklch(0.78 0.18 65 / 0.13);
    --mill-success:        oklch(0.7 0.2 155);
    --mill-success-dim:    oklch(0.7 0.2 155 / 0.13);
    --mill-radius:         14px;
    --mill-border-width:   1px;
    --mill-border-style:   solid;
    --mill-shadow:         0 0 0 1px rgba(130,80,255,0.08), 0 24px 64px rgba(0,0,0,0.7), 0 0 80px oklch(0.67 0.28 282 / 0.06);
    --mill-font:           'Space Grotesk', system-ui, sans-serif;
    --mill-font-mono:      'JetBrains Mono', monospace;
    font-family: var(--mill-font);
    color: var(--mill-text);
  }

  @keyframes millFadeUp  { from { opacity:0; transform:translateY(8px); } to { opacity:1; transform:translateY(0); } }
  @keyframes millSpin    { to { transform: rotate(360deg); } }

  .mill-overlay {
    position: fixed; inset: 0;
    background: var(--mill-overlay);
    backdrop-filter: blur(5px);
    display: flex; align-items: center; justify-content: center;
    padding: 20px;
    z-index: 9999;
  }

  .mill-modal {
    width: 100%; max-width: 480px;
    background: var(--mill-surface);
    border: var(--mill-border-width) var(--mill-border-style) var(--mill-border-light);
    border-radius: calc(var(--mill-radius) + 4px);
    box-shadow: var(--mill-shadow);
    overflow: hidden;
    max-height: 92vh;
    display: flex; flex-direction: column;
    animation: millFadeUp 0.2s ease;
  }

  .mill-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 15px 20px;
    border-bottom: 1px solid var(--mill-border);
    flex-shrink: 0;
  }
  .mill-header-dot {
    width: 6px; height: 6px; border-radius: 50%;
    background: var(--mill-accent);
    box-shadow: 0 0 8px var(--mill-accent);
    margin-right: 8px; display: inline-block;
  }
  .mill-header-label {
    font-size: 11px; font-weight: 600; letter-spacing: 0.07em;
    text-transform: uppercase; color: var(--mill-text-secondary);
  }
  .mill-close {
    background: none; border: none; cursor: pointer; font-size: 18px;
    color: var(--mill-muted); padding: 2px 6px; border-radius: 6px;
    font-family: var(--mill-font); line-height: 1;
    transition: color 0.15s;
  }
  .mill-close:hover { color: var(--mill-text); }

  .mill-body {
    padding: 22px 24px;
    overflow-y: auto; flex: 1;
    scrollbar-width: thin;
    scrollbar-color: var(--mill-border-light) transparent;
  }

  /* ─ Progress bar ─ */
  .mill-progress { display: flex; gap: 5px; margin-bottom: 20px; }
  .mill-progress-seg {
    height: 3px; border-radius: 2px;
    background: var(--mill-border);
    transition: all 0.3s ease; flex: 1;
  }
  .mill-progress-seg.active { background: var(--mill-accent); flex: 2.5; }
  .mill-progress-seg.done   { background: var(--mill-accent); }

  /* ─ Typography ─ */
  .mill-back {
    background: none; border: none; color: var(--mill-muted); cursor: pointer;
    font-size: 13px; padding: 0; margin-bottom: 10px; display: flex;
    align-items: center; gap: 4px; font-family: var(--mill-font);
    transition: color 0.15s;
  }
  .mill-back:hover { color: var(--mill-text); }
  .mill-title   { font-size: 19px; font-weight: 700; margin-bottom: 5px; }
  .mill-subtitle{ font-size: 13px; color: var(--mill-text-secondary); line-height: 1.6; margin-bottom: 18px; }

  /* ─ Badge ─ */
  .mill-badge {
    border-radius: 10px; padding: 10px 14px;
    font-size: 13px; line-height: 1.55;
    display: flex; gap: 10px; align-items: flex-start;
  }
  .mill-badge-icon { flex-shrink: 0; margin-top: 1px; }
  .mill-badge-title { font-weight: 600; margin-bottom: 3px; }
  .mill-badge-body  { color: var(--mill-text-secondary); }
  .mill-badge.info    { background: var(--mill-accent-dim);  border: 1px solid var(--mill-border-light); }
  .mill-badge.info    .mill-badge-title { color: var(--mill-accent);  }
  .mill-badge.warning { background: var(--mill-warning-dim); border: 1px solid var(--mill-warning); }
  .mill-badge.warning .mill-badge-title { color: var(--mill-warning); }
  .mill-badge.danger  { background: var(--mill-danger-dim);  border: 1px solid var(--mill-danger);  }
  .mill-badge.danger  .mill-badge-title { color: var(--mill-danger);  }
  .mill-badge.success { background: var(--mill-success-dim); border: 1px solid var(--mill-success); }
  .mill-badge.success .mill-badge-title { color: var(--mill-success); }
  .mill-badge.muted   { background: rgba(255,255,255,0.04); border: 1px solid var(--mill-border); }
  .mill-badge.muted   .mill-badge-title { color: var(--mill-muted);   }

  /* ─ Input ─ */
  .mill-field { display: flex; flex-direction: column; gap: 6px; }
  .mill-label { font-size: 13px; color: var(--mill-text-secondary); font-weight: 500; }
  .mill-input, .mill-textarea {
    background: var(--mill-inset);
    border: 1px solid var(--mill-border);
    border-radius: 10px; padding: 11px 14px;
    color: var(--mill-text); font-size: 13px;
    font-family: var(--mill-font); outline: none; width: 100%; resize: vertical;
    transition: border-color 0.15s;
  }
  .mill-input:focus, .mill-textarea:focus { border-color: var(--mill-border-light); }
  .mill-input.mono, .mill-textarea.mono { font-family: var(--mill-font-mono); }
  .mill-input.error, .mill-textarea.error { border-color: var(--mill-danger); }
  .mill-input::placeholder, .mill-textarea::placeholder { color: var(--mill-muted); }
  .mill-hint  { font-size: 12px; color: var(--mill-muted); line-height: 1.4; }
  .mill-error { font-size: 12px; color: var(--mill-danger); }

  /* ─ Buttons ─ */
  .mill-btn {
    border-radius: 10px; padding: 11px 20px; font-size: 14px; font-weight: 600;
    font-family: var(--mill-font); cursor: pointer;
    display: inline-flex; align-items: center; justify-content: center; gap: 6px;
    transition: opacity 0.15s, filter 0.15s; border: 1px solid transparent;
  }
  .mill-btn:disabled { opacity: 0.42; cursor: not-allowed; }
  .mill-btn:not(:disabled):hover { filter: brightness(1.12); }
  .mill-btn.primary  { background: var(--mill-accent);     color: #fff; border-color: var(--mill-accent); }
  .mill-btn.secondary{ background: var(--mill-accent-dim); color: var(--mill-accent); border-color: var(--mill-border-light); }
  .mill-btn.ghost    { background: transparent; color: var(--mill-text-secondary); border-color: var(--mill-border); }
  .mill-btn.danger   { background: var(--mill-danger-dim); color: var(--mill-danger); border-color: var(--mill-danger); }
  .mill-btn.teal     { background: var(--mill-teal-dim);   color: var(--mill-teal);   border-color: var(--mill-teal); }
  .mill-btn.success  { background: var(--mill-success-dim);color: var(--mill-success);border-color: var(--mill-success); }
  .mill-btn.full     { width: 100%; }
  .mill-btn.small    { padding: 6px 14px; font-size: 12px; }

  /* ─ Footer row ─ */
  .mill-footer { display: flex; gap: 8px; justify-content: flex-end; margin-top: 22px; }

  /* ─ Key display ─ */
  .mill-key-box {
    background: var(--mill-inset-strong); border: 1px solid var(--mill-border);
    border-radius: 10px; padding: 10px 14px;
  }
  .mill-key-label {
    font-size: 11px; text-transform: uppercase; letter-spacing: 0.1em;
    color: var(--mill-muted); margin-bottom: 7px;
  }
  .mill-key-row { display: flex; align-items: flex-start; gap: 10px; }
  .mill-key-value {
    font-family: var(--mill-font-mono); font-size: 12px;
    word-break: break-all; flex: 1; line-height: 1.65;
    color: var(--mill-accent);
    transition: color 0.2s, text-shadow 0.2s;
  }
  .mill-key-value.redacted {
    color: transparent;
    text-shadow: 0 0 10px var(--mill-accent);
    user-select: none;
  }
  .mill-key-actions { display: flex; gap: 5px; flex-shrink: 0; margin-top: 2px; }

  /* ─ Spinner ─ */
  .mill-spinner {
    border-radius: 50%;
    border-top-color: var(--mill-accent);
    animation: millSpin 0.9s linear infinite;
  }

  /* ─ Tab bar ─ */
  .mill-tabs {
    display: flex; background: var(--mill-inset);
    border-radius: 10px; padding: 4px; gap: 4px;
  }
  .mill-tab {
    flex: 1; padding: 8px 0; border-radius: 8px; font-size: 13px; font-weight: 600;
    cursor: pointer; font-family: var(--mill-font);
    background: transparent; border: 1px solid transparent;
    color: var(--mill-muted); transition: all 0.15s;
  }
  .mill-tab.active {
    background: var(--mill-card);
    border-color: var(--mill-border-light);
    color: var(--mill-text);
  }

  /* ─ Perm pill ─ */
  .mill-perm-pill { display: flex; gap: 3px; }
  .mill-perm-opt {
    padding: 4px 10px; border-radius: 20px; font-size: 11.5px; font-weight: 600;
    cursor: pointer; font-family: var(--mill-font); border: 1px solid var(--mill-border);
    color: var(--mill-muted); background: transparent; transition: all 0.15s;
  }

  /* ─ Check item ─ */
  .mill-check-item {
    display: flex; gap: 12px; align-items: flex-start;
    padding: 12px 14px; border-radius: 10px; cursor: pointer;
    background: var(--mill-inset); border: 1px solid var(--mill-border);
    transition: all 0.15s;
  }
  .mill-check-item.checked {
    background: var(--mill-success-dim);
    border-color: var(--mill-success);
  }
  .mill-check-box {
    width: 18px; height: 18px; border-radius: 4px; flex-shrink: 0;
    margin-top: 1px; display: flex; align-items: center; justify-content: center;
    font-size: 11px; color: #fff; transition: all 0.15s;
    background: transparent; border: 2px solid var(--mill-border-light);
  }
  .mill-check-item.checked .mill-check-box {
    background: var(--mill-success); border-color: var(--mill-success);
  }

  /* ─ Method card ─ */
  .mill-method-card {
    display: flex; align-items: center; gap: 14px;
    padding: 14px 16px; background: var(--mill-card);
    border: 1px solid var(--mill-border); border-radius: 12px;
    cursor: pointer; text-align: left; width: 100%;
    transition: all 0.15s; font-family: var(--mill-font);
  }
  .mill-method-card:hover {
    background: var(--mill-card-hover);
    border-color: var(--mill-border-light);
  }
  .mill-method-icon {
    width: 42px; height: 42px; border-radius: 10px;
    background: var(--mill-inset); border: 1px solid var(--mill-border);
    display: flex; align-items: center; justify-content: center;
    font-size: 20px; flex-shrink: 0;
  }
  .mill-method-name  { font-size: 14.5px; font-weight: 600; color: var(--mill-text); }
  .mill-method-sub   { font-size: 11px; color: var(--mill-muted); font-family: var(--mill-font-mono); }
  .mill-method-desc  { font-size: 12px; color: var(--mill-text-secondary); line-height: 1.5; margin-top: 2px; }
  .mill-method-badge {
    font-size: 11px; font-weight: 600; border-radius: 20px;
    padding: 2px 8px; white-space: nowrap; border: 1px solid transparent;
  }
  .mill-arrow { font-size: 16px; color: var(--mill-muted); }

  /* ─ Divider ─ */
  .mill-divider { height: 1px; background: var(--mill-border); margin: 4px 0; }

  /* ─ Connected screen ─ */
  .mill-connected {
    display: flex; flex-direction: column; align-items: center; gap: 18px; padding: 8px 0 4px;
  }
  .mill-connected-avatar {
    width: 76px; height: 76px; border-radius: 50%;
    display: flex; align-items: center; justify-content: center; font-size: 34px;
    border: 2px solid;
  }

  /* ─ Signing permissions editor ─ */
  .mill-perm { display: flex; flex-direction: column; gap: 8px; }

  /* Collapsed summary — the default view. Full editor is opt-in. */
  .mill-perm-summary {
    display: flex; align-items: center; gap: 11px;
    padding: 12px 14px;
    background: var(--mill-inset);
    border: 1px solid var(--mill-border);
    border-radius: 10px;
  }
  .mill-perm-summary-text { flex: 1; min-width: 0; }
  .mill-perm-summary-title {
    font-size: 13px; font-weight: 600; margin-bottom: 2px;
    display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
  }
  .mill-perm-summary-sub {
    font-size: 11.5px; color: var(--mill-text-secondary); line-height: 1.5;
  }
  .mill-perm-toggle {
    background: none; border: 1px solid var(--mill-border-light);
    color: var(--mill-text-secondary);
    font-family: var(--mill-font); font-size: 11.5px; font-weight: 600;
    padding: 6px 12px; border-radius: 8px; cursor: pointer;
    flex-shrink: 0; transition: all 0.15s; white-space: nowrap;
  }
  .mill-perm-toggle:hover { color: var(--mill-text); border-color: var(--mill-accent); }

  .mill-perm-legend {
    display: flex; flex-direction: column; gap: 4px;
    margin-bottom: 2px; font-size: 11.5px;
  }
  .mill-perm-legend-row {
    display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap;
  }

  .mill-perm-row {
    display: flex; align-items: center; justify-content: space-between;
    gap: 10px; padding: 9px 12px;
    background: var(--mill-inset);
    border: 1px solid var(--mill-border);
    border-radius: 10px;
  }
  .mill-perm-row-left {
    display: flex; gap: 9px; align-items: center; min-width: 0;
  }
  .mill-perm-row-label { font-size: 13px; font-weight: 500; }
  .mill-perm-row-kinds {
    font-size: 10.5px; color: var(--mill-muted); font-family: var(--mill-font-mono);
  }
  .mill-perm-pills {
    display: flex; gap: 3px; flex-shrink: 0;
    background: var(--mill-inset); border-radius: 20px; padding: 3px;
  }
  .mill-perm-pill {
    display: flex; align-items: center; gap: 4px;
    padding: 4px 11px; border-radius: 16px;
    font-family: var(--mill-font); font-size: 11.5px; font-weight: 600;
    border: 1px solid transparent; cursor: pointer;
    transition: all 0.15s; white-space: nowrap;
  }
  .mill-perm-pill-sub { font-size: 10px; opacity: 0.7; }

  /* ─ Signing consent card ─ */
  .mill-consent-head {
    display: flex; align-items: flex-start; gap: 12px;
    padding: 14px; border-radius: 12px;
    background: var(--mill-inset); border: 1px solid var(--mill-border);
  }
  .mill-consent-icon { font-size: 26px; line-height: 1; flex-shrink: 0; }
  .mill-consent-ask { font-size: 15px; line-height: 1.45; min-width: 0; }
  .mill-consent-kind { font-weight: 700; color: var(--mill-accent); }
  .mill-consent-as {
    font-size: 11.5px; color: var(--mill-muted); margin-top: 4px;
    overflow-wrap: anywhere;
  }

  .mill-consent-toggle {
    background: none; border: none; cursor: pointer;
    color: var(--mill-text-secondary); font-family: var(--mill-font);
    font-size: 12px; font-weight: 600; padding: 6px 0;
    display: flex; align-items: center; gap: 5px; align-self: flex-start;
  }
  .mill-consent-toggle:hover { color: var(--mill-text); }

  .mill-consent-details {
    background: var(--mill-inset); border: 1px solid var(--mill-border);
    border-radius: 10px; overflow: hidden;
  }
  .mill-consent-field {
    display: flex; gap: 10px; padding: 8px 12px;
    border-bottom: 1px solid var(--mill-border); font-size: 12px;
  }
  .mill-consent-field:last-child { border-bottom: none; }
  .mill-consent-field-k {
    color: var(--mill-muted); text-transform: uppercase; letter-spacing: 0.08em;
    font-size: 10px; font-weight: 600; width: 62px; flex-shrink: 0; padding-top: 2px;
  }
  .mill-consent-field-v {
    min-width: 0; flex: 1; overflow-wrap: anywhere; white-space: pre-wrap;
    font-family: var(--mill-font-mono); line-height: 1.5;
    max-height: 140px; overflow-y: auto;
  }

  .mill-consent-remember { display: flex; flex-direction: column; gap: 7px; }
  .mill-consent-remember-label {
    font-size: 11px; text-transform: uppercase; letter-spacing: 0.1em;
    color: var(--mill-muted); font-weight: 600;
  }
  .mill-consent-durations { display: flex; flex-wrap: wrap; gap: 5px; }
  .mill-consent-dur {
    padding: 5px 11px; border-radius: 16px;
    font-family: var(--mill-font); font-size: 11.5px; font-weight: 600;
    border: 1px solid var(--mill-border); background: transparent;
    color: var(--mill-muted); cursor: pointer; transition: all 0.15s;
    white-space: nowrap;
  }
  .mill-consent-dur.active {
    border-color: var(--mill-accent); color: var(--mill-accent);
    background: color-mix(in srgb, var(--mill-accent) 13%, transparent);
  }
  .mill-consent-manage {
    background: none; border: none; cursor: pointer; padding: 0;
    color: var(--mill-muted); font-family: var(--mill-font);
    font-size: 11.5px; text-decoration: underline; align-self: flex-start;
  }
  .mill-consent-manage:hover { color: var(--mill-text-secondary); }

  /* ─ Permissions management ─ */
  .mill-grant-row {
    display: flex; align-items: center; justify-content: space-between;
    gap: 10px; padding: 9px 12px;
    background: var(--mill-inset); border: 1px solid var(--mill-border);
    border-radius: 10px;
  }
  .mill-grant-left { min-width: 0; }
  .mill-grant-kind { font-size: 13px; font-weight: 500; }
  .mill-grant-meta {
    font-size: 10.5px; color: var(--mill-muted); font-family: var(--mill-font-mono);
  }
  .mill-grant-actions { display: flex; gap: 4px; flex-shrink: 0; }
  .mill-grant-btn {
    padding: 4px 10px; border-radius: 14px;
    font-family: var(--mill-font); font-size: 11px; font-weight: 600;
    border: 1px solid transparent; background: transparent;
    color: var(--mill-muted); cursor: pointer; transition: all 0.15s;
  }

  /* Narrow viewports: stack the pills under the label so nothing overflows.
     Rules must live here (not inline) so this media query can win. */
  @media (max-width: 460px) {
    .mill-grant-row { flex-direction: column; align-items: stretch; gap: 8px; }
    .mill-grant-actions { width: 100%; }
    .mill-grant-btn { flex: 1; }
    .mill-consent-dur { flex: 1 1 auto; text-align: center; }
    .mill-perm-row { flex-direction: column; align-items: stretch; gap: 8px; }
    .mill-perm-pills { width: 100%; }
    .mill-perm-pill { flex: 1; justify-content: center; padding: 6px 8px; }
    .mill-perm-pill-sub { display: none; }
    .mill-perm-summary { flex-direction: column; align-items: stretch; gap: 10px; }
    .mill-perm-toggle { width: 100%; padding: 8px 12px; }
  }

  /* ─ Configurable modal footer ─ */
  .mill-modal-footer {
    margin-top: 18px; padding-top: 12px;
    border-top: 1px solid var(--mill-border);
    display: flex; flex-direction: column; gap: 8px;
  }
  .mill-foot-row {
    display: flex; align-items: center; justify-content: space-between;
    gap: 10px; flex-wrap: wrap;
  }
  .mill-foot-text {
    font-size: 11.5px; color: var(--mill-muted); line-height: 1.5;
  }
  .mill-foot-links { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
  .mill-foot-sep { color: var(--mill-border-light); font-size: 11px; }
  .mill-foot-link {
    font-size: 11.5px; font-weight: 600; color: var(--mill-accent);
    text-decoration: none;
  }
  .mill-foot-link:hover { text-decoration: underline; }
  .mill-foot-attr {
    display: inline-flex; align-items: center; gap: 6px; align-self: center;
    font-size: 10.5px; color: var(--mill-muted); text-decoration: none;
    transition: color 0.15s;
  }
  .mill-foot-attr:hover { color: var(--mill-text-secondary); }
  .mill-foot-attr-dot {
    width: 5px; height: 5px; border-radius: 50%;
    background: var(--mill-accent); box-shadow: 0 0 6px var(--mill-accent);
    display: inline-block; flex-shrink: 0;
  }
`;

// ── HTML builder helpers ──────────────────────────────────────────────────────
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined) continue;
    el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return el;
}

// A method icon may be an emoji string or a function that builds a node (used
// for real brand logos). Normalise to something h() can append.
function iconNode(icon, size) {
  return typeof icon === 'function' ? icon(size) : icon;
}

// Official multi-colour Google "G". Its brand colours are fixed by design and
// intentionally NOT themed — recolouring it would be both wrong and off-brand.
// Everything around it (tile, text, borders) still follows the palette.
// The G on a white rounded tile — Google's prescribed presentation on coloured
// or dark buttons, where the bare multi-colour mark would clash. Used on the
// primary "Continue with Google" button.
function googleLogoOnWhite(size = 18) {
  const pad = Math.round(size * 0.28);
  const tile = h('span', { style: {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    width: `${size + pad * 2}px`, height: `${size + pad * 2}px`,
    background: '#fff', borderRadius: '5px', flexShrink: '0',
  } });
  tile.appendChild(googleLogo(size));
  return tile;
}

function googleLogo(size = 22) {
  const span = h('span', { style: { display: 'inline-flex', width: `${size}px`, height: `${size}px`, lineHeight: '0' } });
  span.innerHTML =
    `<svg viewBox="0 0 48 48" width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg" aria-label="Google" role="img">` +
    `<path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>` +
    `<path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>` +
    `<path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.28-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>` +
    `<path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>` +
    `</svg>`;
  return span;
}

function badge(type, icon, title, body) {
  return h('div', { class: `mill-badge ${type}` },
    icon && h('span', { class: 'mill-badge-icon' }, icon),
    h('div', {},
      title && h('div', { class: 'mill-badge-title' }, title),
      h('div', { class: 'mill-badge-body' }, body)
    )
  );
}

function btn(label, variant, onClick, disabled = false) {
  // label may be a string, or an array of children (e.g. [logo, 'text']) so a
  // button can carry a brand logo alongside its text.
  const b = h('button', { class: `mill-btn ${variant}`, onClick }, ...[].concat(label));
  if (disabled) b.disabled = true;
  return b;
}

function progress(total, current) {
  const wrap = h('div', { class: 'mill-progress' });
  for (let i = 0; i < total; i++) {
    const seg = h('div', { class: 'mill-progress-seg' });
    if (i < current)  seg.classList.add('done');
    if (i === current) seg.classList.add('active');
    wrap.appendChild(seg);
  }
  return wrap;
}

function keyDisplay(label, value, redact = false) {
  let revealed = !redact;
  const code = h('code', { class: `mill-key-value${redact ? ' redacted' : ''}` }, value);
  const showBtn = redact ? btn(revealed ? 'Hide' : 'Show', 'ghost small', () => {
    revealed = !revealed;
    if (revealed) code.classList.remove('redacted'); else code.classList.add('redacted');
    showBtn.textContent = revealed ? 'Hide' : 'Show';
  }) : null;

  let copied = false;
  const copyBtn = btn('Copy', 'ghost small', () => {
    try { navigator.clipboard.writeText(value); } catch(e) {}
    if (!copied) {
      copied = true; copyBtn.textContent = '✓';
      copyBtn.style.color = 'var(--mill-success)';
      setTimeout(() => { copied = false; copyBtn.textContent = 'Copy'; copyBtn.style.color = ''; }, 2000);
    }
  });

  return h('div', { class: 'mill-key-box' },
    h('div', { class: 'mill-key-label' }, label),
    h('div', { class: 'mill-key-row' },
      code,
      h('div', { class: 'mill-key-actions' },
        ...[showBtn, copyBtn].filter(Boolean)
      )
    )
  );
}

function field(label, placeholder, value, onChange, { mono = false, type = 'text', hint, error, rows, inputmode, maxlength } = {}) {
  const wrap = h('div', { class: 'mill-field' });
  if (label) wrap.appendChild(h('label', { class: 'mill-label' }, label));
  const input = rows
    ? h('textarea', { class: `mill-textarea${mono ? ' mono' : ''}${error ? ' error' : ''}`, placeholder, rows: String(rows) })
    : h('input', { class: `mill-input${mono ? ' mono' : ''}${error ? ' error' : ''}`, placeholder, type });
  if (inputmode) input.setAttribute('inputmode', inputmode);
  if (maxlength) input.setAttribute('maxlength', String(maxlength));
  input.value = value;
  input.addEventListener('input', e => onChange(e.target.value));
  wrap.appendChild(input);
  if (hint && !error) wrap.appendChild(h('div', { class: 'mill-hint' }, hint));
  if (error) wrap.appendChild(h('div', { class: 'mill-error' }, error));
  return { wrap, input };
}

// Render a QR code for the given text into a 200x200 SVG element.
// Uses qrcode-generator (typeNumber 0 = auto, errorCorrectLevel L = densest packing).
function qr(text, { size = 200 } = {}) {
  const qr = qrcode(0, 'L');
  qr.addData(text);
  qr.make();
  // qrcode-generator's createSvgTag returns a string; we wrap it for sizing/color theming
  const wrap = h('div', {
    style: {
      width: `${size}px`, height: `${size}px`,
      background: '#fff', padding: '12px', borderRadius: '10px',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    },
  });
  wrap.innerHTML = qr.createSvgTag({ scalable: true, margin: 0 });
  const svg = wrap.querySelector('svg');
  if (svg) { svg.setAttribute('width', '100%'); svg.setAttribute('height', '100%'); svg.style.display = 'block'; }
  return wrap;
}

function spinner(color = 'var(--mill-accent)', size = 36) {
  const el = h('div', { class: 'mill-spinner' });
  Object.assign(el.style, { width: `${size}px`, height: `${size}px`, border: `3px solid var(--mill-border)`, borderTopColor: color });
  return el;
}

function flowWrap({ step, total, title, subtitle, onBack }) {
  const wrap = h('div', {});
  if (total > 1) wrap.appendChild(progress(total, step));
  if (onBack) {
    const b = h('button', { class: 'mill-back', onClick: onBack }, '← Back');
    wrap.appendChild(b);
  }
  wrap.appendChild(h('div', { class: 'mill-title' }, title));
  if (subtitle) wrap.appendChild(h('div', { class: 'mill-subtitle' }, subtitle));
  const body = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } });
  wrap.appendChild(body);
  const footer = h('div', { class: 'mill-footer' });
  wrap.appendChild(footer);
  return { wrap, body, footer };
}

// ── Signing behavior editor ───────────────────────────────────────────────────
// Plain-language description of the current policy, for the collapsed summary.
// Most users never open the editor, so this line has to carry the meaning on
// its own — no jargon, no kind numbers.
function permsSummary(perms) {
  const ids      = SIGN_CATS.map(c => c.id);
  const isCustom = ids.some(id => perms[id] !== SIGN_CATS.find(c => c.id === id).def);
  if (!isCustom) return 'Posts and reactions are signed automatically. Profile, follows, messages, and zaps are shown to you first.';

  const session = SIGN_CATS.filter(c => perms[c.id] === 'session');
  if (!session.length)             return 'Every request is shown to you before anything is signed.';
  if (session.length === ids.length) return 'Everything is signed automatically until you close this tab.';
  const names = session.map(c => c.label.toLowerCase());
  const list  = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
  return `Automatic for ${list}. Everything else is shown to you first.`;
}

function signingBehaviorEditor(perms) {
  const wrap = h('div', { class: 'mill-perm' });

  // Collapsed by default: the defaults are sensible, and the full six-category
  // grid is a lot of screen for a decision most users don't want to make.
  let open = false;
  const summary = h('div', { class: 'mill-perm-summary' });
  const details = h('div', { class: 'mill-perm', style: { display: 'none' } });

  const summaryText = h('div', { class: 'mill-perm-summary-sub' });
  const toggle = h('button', { class: 'mill-perm-toggle', type: 'button' });

  const refreshSummary = () => { summaryText.textContent = permsSummary(perms); };
  const applyOpen = () => {
    details.style.display = open ? 'flex' : 'none';
    toggle.textContent    = open ? 'Done' : 'Customize';
    toggle.setAttribute('aria-expanded', String(open));
    refreshSummary();
  };
  toggle.onclick = () => { open = !open; applyOpen(); };

  summary.appendChild(h('div', { class: 'mill-perm-summary-text' },
    h('div', { class: 'mill-perm-summary-title' },
      h('span', {}, '🔐'),
      h('span', {}, 'Signing permissions'),
      h('span', { style: { fontSize: '10.5px', fontWeight: '600', color: 'var(--mill-success)', textTransform: 'uppercase', letterSpacing: '0.08em' } }, 'Recommended')
    ),
    summaryText
  ));
  summary.appendChild(toggle);
  wrap.appendChild(summary);

  // Legend with descriptions
  const legend = h('div', { class: 'mill-perm-legend' });
  PERM_OPTS.forEach(o => {
    legend.appendChild(h('div', { class: 'mill-perm-legend-row' },
      h('span', {}, o.icon),
      h('span', { style: { fontWeight: '600', color: o.color } }, `${o.label} ${o.sublabel}`),
      h('span', { style: { color: 'var(--mill-muted)' } }, '—'),
      h('span', { style: { color: 'var(--mill-text-secondary)' } }, o.desc)
    ));
  });
  details.appendChild(legend);

  SIGN_CATS.forEach(cat => {
    const row = h('div', { class: 'mill-perm-row' });
    const left = h('div', { class: 'mill-perm-row-left' },
      h('span', { style: { fontSize: '17px' } }, cat.icon),
      h('div', { style: { minWidth: '0' } },
        h('div', { class: 'mill-perm-row-label' }, cat.label),
        h('div', { class: 'mill-perm-row-kinds' }, cat.desc)
      )
    );
    const pillBox = h('div', { class: 'mill-perm-pills' });
    PERM_OPTS.forEach(o => {
      const apply = (el, active) => {
        el.style.background  = active ? o.color + '22' : 'transparent';
        el.style.borderColor = active ? o.color : 'transparent';
        el.style.color       = active ? o.color : 'var(--mill-muted)';
      };
      const p = h('button', {
        class: 'mill-perm-pill',
        type: 'button',
        onClick: () => {
          perms[cat.id] = o.id;
          pillBox.querySelectorAll('button').forEach((pp, i) => apply(pp, PERM_OPTS[i].id === o.id));
          refreshSummary();
        },
      },
        h('span', { style: { fontSize: '11px' } }, o.icon),
        h('span', {}, o.label),
        h('span', { class: 'mill-perm-pill-sub' }, o.sublabel)
      );
      apply(p, perms[cat.id] === o.id);
      pillBox.appendChild(p);
    });
    row.appendChild(left); row.appendChild(pillBox);
    details.appendChild(row);
  });

  details.appendChild(badge('muted', 'ℹ️', null,
    'Anything set to Review shows you the event before it is signed, and you can remember that answer per kind at that point. Applies to private-key signing only — NIP-07, NIP-46, and NIP-55 approve requests in their own extension or app.'
  ));
  wrap.appendChild(details);
  applyOpen();
  return wrap;
}

// ── Flow: Method Selection ────────────────────────────────────────────────────
function renderMethodSelection(host, onSelect, opts = {}) {
  const methodFilter = opts.methodFilter;
  const density      = opts.density || 'comfortable';      // 'compact' hides descs, smaller padding
  const layout       = opts.layout  || 'list';             // 'list' or 'grid'
  // callout: undefined → default 'newkey', null/false → disabled, string → that method id
  const calloutId    = opts.callout === undefined ? 'newkey' : opts.callout;
  const wrap = h('div', {});

  wrap.appendChild(renderBrandHeader(opts.header));

  // methodFilter accepts:
  //   undefined / [] → show all defaults (newkey appears as a separated callout above sign-in methods)
  //   ['nip07', 'nip46']           → only these, in this order; newkey is treated as just another card
  //   [{ id: 'nip07', label: 'My Ext', icon: '⚡' }, ...]  → override built-in fields
  // Google login only makes sense once the host has deployed an OAuth shim, so
  // it appears in the default picker only when configured. An explicit methods:
  // list still shows it if asked (clicking without a shim shows a clear
  // "not configured" screen rather than failing silently).
  // Two Google paths, each opt-in via config: pomegranate (FROST, cross-client)
  // when `pomegranate` is set — `true`/`{}` uses the njump ecosystem defaults, or
  // pass { central, operators, threshold } to self-host — and Drive+PIN (per-app)
  // when an oauth-shim is set. Pomegranate takes precedence so there's never a
  // double "Continue with Google". A "Google" affordance is available if either.
  const pomegranateAvailable = !!(host?._state?.pomegranate);
  const drivePinAvailable    = !!host?.getAttribute?.('oauth-shim');
  const googleAvailable      = pomegranateAvailable || drivePinAvailable;
  const explicit = Array.isArray(methodFilter) && methodFilter.length;
  const resolved = explicit
    ? methodFilter.map(entry => {
        const id = typeof entry === 'string' ? entry : entry?.id;
        const base = METHODS_LIST.find(m => m.id === id);
        if (!base) return null;
        return typeof entry === 'object' ? { ...base, ...entry } : base;
      }).filter(Boolean)
    : METHODS_LIST.filter(m => {
        if (DEFAULT_HIDDEN_METHODS.has(m.id)) return false;
        if (m.id === 'pomegranate') return pomegranateAvailable;
        if (m.id === 'google')      return drivePinAvailable && !pomegranateAvailable;
        return true;
      });

  // Callout: when not explicit AND callout id is enabled and present, separate it out.
  // When the consumer explicitly orders methods, respect their order (no separation) unless callout was explicitly set.
  const calloutEnabled = calloutId && (!explicit || opts.callout !== undefined);
  const calloutEntry   = calloutEnabled ? resolved.find(m => m.id === calloutId) : null;
  const signInList     = calloutEntry ? resolved.filter(m => m.id !== calloutId) : resolved;

  if (calloutEntry) {
    // When Google login is configured, "I'm new here" opens a chooser
    // (Continue with Google / Generate my own keys) instead of jumping
    // straight to key generation. With no Google shim set, behaviour is
    // unchanged — existing hosts see exactly the same screen as before.
    const calloutTarget = (calloutId === 'newkey' && googleAvailable) ? '_newhere' : calloutId;
    // Per-method callout copy. Default New-Identity copy if it's newkey.
    const calloutCopy = calloutId === 'newkey'
      ? { headline: "I'm new here!", subline: googleAvailable
          ? 'Get started in seconds. No email, no keys to manage.'
          : 'Create a new Nostr identity in seconds — no email, no signup.' }
      : { headline: calloutEntry.label, subline: calloutEntry.sub || '' };
    const callout = h('button', {
      class: 'mill-method-card',
      onClick: () => onSelect(calloutTarget),
      style: { padding: '10px 14px', background: 'var(--mill-accent-dim)', borderColor: 'var(--mill-accent)', borderStyle: 'dashed', marginBottom: '14px' },
    });
    callout.appendChild(h('div', { class: 'mill-method-icon', style: { width: '32px', height: '32px', fontSize: '17px' } }, iconNode(calloutEntry.icon, 18)));
    const txt = h('div', { style: { flex: '1', minWidth: '0' } });
    txt.appendChild(h('div', { style: { fontSize: '13.5px', fontWeight: '600', color: 'var(--mill-accent)' } }, calloutCopy.headline));
    txt.appendChild(h('div', { style: { fontSize: '12px', color: 'var(--mill-text-secondary)', marginTop: '2px', lineHeight: '1.4' } }, calloutCopy.subline));
    callout.appendChild(txt);
    callout.appendChild(h('span', { class: 'mill-arrow', style: { color: 'var(--mill-accent)' } }, '→'));
    wrap.appendChild(callout);

    wrap.appendChild(h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', margin: '4px 0 12px' } },
      h('div', { style: { flex: '1', height: '1px', background: 'var(--mill-border)' } }),
      h('span', { style: { fontSize: '10.5px', textTransform: 'uppercase', letterSpacing: '0.12em', color: 'var(--mill-muted)', fontWeight: '600' } }, 'or sign in'),
      h('div', { style: { flex: '1', height: '1px', background: 'var(--mill-border)' } })
    ));
  }

  const isCompact = density === 'compact';
  const isGrid    = layout === 'grid';

  const list = h('div', {
    style: isGrid
      ? { display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: isCompact ? '8px' : '10px' }
      : { display: 'flex', flexDirection: 'column', gap: isCompact ? '6px' : '10px' },
  });

  signInList.forEach(m => {
    const card = h('button', {
      class: 'mill-method-card',
      style: isCompact ? { padding: '10px 12px', gap: '10px' } : {},
      onClick: () => onSelect(m.id),
    });

    // Icon
    const iconEl = h('div', {
      class: 'mill-method-icon',
      style: isCompact ? { width: '32px', height: '32px', fontSize: '16px', flexShrink: '0' } : {},
    }, iconNode(m.icon, isCompact ? 18 : 24));
    card.appendChild(iconEl);

    // Middle: name (+ sub label inline if comfortable, or hidden if compact)
    const mid = h('div', { style: { flex: '1', minWidth: '0', display: 'flex', flexDirection: 'column', gap: '2px' } });
    const nameRow = h('div', { style: { display: 'flex', gap: '6px', alignItems: 'baseline', flexWrap: 'wrap' } });
    nameRow.appendChild(h('span', { class: 'mill-method-name', style: isCompact ? { fontSize: '13.5px' } : {} }, m.label));
    if (!isCompact) nameRow.appendChild(h('span', { class: 'mill-method-sub' }, m.sub));
    mid.appendChild(nameRow);
    if (!isCompact && !isGrid && m.desc) mid.appendChild(h('div', { class: 'mill-method-desc' }, m.desc));
    card.appendChild(mid);

    // Right: security badge (only in comfortable list mode); arrow always
    const right = h('div', { style: { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '6px', flexShrink: '0' } });
    if (!isCompact && !isGrid) {
      const secBadge = h('span', { class: 'mill-method-badge' }, m.secLabel);
      secBadge.style.color = m.secColor;
      secBadge.style.background = m.secColor.replace(')', ' / 0.12)').replace('var(', 'color-mix(in srgb, var(');
      secBadge.style.borderColor = m.secColor + '44';
      right.appendChild(secBadge);
    }
    right.appendChild(h('span', { class: 'mill-arrow' }, '→'));
    card.appendChild(right);

    list.appendChild(card);
  });
  wrap.appendChild(list);

  // Picker tip. `opts.tip === false` hides it; a string overrides it; undefined
  // shows the default recommendation.
  if (opts.tip !== false) {
    const tip = h('p', { style: { marginTop: '16px', fontSize: '11.5px', color: 'var(--mill-muted)', textAlign: 'center', lineHeight: '1.6' } });
    if (typeof opts.tip === 'string') tip.textContent = opts.tip;
    else tip.innerHTML = 'Not sure? <span style="color:var(--mill-accent);cursor:pointer">NIP-07 browser extension</span> is recommended.';
    wrap.appendChild(tip);
  }

  const foot = renderFooter(opts.footer);
  if (foot) wrap.appendChild(foot);

  return wrap;
}

const isImageUrl = s => typeof s === 'string' && /^(https?:\/\/|\/|data:image\/)/.test(s.trim());

// The picker header / brand block.
//
// header = { logo?, logoHeight?, title?, message?, align?, label? }
//   logo       — image URL (PNG/SVG/…) rendered at its natural size, or a short
//                emoji/text. A broken image URL is dropped silently.
//   logoHeight — px height for image logos (default 44).
//   title      — main title.
//   message    — a short line under the title.
//   align      — 'left' (default) | 'center'.
//
// With no branding fields set, mill shows its own default header. As soon as any
// of logo/title/message is provided, the block is fully the host's — no mill
// wording leaks in. (`label` styles the modal's top strip, handled elsewhere.)
function renderBrandHeader(header) {
  const hd = header || {};
  const custom = hd.logo || hd.title || hd.message;
  const align = hd.align === 'center' ? 'center' : 'left';
  const hdr = h('div', { style: {
    marginBottom: '22px', display: 'flex', flexDirection: 'column', gap: '10px',
    alignItems: align === 'center' ? 'center' : 'flex-start', textAlign: align,
  } });

  if (!custom) {
    // Default mill header: small mark tile + eyebrow, heading, description.
    const tile = h('div', { style: { width: '32px', height: '32px', borderRadius: '8px', background: 'var(--mill-accent-dim)', border: '1px solid var(--mill-border-light)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '16px' } }, '⚡');
    hdr.style.gap = '6px';
    hdr.appendChild(h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px' } },
      tile,
      h('span', { style: { fontSize: '12px', textTransform: 'uppercase', letterSpacing: '0.12em', color: 'var(--mill-muted)', fontWeight: '600' } }, 'Nostr Signer'),
    ));
    hdr.appendChild(h('div', { style: { fontSize: '22px', fontWeight: '700' } }, 'Connect Your Account'));
    hdr.appendChild(h('div', { style: { fontSize: '13px', color: 'var(--mill-text-secondary)', lineHeight: '1.55' } },
      'Choose how to access this Nostr client. Each method has different security tradeoffs.'));
    return hdr;
  }

  // Custom brand block.
  if (hd.logo) {
    if (isImageUrl(hd.logo)) {
      const img = h('img', { src: hd.logo.trim(), alt: hd.title || '', style: { height: `${hd.logoHeight || 44}px`, maxWidth: '100%', objectFit: 'contain', display: 'block' } });
      img.addEventListener('error', () => img.remove());   // no broken-image icon
      hdr.appendChild(img);
    } else {
      hdr.appendChild(h('div', { style: { fontSize: '36px', lineHeight: '1' } }, String(hd.logo).trim()));
    }
  }
  if (hd.title)   hdr.appendChild(h('div', { style: { fontSize: '22px', fontWeight: '700' } }, hd.title));
  if (hd.message) hdr.appendChild(h('div', { style: { fontSize: '13px', color: 'var(--mill-text-secondary)', lineHeight: '1.55', maxWidth: '340px' } }, hd.message));
  return hdr;
}

// Where mill's "Signer by MILL" attribution points by default. A host can
// override it (footer.attributionHref) or turn it off (footer.attribution:false).
const DEFAULT_MILL_URL = 'https://github.com/0ceanslim/nostr-mill';

// Configurable modal footer shown under the method picker. Two independent
// parts, both optional:
//   - the host's own line: a tagline + links (Terms / Privacy / …)
//   - a small "Signer by MILL" attribution, ON by default, toggleable
// footer = { text?, links?: [{label, href}], attribution?: boolean, attributionHref? }
function renderFooter(footer = {}) {
  const links = Array.isArray(footer.links) ? footer.links.filter(l => l && l.label && l.href) : [];
  const hasHostRow = !!footer.text || links.length > 0;
  const showAttr = footer.attribution !== false;   // default on
  if (!hasHostRow && !showAttr) return null;

  const bar = h('div', { class: 'mill-modal-footer' });

  if (hasHostRow) {
    const row = h('div', { class: 'mill-foot-row' });
    if (footer.text) row.appendChild(h('span', { class: 'mill-foot-text' }, footer.text));
    if (links.length) {
      const lw = h('div', { class: 'mill-foot-links' });
      links.forEach((l, i) => {
        if (i) lw.appendChild(h('span', { class: 'mill-foot-sep' }, '·'));
        lw.appendChild(h('a', { class: 'mill-foot-link', href: l.href, target: '_blank', rel: 'noopener noreferrer' }, l.label));
      });
      row.appendChild(lw);
    }
    bar.appendChild(row);
  }

  if (showAttr) {
    const a = h('a', {
      class: 'mill-foot-attr',
      href: footer.attributionHref || DEFAULT_MILL_URL,
      target: '_blank', rel: 'noopener noreferrer',
      title: 'Add Nostr login to your own app with MILL',
    }, h('span', { class: 'mill-foot-attr-dot' }), h('span', {}, 'Signer by MILL'));
    bar.appendChild(a);
  }

  return bar;
}

// ── Flow: Read Only ───────────────────────────────────────────────────────────
function renderReadOnlyFlow(host, onDone, onBack) {
  let step = 0, keyVal = '';
  const container = h('div', {});

  function render() {
    container.innerHTML = '';
    if (step === 0) {
      const { wrap, body, footer } = flowWrap({ step: 0, total: 2, title: 'Read-Only Access', subtitle: 'Browse content using your public key. Cannot sign, post, react, or send zaps.', onBack });
      body.appendChild(badge('muted', '👁', 'View-only mode', 'You can read your feed, explore profiles, and view notes — but cannot post, react, follow, or send zaps.'));
      let errMsg = '';
      const { wrap: fWrap, input } = field('Public Key', 'npub1… or 64-char hex pubkey', keyVal, v => { keyVal = v; errMsg = ''; }, { mono: true });
      body.appendChild(fWrap);
      body.appendChild(h('div', { style: { fontSize: '12px', color: 'var(--mill-muted)', lineHeight: '1.4' } }, 'Your npub1 starts with "npub1" and is ~63 characters long.'));
      const continueBtn = btn('Continue', 'primary', () => {
        if (!isValidNpub(keyVal.trim())) { errMsg = 'Enter a valid npub1… or 64-char hex public key'; render(); return; }
        step = 1; render();
      });
      footer.appendChild(btn('Cancel', 'ghost', onBack));
      footer.appendChild(continueBtn);
      wrap.querySelector('.mill-field')?.after(errMsg ? h('div', { class: 'mill-error' }, errMsg) : null);
      container.appendChild(wrap);
    } else {
      const { wrap, body, footer } = flowWrap({ step: 1, total: 2, title: 'Confirm Public Key', subtitle: 'Connecting in read-only mode with the following identity.', onBack: () => { step = 0; render(); } });
      body.appendChild(keyDisplay('Your Public Key', keyVal.trim()));
      body.appendChild(badge('info', 'ℹ️', 'What read-only mode can do', 'View your home feed, explore profiles, read threads and replies, check notifications. Reconnect with a signing method to post.'));
      footer.appendChild(btn('Back', 'ghost', () => { step = 0; render(); }));
      footer.appendChild(btn('Connect Read-Only', 'primary', () => {
        const pk = npubToHex(keyVal.trim());
        onDone({ method: 'readonly', pubkey: pk, signer: createReadOnlySigner(pk) });
      }));
      container.appendChild(wrap);
    }
  }
  render();
  return container;
}

// ── Flow: NIP-07 ──────────────────────────────────────────────────────────────
function renderNIP07Flow(host, onDone, onBack) {
  let step = 0, pubkey = '', errMsg = '', loading = false;
  const container = h('div', {});

  const exts = [
    { name: 'nos2x',    desc: 'Lightweight Nostr signer — Chrome / Firefox',                 url: 'https://github.com/fiatjaf/nos2x' },
    { name: 'Nostore',  desc: 'Safari & iOS NIP-07 signer',                                  url: 'https://apps.apple.com/us/app/nostore/id1666553677' },
    { name: 'Flamingo', desc: 'Social Nostr extension — Chrome',                             url: 'https://www.getflamingo.org/' },
    { name: 'Alby',     desc: 'Bitcoin & Nostr wallet — Chrome / Firefox / Safari',          url: 'https://getalby.com/' },
  ];

  async function connect(render) {
    loading = true; errMsg = ''; render();
    try {
      if (!window.nostr) throw new Error('No NIP-07 extension installed');
      pubkey = await window.nostr.getPublicKey();
      step = 1;
    } catch(e) { errMsg = e.message || 'Permission denied. Click the extension icon and try again.'; }
    loading = false; render();
  }

  function render() {
    container.innerHTML = '';
    if (step === 0) {
      const hasExt = !!window.nostr;
      const { wrap, body, footer } = flowWrap({ step: 0, total: 2, title: 'Browser Extension (NIP-07)', subtitle: 'Delegate all signing to a NIP-07 extension. Your private key never leaves it.', onBack });
      body.appendChild(hasExt
        ? badge('success', '✅', 'Extension detected', 'A NIP-07 compatible extension is installed. Click Connect to request your public key.')
        : badge('warning', '⚠️', 'No extension found', 'Install a NIP-07 extension below, then refresh and try again.')
      );
      body.appendChild(badge('info', '🔐', 'Why extensions are the safest option', 'The extension signs events in its own isolated sandbox. This app only sees your public key and completed signed events — never your private key.'));
      if (!hasExt) {
        const extList = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '7px' } });
        extList.appendChild(h('div', { style: { fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.09em', color: 'var(--mill-muted)' } }, 'Compatible Extensions'));
        exts.forEach(ext => {
          extList.appendChild(h('a', { href: ext.url, target: '_blank', rel: 'noopener noreferrer', style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 12px', background: 'var(--mill-inset)', border: '1px solid var(--mill-border)', borderRadius: '10px', textDecoration: 'none', color: 'inherit', transition: 'border-color 0.15s' } },
            h('div', {},
              h('div', { style: { fontSize: '13.5px', fontWeight: '600', color: 'var(--mill-text)' } }, ext.name),
              h('div', { style: { fontSize: '12px', color: 'var(--mill-muted)', marginTop: '2px' } }, ext.desc)
            ),
            h('span', { style: { fontSize: '12px', color: 'var(--mill-accent)' } }, 'Install ↗')
          ));
        });
        body.appendChild(extList);
      }
      if (errMsg) body.appendChild(badge('danger', '✗', null, errMsg));
      if (loading) body.appendChild(h('div', { style: { display: 'flex', justifyContent: 'center', padding: '8px' } }, spinner()));
      const connectBtn = btn(loading ? 'Connecting…' : 'Connect Extension', 'primary', () => connect(render), loading);
      footer.appendChild(btn('Cancel', 'ghost', onBack));
      footer.appendChild(connectBtn);
      container.appendChild(wrap);
    } else {
      const { wrap, body, footer } = flowWrap({ step: 1, total: 2, title: 'Extension Connected', subtitle: 'Your public key was retrieved from the extension.', onBack: () => { step = 0; render(); } });
      body.appendChild(keyDisplay('Public Key (from extension)', pubkey));
      body.appendChild(badge('success', '✅', 'Signing delegated to extension', 'All signing requests will pop up in your extension. You can approve or reject each event individually.'));
      body.appendChild(badge('muted', '🔒', null, 'Disconnecting does not affect your extension or private key.'));
      footer.appendChild(btn('Back', 'ghost', () => { step = 0; render(); }));
      footer.appendChild(btn('Confirm Connection', 'primary', () => {
        const signer = createNIP07Signer(pubkey);
        onDone({ method: 'nip07', pubkey, signer });
      }));
      container.appendChild(wrap);
    }
  }
  render();
  return container;
}

// ── Flow: NIP-46 ──────────────────────────────────────────────────────────────
function renderNIP46Flow(host, onDone, onBack, opts = {}) {
  let step = 0, tab = 'url', urlVal = '', errMsg = '', statusMsg = '', userPk = '', nostrconnectURI = '', authUrl = '';
  let relays = (Array.isArray(opts.relays) && opts.relays.length) ? [...opts.relays] : [...DEFAULT_RELAYS];
  let showRelayEditor = false;
  let client = null;
  let logs = [];                    // live diagnostic log shown in the connecting screen
  let logsRender = null;            // function to refresh just the log area
  const container = h('div', {});

  const onLog = (entry) => {
    logs.push(entry);
    if (logs.length > 60) logs.shift();
    logsRender?.();
  };

  function makeClient() {
    // The bunker shows this name when authorizing the connection. Hosts set
    // it via MILL.open({ appName }) (or the app-name attribute); fall back to
    // the page title, then a generic label — never the literal "MILL".
    const appName = host.getAttribute?.('app-name') || document.title || 'Nostr App';
    return new NIP46Client({
      relays,
      metadata: { name: appName, url: location.origin },
      debug: false,                // quiet by default; onLog still feeds the in-modal diagnostic panel
      onLog,
      // The signer asked the user to approve at a URL. Surface it (and open it
      // for web bunkers); the connect/get_public_key promise keeps waiting and
      // resolves once the user approves, advancing the flow automatically.
      onAuthChallenge: (url) => {
        authUrl = url;
        statusMsg = 'Approve the connection in your signer…';
        if (url) { try { window.open(url, '_blank', 'noopener'); } catch (_) {} }
        render();
      },
    });
  }

  async function connectViaURL(render) {
    if (!isValidBunker(urlVal.trim())) { errMsg = 'Enter a valid bunker:// or nostrconnect:// URI'; render(); return; }
    errMsg = ''; authUrl = ''; logs = []; step = 1; statusMsg = 'Connecting to relay…'; render();
    try {
      // Bunker URI carries its own relays; they take precedence inside the client.
      client = makeClient();
      statusMsg = 'Awaiting approval on bunker…'; render();
      userPk = await client.connectViaBunker(urlVal.trim(), { timeoutMs: 90_000 });
      step = 2; render();
    } catch (e) {
      const raw = (e && e.message) || 'NIP-46 connection failed';
      // A bunker:// secret is single-use (NIP-46): once a connection is
      // established the signer rejects the old secret. Re-pasting a used or
      // expired string is the usual cause of "bad secret" — guide the user to
      // grab a fresh connection string rather than showing the raw error.
      errMsg = /secret/i.test(raw)
        ? 'That bunker connection string was already used or has expired. Open your signer and copy a fresh bunker:// string, then try again.'
        : raw;
      try { client?.disconnect(); } catch {}
      client = null;
      step = 0; render();
    }
  }

  async function startNostrConnectListener(render) {
    logs = []; step = 1; statusMsg = 'Generating connection…'; errMsg = ''; authUrl = ''; render();
    try {
      client = makeClient();
      statusMsg = 'Scan the URI with your bunker…';
      userPk = await client.connectAsListener({
        timeoutMs: 180_000,
        onURI: u => { nostrconnectURI = u; render(); },
      });
      step = 2; render();
    } catch (e) {
      errMsg = e.message || 'NIP-46 connection failed';
      try { client?.disconnect(); } catch {}
      client = null;
      step = 0; render();
    }
  }

  function renderRelayEditor(render) {
    const wrap = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px', padding: '12px', background: 'var(--mill-inset)', border: '1px solid var(--mill-border)', borderRadius: '10px' } });
    wrap.appendChild(h('div', { style: { fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--mill-muted)', fontWeight: '600' } }, 'Active relays for this connection'));

    relays.forEach((r, i) => {
      const row = h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } });
      row.appendChild(h('code', { style: { flex: '1', fontFamily: 'var(--mill-font-mono)', fontSize: '11.5px', color: 'var(--mill-text)', wordBreak: 'break-all' } }, r));
      row.appendChild(btn('×', 'ghost small', () => { relays.splice(i, 1); render(); }));
      wrap.appendChild(row);
    });

    const inputState = { v: '' };
    const { wrap: addWrap, input: addInput } = field(null, 'wss://your.relay/', '', v => inputState.v = v, { mono: true });
    const addRow = h('div', { style: { display: 'flex', gap: '6px', alignItems: 'flex-start' } });
    addRow.appendChild(addWrap);
    addRow.appendChild(btn('Add', 'ghost small', () => {
      const v = (inputState.v || '').trim();
      if (/^wss?:\/\//.test(v) && !relays.includes(v)) { relays.push(v); inputState.v = ''; render(); }
    }));
    addWrap.style.flex = '1';
    wrap.appendChild(addRow);

    const suggested = SUGGESTED_RELAYS.filter(r => !relays.includes(r));
    if (suggested.length) {
      wrap.appendChild(h('div', { style: { fontSize: '10.5px', color: 'var(--mill-muted)', marginTop: '4px' } }, 'Quick add:'));
      const chips = h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '5px' } });
      suggested.forEach(r => {
        const c = h('button', { class: 'mill-btn ghost small', style: { fontSize: '11px', padding: '3px 9px' }, onClick: () => { relays.push(r); render(); } }, r.replace(/^wss?:\/\//, ''));
        chips.appendChild(c);
      });
      wrap.appendChild(chips);
    }
    return wrap;
  }

  function render() {
    container.innerHTML = '';
    if (step === 0) {
      const { wrap, body, footer } = flowWrap({ step: 0, total: 3, title: 'Remote Signer (NIP-46)', subtitle: 'Sign events on a separate device or server. Your private key never leaves your bunker.', onBack });
      body.appendChild(badge('info', '📡', 'What is a NIP-46 remote signer?', 'A bunker keeps your private key on a device you control. This client sends signing requests to the bunker over a Nostr relay; the bunker approves them remotely.'));

      const tabs = h('div', { class: 'mill-tabs' });
      ['url', 'qr'].forEach(t => {
        const tb = h('button', { class: `mill-tab${tab === t ? ' active' : ''}`, onClick: () => { tab = t; render(); } }, t === 'url' ? 'Bunker URL' : 'QR Code');
        tabs.appendChild(tb);
      });
      body.appendChild(tabs);

      if (tab === 'url') {
        const { wrap: fw } = field('Bunker Connection String', 'bunker://pubkey?relay=wss://…&secret=…', urlVal, v => { urlVal = v; errMsg = ''; }, { mono: true, rows: 3, error: errMsg });
        body.appendChild(fw);
        body.appendChild(h('div', { class: 'mill-hint' }, 'Get this from your bunker app: nsec.app, nsecBunker, or a self-hosted bunker.'));
        if (errMsg) body.appendChild(badge('danger', '✗', null, errMsg));
        footer.appendChild(btn('Cancel', 'ghost', onBack));
        footer.appendChild(btn('Connect to Bunker', 'primary', () => connectViaURL(render)));
      } else {
        body.appendChild(badge('info', '📲', 'Nostr Connect', 'Generate a connection string for your bunker to scan or paste. Mill will wait for the bunker to contact us on the selected relays.'));
        footer.appendChild(btn('Cancel', 'ghost', onBack));
        footer.appendChild(btn('Generate Connection String', 'primary', () => startNostrConnectListener(render)));
      }

      // Relay configuration — collapsed by default
      const relaySummary = h('button', {
        class: 'mill-back',
        style: { marginTop: '4px', textAlign: 'left' },
        onClick: () => { showRelayEditor = !showRelayEditor; render(); },
      }, `${showRelayEditor ? '▾' : '▸'} Relays (${relays.length})`);
      body.appendChild(relaySummary);
      if (showRelayEditor) body.appendChild(renderRelayEditor(render));

      container.appendChild(wrap);
    } else if (step === 1) {
      const { wrap, body } = flowWrap({ step: 1, total: 3, title: 'Connecting…', subtitle: statusMsg });
      const center = h('div', { style: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '18px', padding: '16px 0' } });
      center.appendChild(spinner('var(--mill-accent)', 48));
      center.appendChild(h('div', { style: { fontSize: '13px', color: 'var(--mill-text-secondary)', textAlign: 'center' } }, statusMsg));
      body.appendChild(center);

      // Auth challenge: the signer wants the user to approve. We auto-opened
      // the URL; show it as a fallback (popup blockers) and keep waiting — the
      // flow advances on its own once approved.
      if (authUrl) {
        body.appendChild(badge('warning', '🔐', 'Approval required',
          'Your signer needs you to approve this connection. A tab should have opened — if not, use the button below. This screen continues automatically once you approve.'));
        const openBtn = h('a', {
          href: authUrl, target: '_blank', rel: 'noopener',
          class: 'mill-btn primary',
          style: { display: 'inline-flex', justifyContent: 'center', textDecoration: 'none', marginTop: '4px' },
        }, 'Open approval page');
        body.appendChild(openBtn);
      }

      if (nostrconnectURI) {
        const qrWrap = h('div', { style: { display: 'flex', justifyContent: 'center', padding: '4px 0' } });
        try { qrWrap.appendChild(qr(nostrconnectURI, { size: 220 })); } catch (e) { /* QR fail — keep URI fallback */ }
        body.appendChild(qrWrap);
        body.appendChild(keyDisplay('Nostr Connect URI', nostrconnectURI));
        body.appendChild(badge('info', '📲', null, 'Scan the QR with your bunker (Amber, nsec.app, etc.) — or copy the URI and paste it into the app.'));
      } else {
        body.appendChild(badge('warning', '📲', null, 'A connection request has been sent. Approve it on your signer device.'));
      }

      // Live diagnostic log — helps debug connection issues
      const logBox = h('div', {
        style: {
          marginTop: '8px',
          background: 'var(--mill-inset)',
          border: '1px solid var(--mill-border)',
          borderRadius: '8px',
          padding: '8px 10px',
          maxHeight: '160px',
          overflowY: 'auto',
          fontSize: '11px',
          fontFamily: 'var(--mill-font-mono)',
          color: 'var(--mill-text-secondary)',
          lineHeight: '1.55',
        },
      });
      const logTitle = h('div', { style: { fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--mill-muted)', marginBottom: '4px', fontFamily: 'var(--mill-font)' } }, 'Diagnostic log');
      const logList  = h('div', {});
      logBox.appendChild(logTitle);
      logBox.appendChild(logList);
      logsRender = () => {
        logList.innerHTML = '';
        logs.slice(-20).forEach(l => {
          logList.appendChild(h('div', { style: { color: l.level === 'err' ? 'var(--mill-danger)' : 'var(--mill-text-secondary)', whiteSpace: 'pre-wrap', wordBreak: 'break-all' } }, l.msg));
        });
        logBox.scrollTop = logBox.scrollHeight;
      };
      logsRender();
      body.appendChild(logBox);

      container.appendChild(wrap);
    } else {
      const { wrap, body, footer } = flowWrap({ step: 2, total: 3, title: 'Bunker Connected', subtitle: 'Your remote signer approved the connection.', onBack: () => { try{client?.disconnect();}catch{} client=null; step = 0; render(); } });
      body.appendChild(keyDisplay('User Public Key', userPk));
      body.appendChild(badge('success', '✅', 'Remote signing active', 'Signing requests will be forwarded to your bunker over the relay. Your bunker must be online to approve events.'));
      footer.appendChild(btn('Back', 'ghost', () => { try{client?.disconnect();}catch{} client=null; step = 0; render(); }));
      footer.appendChild(btn('Confirm Connection', 'primary', () => {
        // Persist the client identity + remote so MILL.restore() can re-present
        // the same already-authorized client to the bunker after a reload.
        storeBunkerState({
          clientSecretKey: bytesToHex(client.clientSecretKey),
          remotePubkey: client.remotePubkey,
          relays: client.relays,
          userPubkey: userPk,
        });
        const signer = createNIP46Signer(client, userPk);
        onDone({ method: 'nip46', pubkey: userPk, bunkerUrl: urlVal, signer });
      }));
      container.appendChild(wrap);
    }
  }
  render();
  return container;
}

// ── Flow: NIP-55 ──────────────────────────────────────────────────────────────
function renderNIP55Flow(host, onDone, onBack) {
  let step = 0, pubkey = '', errMsg = '';
  // Only use a callback round-trip if the host explicitly opted in. Defaulting
  // to the current page never worked: Amber concatenates the result onto the
  // URL verbatim, so a URL with no `#event=` suffix loses it entirely. With no
  // callbackUrl, Amber falls back to the clipboard — which needs no host code.
  const callbackUrl = host.getAttribute?.('amber-callback') || null;
  const appName     = host.getAttribute?.('app-name') || document.title || 'Nostr App';
  const container = h('div', {});

  async function startAmber(render) {
    if (callbackUrl && isLocalhost()) {
      errMsg = 'Amber callbacks cannot reach localhost. Use NIP-07 or NIP-46 for local dev.';
      render(); return;
    }
    step = 1; errMsg = ''; render();
    try {
      const { buildAmberURL, openAmberIntent, awaitAmberResult, awaitAmberClipboard, snapshotClipboard } = await import('./nip55.js');
      // Snapshot before firing so stale clipboard content can't be misread.
      const before = callbackUrl ? '' : await snapshotClipboard();
      const url = buildAmberURL({ type: 'get_public_key', callbackUrl, appName });
      openAmberIntent(url);
      const raw = callbackUrl
        ? await awaitAmberResult({ timeoutMs: 60_000 })
        : await awaitAmberClipboard({ timeoutMs: 60_000, before });
      // For get_public_key, Amber returns the pubkey hex in `event` param
      pubkey = raw.toLowerCase().replace(/^npub1.*$/i, '');  // accept either
      if (!/^[0-9a-f]{64}$/.test(pubkey)) {
        try { pubkey = npubToHex(raw); } catch { pubkey = raw; }
      }
      step = 2; render();
    } catch (e) {
      errMsg = e.message || 'Amber connection failed';
      step = 0; render();
    }
  }

  function render() {
    container.innerHTML = '';
    if (step === 0) {
      const { wrap, body, footer } = flowWrap({ step: 0, total: 3, title: 'Android Signer (NIP-55)', subtitle: 'Use Amber or another Android signer app. Communication via Android intents — no network between apps.', onBack });
      body.appendChild(badge('info', '📱', 'How NIP-55 works', 'NIP-55 uses Android\'s intent system to send signing requests to a local app. No relay or internet needed between this app and your signer.'));
      body.appendChild(badge('warning', '⚠️', 'Android only', 'NIP-55 requires Android with a compatible signer app. On iOS or desktop, use NIP-07 (browser extension) or NIP-46 (remote signer) instead.'));
      body.appendChild(badge('warning', '🔁', 'Approves one request at a time', 'Amber 6.2.2+ deliberately never remembers approvals for web pages, so every single signature needs a fresh app switch. For anything beyond signing in, use Remote Signer (NIP-46) — Amber works as a bunker over relays, and you approve just once.'));
      body.appendChild(h('div', { style: { padding: '12px 14px', background: 'var(--mill-inset)', border: '1px solid var(--mill-border)', borderRadius: '10px' } },
        h('div', { style: { fontSize: '14px', fontWeight: '600', marginBottom: '3px' } }, 'Amber'),
        h('div', { style: { fontSize: '12px', color: 'var(--mill-muted)', lineHeight: '1.5' } }, 'Open-source Android NIP-55 signer by greenart7c3. Install from F-Droid, GitHub Releases, or Google Play.')
      ));
      if (errMsg) body.appendChild(badge('danger', '✗', null, errMsg));
      footer.appendChild(btn('Cancel', 'ghost', onBack));
      footer.appendChild(btn('Open Amber →', 'teal', () => startAmber(render)));
      container.appendChild(wrap);
    } else if (step === 1) {
      const { wrap, body } = flowWrap({ step: 1, total: 3, title: 'Waiting for Amber…', subtitle: 'Approve the connection request in the Amber app on your Android device.' });
      const center = h('div', { style: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '18px', padding: '20px 0' } });
      center.appendChild(spinner('var(--mill-teal)', 48));
      center.appendChild(h('div', { style: { fontSize: '14px', color: 'var(--mill-text-secondary)', textAlign: 'center', lineHeight: '1.65' } }, 'Switch to Amber on your Android device and tap Approve on the connection request.'));
      body.appendChild(center);
      body.appendChild(badge('muted', '💡', null, "If Amber didn't open automatically, launch it manually and check for a pending auth request."));
      container.appendChild(wrap);
    } else {
      const { wrap, body, footer } = flowWrap({ step: 2, total: 3, title: 'Amber Connected', subtitle: 'Successfully linked to your Android signer.', onBack: () => { step = 0; render(); } });
      body.appendChild(keyDisplay('Public Key (from Amber)', pubkey));
      body.appendChild(badge('success', '✅', 'Android signing active', 'All signing requests will be sent to Amber as Android intents. Each event will show a prompt in Amber where you can approve or reject.'));
      footer.appendChild(btn('Back', 'ghost', () => { step = 0; render(); }));
      footer.appendChild(btn('Confirm Connection', 'primary', () => {
        const signer = createNIP55Signer({ pubkey, callbackUrl, appName });
        onDone({ method: 'nip55', pubkey, signer });
      }));
      container.appendChild(wrap);
    }
  }
  render();
  return container;
}

// ── Flow: Private Key ─────────────────────────────────────────────────────────
function renderPrivateKeyFlow(host, onDone, onBack) {
  let step = 0, nsecVal = '', pw = '', pw2 = '', errMsg = '';
  const perms = Object.fromEntries(SIGN_CATS.map(c => [c.id, c.def]));
  const container = h('div', {});

  function render() {
    container.innerHTML = '';
    if (step === 0) {
      const { wrap, body, footer } = flowWrap({ step: 0, total: 4, title: 'Private Key Login', subtitle: 'Paste your nsec. It will be AES-256 encrypted with your password and stored only for this browser session.', onBack });
      body.appendChild(badge('danger', '⚠️', 'Keep your nsec secret', 'Your private key is the master credential for your Nostr identity. Anyone who obtains it can post as you, access your DMs, and permanently take over your account.'));
      const { wrap: fw } = field('Private Key (nsec or hex)', 'nsec1… or 64-char hex', nsecVal, v => { nsecVal = v; errMsg = ''; }, { mono: true, error: errMsg });
      body.appendChild(fw);
      if (errMsg) body.appendChild(h('div', { class: 'mill-error' }, errMsg));
      body.appendChild(h('div', { class: 'mill-hint' }, 'This key never leaves your browser. It is encrypted locally before being stored in sessionStorage.'));
      footer.appendChild(btn('Cancel', 'ghost', onBack));
      footer.appendChild(btn('Continue', 'primary', () => {
        if (!isValidNsec(nsecVal.trim())) { errMsg = 'Enter a valid nsec1… or 64-char hex private key'; render(); return; }
        step = 1; render();
      }));
      container.appendChild(wrap);
    } else if (step === 1) {
      const { wrap, body, footer } = flowWrap({ step: 1, total: 4, title: 'Set Session Password', subtitle: 'This password encrypts your key while it sits in this browser. You enter it once per session to unlock signing — not for each event.', onBack: () => { step = 0; render(); } });
      body.appendChild(badge('info', '🔒', 'How encryption works', 'Your nsec is encrypted with AES-256-GCM using a PBKDF2-derived key (100k iterations, SHA-256). Stored in sessionStorage — wiped on tab close.'));
      const isOk = () => pw.length >= 4 && pw === pw2;
      const setBtn = btn('Set Password', 'primary', () => { if (isOk()) { step = 2; render(); } }, !isOk());
      const err1 = h('div', { class: 'mill-error' });
      const err2 = h('div', { class: 'mill-error' });
      const updateUi = () => {
        setBtn.disabled = !isOk();
        err1.textContent = pw && pw.length < 4 ? 'Minimum 4 characters' : '';
        err2.textContent = pw2 && pw !== pw2 ? 'Passwords do not match' : '';
      };
      const { wrap: pw1 } = field('Session Password', 'Minimum 4 characters', pw, v => { pw = v; updateUi(); }, { type: 'password' });
      const { wrap: pw2w } = field('Confirm Password', 'Repeat password', pw2, v => { pw2 = v; updateUi(); }, { type: 'password' });
      pw1.appendChild(err1); pw2w.appendChild(err2);
      body.appendChild(pw1); body.appendChild(pw2w);
      footer.appendChild(btn('Back', 'ghost', () => { step = 0; render(); }));
      footer.appendChild(setBtn);
      container.appendChild(wrap);
    } else if (step === 2) {
      const { wrap, body, footer } = flowWrap({ step: 2, total: 4, title: 'Signing Permissions', subtitle: 'Choose what gets signed automatically and what you want to see first. You can change any of this later. Only applies to private-key signing — NIP-07/46/55 approve things in their own apps.', onBack: () => { step = 1; render(); } });
      body.appendChild(signingBehaviorEditor(perms));
      footer.appendChild(btn('Back', 'ghost', () => { step = 1; render(); }));
      footer.appendChild(btn('Continue', 'primary', () => { step = 3; render(); }));
      container.appendChild(wrap);
    } else {
      const masked = nsecVal.slice(0, 12) + '•'.repeat(14) + nsecVal.slice(-6);
      const { wrap, body, footer } = flowWrap({ step: 3, total: 4, title: 'Review & Connect', subtitle: 'Confirm before connecting.', onBack: () => { step = 2; render(); } });
      body.appendChild(keyDisplay('Private Key (masked)', masked));
      const table = h('div', { style: { background: 'var(--mill-inset)', border: '1px solid var(--mill-border)', borderRadius: '10px', overflow: 'hidden' } });
      table.appendChild(h('div', { style: { padding: '8px 14px', borderBottom: '1px solid var(--mill-border)', fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--mill-muted)' } }, 'Signing Permissions'));
      SIGN_CATS.forEach((cat, i) => {
        const p = PERM_OPTS.find(o => o.id === perms[cat.id]);
        table.appendChild(h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 14px', borderBottom: i < SIGN_CATS.length - 1 ? '1px solid var(--mill-border)' : 'none' } },
          h('span', { style: { fontSize: '13px', color: 'var(--mill-text-secondary)' } }, `${cat.icon} ${cat.label}`),
          h('span', { style: { fontSize: '12px', color: p?.color, fontWeight: '600' } }, p?.label)
        ));
      });
      body.appendChild(table);
      footer.appendChild(btn('Back', 'ghost', () => { step = 2; render(); }));
      footer.appendChild(btn('Connect with Private Key', 'primary', async () => {
        const hexKey   = nsecToHex(nsecVal.trim());
        const pubHex   = getPublicKey(hexToBytes(hexKey));
        const encrypted = await encryptNsec(hexKey, pw);
        storeEncryptedNsec(encrypted);
        storeSignPerms(perms);   // so MILL.restore() can rebuild with the same policy after reload
        const signer = createPrivateKeySigner({
          pubkey: pubHex, perms,
          promptPassword: sessionPrompt(host, pw),
          requestConsent: req => host.requestConsent({ ...req, npub: hexToNpub(pubHex) }),
        });
        onDone({ method: 'privatekey', pubkey: pubHex, perms, signer });
      }));
      container.appendChild(wrap);
    }
  }
  render();
  return container;
}

// Cloud-backup secret: 4–8 characters, letters and/or digits. A superset of
// wisp's numeric-only PIN — a user can still type 4 digits, but may also use
// letters for a bit more entropy. Kept short and low-friction on purpose; real
// at-rest security is the cloud account, and the exported ncryptsec uses a full
// passphrase. Deliberately not longer: this is a PIN, not a passphrase.
const CLOUD_PIN_RE = /^[a-zA-Z0-9]{4,8}$/;
const isValidPin = s => CLOUD_PIN_RE.test(s || '');
const sanitizePin = s => (s || '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 8);

// ── Flow: "I'm new here" chooser ──────────────────────────────────────────────
// Only reached when Google login is configured. Two ways to start: the normie
// path (Google, key hidden) and the self-custody path (generate, save your own
// key). Framed so the easy choice is obvious but the sovereign one is right
// there — matching the user's goal of easy-onboarding-now, take-control-later.
function renderNewHereChooser(host, onSelect, onBack) {
  const { wrap, body, footer } = flowWrap({
    step: 0, total: 1,
    title: 'Get Started',
    subtitle: 'Create your Nostr account. You can move to full self-custody whenever you want.',
    onBack,
  });

  const option = (icon, title, sub, primary, onClick) => {
    const card = h('button', {
      class: 'mill-method-card',
      onClick,
      style: { padding: '13px 15px', marginBottom: '10px',
        ...(primary ? { background: 'var(--mill-accent-dim)', borderColor: 'var(--mill-accent)' } : {}) },
    });
    card.appendChild(h('div', { class: 'mill-method-icon', style: { width: '34px', height: '34px', fontSize: '18px' } }, iconNode(icon, 20)));
    const txt = h('div', { style: { flex: '1', minWidth: '0' } });
    txt.appendChild(h('div', { style: { fontSize: '14px', fontWeight: '600', color: primary ? 'var(--mill-accent)' : 'var(--mill-text)' } }, title));
    txt.appendChild(h('div', { style: { fontSize: '12px', color: 'var(--mill-text-secondary)', marginTop: '2px', lineHeight: '1.45' } }, sub));
    card.appendChild(txt);
    card.appendChild(h('span', { class: 'mill-arrow', style: primary ? { color: 'var(--mill-accent)' } : {} }, '→'));
    return card;
  };

  // Route to whichever Google path the host configured (pomegranate wins).
  const googleMethod = host?._state?.pomegranate ? 'pomegranate' : 'google';
  body.appendChild(option(googleLogo, 'Continue with Google',
    'Easiest. Your key is created and safely stored for you — nothing to write down.',
    true, () => onSelect(googleMethod)));
  body.appendChild(option('🔑', 'Generate my own keys',
    'Advanced. You get your private key immediately and are responsible for backing it up.',
    false, () => onSelect('newkey')));

  footer.appendChild(btn('Back', 'ghost', onBack));
  return wrap;
}

// ── Flow: Continue with Google (cloud-backed key) ─────────────────────────────
// The normie path. Mill generates and holds the key; the user sees a PIN, never
// a key. Their nsec is encrypted and stored in their own Google Drive's hidden
// app-data folder, so it survives across devices and browsers without the user
// managing anything. "Take control of my keys" (the export screen) is where the
// key becomes visible — hidden until asked for.
function renderGoogleFlow(host, onDone, onBack) {
  const shimUrl = host.getAttribute?.('oauth-shim') || '';
  let step = shimUrl ? 'idle' : 'unconfigured';
  let errMsg = '', pin = '', pin2 = '';
  let mode = 'generate';         // 'generate' | 'import' — bring-your-own-key
  let nsecVal = '';              // pasted key when mode === 'import'
  let token = null;               // { accessToken, sub, ... }
  let backups = [];              // Drive file list
  let confirmRemove = null;      // file id pending a remove confirmation (manage screen)
  let unlockMatches = [];        // accounts that decrypted with the entered PIN (chooser)
  const container = h('div', {});

  // Drive ops need a token getter; a forced refresh re-opens the popup, since a
  // GIS access token can't be refreshed silently from here.
  const getToken = async (force) => {
    if (token && !force) return token.accessToken;
    token = await requestCloudToken(shimUrl);
    return token.accessToken;
  };

  async function connect(render) {
    step = 'connecting'; errMsg = ''; render();
    try {
      await getToken(false);
      backups = await withAuth(getToken, t => listBackups(t));
      step = backups.length ? 'unlock' : 'setup';
      render();
    } catch (e) {
      errMsg = e.message || 'Could not connect to Google.';
      step = 'idle'; render();
    }
  }

  async function refreshBackups() {
    backups = await withAuth(getToken, t => listBackups(t));
  }

  // Delete one stored key's Drive blob. Does NOT touch any cross-app recovery
  // event on relays — those are addressed by the phrase and can't be reached
  // from here, and are irrevocable regardless (see the NIP).
  async function removeBackup(fileId, render) {
    step = 'working'; errMsg = ''; confirmRemove = null; render();
    try {
      await withAuth(getToken, t => deleteBackup(t, fileId));
      await refreshBackups();
      step = backups.length ? 'manage' : 'setup';
      render();
    } catch (e) {
      errMsg = e.message || 'Could not remove that backup.';
      step = 'manage'; render();
    }
  }

  // Finish: encrypt the recovered/created key under the PIN for this session's
  // sessionStorage (same mechanism the private-key flow uses), build the signer.
  async function finish(privHex, npub, pubHex) {
    const perms = defaultPerms();
    const encrypted = await encryptNsec(privHex, pin);
    storeEncryptedNsec(encrypted);
    storeSignPerms(perms);
    const signer = createPrivateKeySigner({
      pubkey: pubHex, perms,
      promptPassword: sessionPrompt(host, pin),
      requestConsent: req => host.requestConsent({ ...req, npub }),
    });
    onDone({ method: 'google', pubkey: pubHex, perms, signer });
  }

  async function unlock(render) {
    step = 'working'; errMsg = ''; render();
    try {
      // Collect every backup the entered PIN decrypts. Usually one; if the user
      // gave several accounts the same PIN, more than one decrypts and we let
      // them choose rather than silently picking the newest.
      const matches = [];
      for (const f of backups) {
        try {
          const blob = await withAuth(getToken, t => downloadBackup(t, f.id));
          const privHex = await decryptCloudBlob(blob, pin);
          const pubHex = getPublicKey(hexToBytes(privHex));
          matches.push({ privHex, pubHex, npub: hexToNpub(pubHex) });
        } catch { /* wrong PIN or unrelated file — skip */ }
      }
      if (!matches.length) {
        errMsg = 'That PIN did not unlock any account. Try again.';
        step = 'unlock'; render(); return;
      }
      if (matches.length === 1) {
        const m = matches[0];
        await finish(m.privHex, m.npub, m.pubHex);
        return;
      }
      unlockMatches = matches; step = 'choose-account'; render();
    } catch (e) {
      errMsg = e.message || 'Something went wrong.';
      step = 'unlock'; render();
    }
  }

  // Save a NEW cloud account — either a freshly generated key or one the user
  // brought themselves (mode === 'import'). Upload BEFORE trusting it locally
  // (wisp's ordering) so a failed upload never leaves a key only on this device.
  async function saveNewKey(render) {
    step = 'working'; errMsg = ''; render();
    try {
      let privHex, npub, pubHex;
      if (mode === 'import') {
        privHex = nsecToHex(nsecVal.trim());
        pubHex  = getPublicKey(hexToBytes(privHex));
        npub    = hexToNpub(pubHex);
      } else {
        const keys = await generateKeypair();
        privHex = keys.privHex; npub = keys.npub; pubHex = keys.pubHex;
      }
      const blob = await encryptCloudBlob(privHex, pin);
      await withAuth(getToken, t => uploadBackup(t, blob));
      await finish(privHex, npub, pubHex);
    } catch (e) {
      errMsg = e.message || 'Could not save your account to Google.';
      step = 'setup'; render();
    }
  }

  function pinField(label, val, onInput) {
    // Allows letters as well as digits, so no forced numeric inputmode — a
    // number-only pad would hide the letters the 4–8 alphanumeric PIN permits.
    // Reflect the sanitised value back into the field so what's shown always
    // equals what's stored (otherwise a typed symbol appears but is dropped).
    const f = field(label, '4–8 letters or numbers', val, (v) => {
      const clean = sanitizePin(v);
      if (f.input && f.input.value !== clean) f.input.value = clean;
      onInput(clean);
    }, { type: 'password', maxlength: '8' });
    return f.wrap;
  }

  function render() {
    container.innerHTML = '';

    if (step === 'unconfigured') {
      const { wrap, body, footer } = flowWrap({ step: 0, total: 1, title: 'Google Sign-In Unavailable', subtitle: 'This app has not set up Google sign-in.', onBack });
      body.appendChild(badge('warning', '🔧', 'Not configured', 'The developer of this app needs to set an oauth-shim URL to enable “Continue with Google”. Use another sign-in method for now.'));
      footer.appendChild(btn('Back', 'primary', onBack));
      container.appendChild(wrap);

    } else if (step === 'idle') {
      const { wrap, body, footer } = flowWrap({ step: 0, total: 3, title: 'Continue with Google', subtitle: 'Create or restore your account. Your key is encrypted and stored in your own Google Drive — the app never sees it.', onBack });
      body.appendChild(badge('info', '🔒', 'How this works', 'A new Nostr key is created for you — or your existing one is restored, or you can import your own. It is encrypted with a PIN and saved to a private folder in your Google Drive that only this sign-in can read.'));
      if (errMsg) body.appendChild(h('div', { class: 'mill-error' }, errMsg));
      footer.appendChild(btn('Back', 'ghost', onBack));
      footer.appendChild(btn([googleLogoOnWhite(18), 'Continue with Google'], 'primary', () => connect(render)));
      container.appendChild(wrap);

    } else if (step === 'connecting') {
      const { wrap, body } = flowWrap({ step: 1, total: 3, title: 'Connecting…', subtitle: 'Approve access in the Google window.' });
      const center = h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '14px', padding: '30px 0' } });
      center.appendChild(spinner()); center.appendChild(h('span', { style: { color: 'var(--mill-text-secondary)' } }, 'Waiting for Google…'));
      body.appendChild(center);
      container.appendChild(wrap);

    } else if (step === 'working') {
      const { wrap, body } = flowWrap({ step: 2, total: 3, title: 'Almost there…', subtitle: 'Securing your account.' });
      const center = h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '14px', padding: '30px 0' } });
      center.appendChild(spinner()); center.appendChild(h('span', { style: { color: 'var(--mill-text-secondary)' } }, 'One moment…'));
      body.appendChild(center);
      container.appendChild(wrap);

    } else if (step === 'unlock') {
      const okBtn = btn('Unlock', 'primary', () => { if (isValidPin(pin)) unlock(render); }, !isValidPin(pin));
      const { wrap, body, footer } = flowWrap({ step: 2, total: 3, title: 'Enter your PIN', subtitle: 'Welcome back. Enter the PIN you set to unlock your account.', onBack: () => { step = 'idle'; pin = ''; render(); } });
      const f = pinField('PIN', pin, v => { pin = sanitizePin(v); okBtn.disabled = !isValidPin(pin); });
      body.appendChild(f);
      if (errMsg) body.appendChild(h('div', { class: 'mill-error' }, errMsg));
      const inp = f.querySelector('input'); if (inp) inp.addEventListener('keydown', e => { if (e.key === 'Enter' && isValidPin(pin)) unlock(render); });
      // Escape hatches so a stored backup is never a dead end: add/import a
      // different key, or manage (remove) what's stored.
      body.appendChild(h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '10px' } },
        h('button', { class: 'mill-consent-manage', type: 'button', onClick: () => { mode = 'generate'; pin = ''; pin2 = ''; nsecVal = ''; errMsg = ''; step = 'setup'; render(); } }, 'Add or import a different account'),
        h('button', { class: 'mill-consent-manage', type: 'button', onClick: () => { confirmRemove = null; errMsg = ''; step = 'manage'; render(); } }, `Manage stored keys${backups.length > 1 ? ` (${backups.length})` : ''}`),
      ));
      footer.appendChild(btn('Back', 'ghost', () => { step = 'idle'; pin = ''; render(); }));
      footer.appendChild(okBtn);
      container.appendChild(wrap);

    } else if (step === 'manage') {
      const { wrap, body, footer } = flowWrap({ step: 2, total: 3, title: 'Manage Cloud Keys', subtitle: 'Keys stored in your Google Drive for this account. Removing one deletes only the cloud copy and cannot be undone.', onBack: () => { confirmRemove = null; step = backups.length ? 'unlock' : 'idle'; render(); } });
      if (!backups.length) {
        body.appendChild(badge('muted', '🗂', 'Nothing stored', 'There are no cloud keys for this account. Create or import one to get started.'));
      } else {
        backups.forEach((fb, i) => {
          const row = h('div', { class: 'mill-grant-row' });
          let when = '';
          try { if (fb.modifiedTime) when = new Date(fb.modifiedTime).toLocaleDateString(); } catch {}
          row.appendChild(h('div', { class: 'mill-grant-left' },
            h('div', { class: 'mill-grant-kind' }, `🔑 Stored key ${i + 1}`),
            h('div', { class: 'mill-grant-meta' }, `${String(fb.id).slice(0, 8)}…${when ? ` · ${when}` : ''}`),
          ));
          const pending = confirmRemove === fb.id;
          const rm = h('button', { class: 'mill-grant-btn', type: 'button',
            onClick: () => { if (pending) removeBackup(fb.id, render); else { confirmRemove = fb.id; render(); } } },
            pending ? 'Confirm remove' : 'Remove');
          if (pending) { rm.style.borderColor = 'var(--mill-danger)'; rm.style.color = 'var(--mill-danger)'; rm.style.background = 'color-mix(in srgb, var(--mill-danger) 12%, transparent)'; }
          row.appendChild(h('div', { class: 'mill-grant-actions' }, rm));
          body.appendChild(row);
        });
        body.appendChild(h('div', { class: 'mill-hint' }, 'These are opaque on purpose — the key inside is only revealed by unlocking with its PIN. Keep an independent copy of any key you still want before removing it.'));
      }
      if (errMsg) body.appendChild(h('div', { class: 'mill-error' }, errMsg));
      footer.appendChild(btn('Back', 'ghost', () => { confirmRemove = null; step = backups.length ? 'unlock' : 'idle'; render(); }));
      footer.appendChild(btn('Add / import a key', 'primary', () => { mode = 'generate'; pin = ''; pin2 = ''; nsecVal = ''; errMsg = ''; step = 'setup'; render(); }));
      container.appendChild(wrap);

    } else if (step === 'choose-account') {
      const { wrap, body, footer } = flowWrap({ step: 2, total: 3, title: 'Choose an Account', subtitle: 'More than one account uses that PIN. Pick which one to sign in as.', onBack: () => { step = 'unlock'; pin = ''; unlockMatches = []; render(); } });
      unlockMatches.forEach((m, i) => {
        const card = h('button', { class: 'mill-method-card', onClick: () => finish(m.privHex, m.npub, m.pubHex) });
        card.appendChild(h('div', { class: 'mill-method-icon', style: { width: '34px', height: '34px', fontSize: '16px' } }, '🔑'));
        card.appendChild(h('div', { style: { flex: '1', minWidth: '0' } },
          h('div', { style: { fontSize: '13px', fontWeight: '600' } }, `Account ${i + 1}`),
          h('code', { style: { fontSize: '10.5px', fontFamily: 'var(--mill-font-mono)', color: 'var(--mill-accent)', wordBreak: 'break-all', display: 'block', marginTop: '2px', lineHeight: '1.4' } }, m.npub),
        ));
        card.appendChild(h('span', { class: 'mill-arrow' }, '→'));
        body.appendChild(card);
      });
      footer.appendChild(btn('Back', 'ghost', () => { step = 'unlock'; pin = ''; unlockMatches = []; render(); }));
      container.appendChild(wrap);

    } else if (step === 'setup') {
      const importing = mode === 'import';
      const keyOk = () => !importing || isValidNsec(nsecVal.trim());
      const ok    = () => isValidPin(pin) && pin === pin2 && keyOk();
      const okBtn = btn(importing ? 'Import & Save' : 'Create Account', 'primary', () => { if (ok()) saveNewKey(render); }, !ok());
      const { wrap, body, footer } = flowWrap({ step: 2, total: 3, title: importing ? 'Import Your Key' : 'Choose a PIN', subtitle: importing ? 'Bring an existing Nostr key and protect it with a PIN.' : 'Pick a PIN (4–8 letters or numbers). You will use it to unlock your account on other devices.', onBack: () => { step = backups.length ? 'unlock' : 'idle'; pin = ''; pin2 = ''; nsecVal = ''; render(); } });

      // Toggle: generate a fresh key, or bring your own.
      const seg = h('div', { style: { display: 'flex', gap: '4px', background: 'var(--mill-inset)', border: '1px solid var(--mill-border)', borderRadius: '10px', padding: '4px', marginBottom: '4px' } });
      const segBtn = (id, label) => {
        const active = mode === id;
        const b = h('button', { class: 'mill-btn', style: { flex: '1', padding: '8px', fontSize: '12.5px', background: active ? 'var(--mill-accent-dim)' : 'transparent', color: active ? 'var(--mill-accent)' : 'var(--mill-muted)', border: active ? '1px solid var(--mill-accent)' : '1px solid transparent' }, onClick: () => { mode = id; errMsg = ''; render(); } }, label);
        return b;
      };
      seg.appendChild(segBtn('generate', 'Create new key'));
      seg.appendChild(segBtn('import', 'Import my key'));
      body.appendChild(seg);

      const err = h('div', { class: 'mill-error' });
      const sync = () => { okBtn.disabled = !ok(); err.textContent = (pin2 && pin !== pin2) ? 'PINs do not match' : ''; };

      if (importing) {
        const { wrap: fw } = field('Private Key (nsec or hex)', 'nsec1… or 64-char hex', nsecVal, v => { nsecVal = v; errMsg = ''; sync(); }, { mono: true });
        body.appendChild(fw);
      }

      body.appendChild(pinField('PIN', pin, v => { pin = sanitizePin(v); sync(); }));
      body.appendChild(pinField('Confirm PIN', pin2, v => { pin2 = sanitizePin(v); sync(); }));
      body.appendChild(err);
      // Honest about what the PIN does and does not do — no security theatre.
      body.appendChild(badge('muted', 'ℹ️', 'About your PIN', 'The PIN stops someone casually opening your account. Your real protection is your Google account and its security — keep that locked down. If you forget the PIN, you can still recover using an exported key, if you saved one.'));
      if (importing) body.appendChild(badge('info', '🔑', 'Bringing your own key', 'Your key is encrypted with your PIN and uploaded to your Google Drive. Keep your original nsec backed up too — the PIN only protects this cloud copy.'));
      if (errMsg) body.appendChild(h('div', { class: 'mill-error' }, errMsg));
      footer.appendChild(btn('Back', 'ghost', () => { step = backups.length ? 'unlock' : 'idle'; pin = ''; pin2 = ''; nsecVal = ''; render(); }));
      footer.appendChild(okBtn);
      container.appendChild(wrap);
    }
  }
  render();
  return container;
}

// ── Flow: Continue with Google (Pomegranate / FROST) ──────────────────────────
// The cross-client Google path (fiatjaf's pomegranate). The key is FROST-sharded
// across operators and never stored whole; Google authenticates the user to
// those operators; signing runs over NIP-46 through a `central` coordinator.
// Config: MILL.open({ pomegranate: true }) uses the njump ecosystem defaults
// below; MILL.open({ pomegranate: { central, operators, threshold, relays,
// pinCentral } }) self-hosts. Lives on host._state.pomegranate. EXPERIMENTAL.
function renderPomegranateFlow(host, onDone, onBack) {
  const raw = host._state?.pomegranate;
  const cfg = (raw && typeof raw === 'object') ? raw : {};
  const uniq = a => a.filter((v, i) => a.indexOf(v) === i);
  const defaultCentral = pomMassageURL(cfg.central || POM_DEFAULT_CENTRAL);
  const defaultOperators = (cfg.operators?.length ? cfg.operators : POM_DEFAULT_OPERATORS).map(pomMassageURL);
  const centralChoices = uniq([defaultCentral, ...((cfg.centralChoices || []).map(pomMassageURL))]);
  const operatorChoices = uniq([...defaultOperators, ...((cfg.operatorChoices || []).map(pomMassageURL))]);
  const explicitThreshold = cfg.threshold;
  const relays = cfg.relays;
  const allowCustomCentral = cfg.allowCustomCentral !== false;
  const allowCustomOperators = cfg.allowCustomOperators !== false;
  const minOperators = cfg.minOperators || 3;
  const pinCentral = cfg.pinCentral !== false;   // DEFAULT true — no discovery redirect unless the host opts out

  // Threshold from operator count: honour an explicit host value while it leaves
  // fault tolerance (≤ n−1), else ~7/12 of n (min 2, capped at n): 4 → 3-of-4.
  const thresholdFor = n => (explicitThreshold && explicitThreshold <= n - 1)
    ? explicitThreshold : Math.min(n, Math.max(2, Math.ceil((n * 7) / 12)));
  const defaultThreshold = thresholdFor(defaultOperators.length);   // used by the recover flow

  // Selection state — drives auth / getAccount / signup / replace. Everything
  // "advanced" (central, operator checklist, threshold) is defaulted and hidden
  // behind the Advanced disclosure; most users never touch it.
  let selectedCentral = defaultCentral;
  let selectedOperators = operatorChoices.map(url => ({ url, checked: defaultOperators.includes(url) }));
  try {
    const saved = JSON.parse(localStorage.getItem('mill:pomegranate:servers') || 'null');
    if (saved && saved.central) { selectedCentral = pomMassageURL(saved.central); if (!centralChoices.includes(selectedCentral)) centralChoices.push(selectedCentral); }
    if (saved && Array.isArray(saved.operators) && saved.operators.length) {
      const savedOps = saved.operators.map(pomMassageURL);
      savedOps.forEach(u => { if (!selectedOperators.find(o => o.url === u)) selectedOperators.push({ url: u, checked: false }); });
      selectedOperators.forEach(o => { o.checked = savedOps.includes(o.url); });
    }
  } catch {}
  const chosenOperators = () => selectedOperators.filter(o => o.checked).map(o => o.url);
  const effThreshold = () => thresholdFor(chosenOperators().length);
  const isDefaultSelection = () => selectedCentral === defaultCentral &&
    chosenOperators().length === defaultOperators.length && chosenOperators().every(u => defaultOperators.includes(u));
  const persistServers = () => { try { localStorage.setItem('mill:pomegranate:servers', JSON.stringify({ central: selectedCentral, operators: chosenOperators() })); } catch {} };
  const resetServers = () => {
    selectedCentral = defaultCentral;
    selectedOperators = operatorChoices.map(url => ({ url, checked: defaultOperators.includes(url) }));
    try { localStorage.removeItem('mill:pomegranate:servers'); } catch {}
  };

  let step = 'idle';
  let advancedOpen = false;             // Advanced disclosure on the idle screen
  let customCentralMode = false;        // "Custom…" chosen in the central select
  const probeStatus = {};               // operatorURL -> 'up' | 'down' (idle-screen dots)
  let skipped = [];                     // [{ url, reason }] left out by a resilient signup
  let signupMeta = null;                // { central, operators, threshold, skipped } for onConnected
  let errMsg = '', statusMsg = '', createdNsec = '', nsecSaved = false;
  let recovered = null;                 // { privHex, nsec, npub } from recovery
  let auth = null;                      // { centralURL, token, email } after Google login, before account creation
  let mode = 'generate';               // 'generate' | 'import' — bring-your-own-key at signup
  let nsecVal = '';                    // pasted key when mode === 'import'
  let intent = 'signin';               // 'signin' | 'replace' — replace swaps the key behind this Google account
  let account = null;                   // { pubkey, operators, threshold } of the account being replaced
  let returnTo = '';                    // where the recover step's Done returns (e.g. 'replace-confirm')
  let backedUp = false;                 // set once the user backs up the old key during a replace
  let ackReplace = false;               // "I understand my key will be erased" checkbox
  let foundCtx = null;                   // { token, email, foundCentral } when discovery points elsewhere
  const eraseRequested = {};            // operatorURL -> true once its erase popup has opened+closed
  const shards = {};                    // operatorURL -> shard hex (recovery)
  const container = h('div', {});
  const appName = () => host.getAttribute?.('app-name') || document.title || 'Nostr App';

  // Operators that hold the CURRENT account's shards (may differ from configured).
  const eraseTargets = () => (account?.operators || []).map(o => pomMassageURL(typeof o === 'string' ? o : o.url));

  // Shared generate/import chooser (used by new-account and replace-confirm):
  // appends the toggle + (when importing) the nsec field to `body`, wires
  // mode/nsecVal, and calls syncBtn() on input so the caller gates its button.
  function keyChooser(body, syncBtn) {
    const seg = h('div', { style: { display: 'flex', gap: '4px', background: 'var(--mill-inset)', border: '1px solid var(--mill-border)', borderRadius: '10px', padding: '4px' } });
    const segBtn = (id, label) => h('button', { class: 'mill-btn', style: { flex: '1', padding: '8px', fontSize: '12.5px', background: mode === id ? 'var(--mill-accent-dim)' : 'transparent', color: mode === id ? 'var(--mill-accent)' : 'var(--mill-muted)', border: mode === id ? '1px solid var(--mill-accent)' : '1px solid transparent' }, onClick: () => { mode = id; errMsg = ''; render(); } }, label);
    seg.appendChild(segBtn('generate', 'Create new key'));
    seg.appendChild(segBtn('import', 'Import my key'));
    body.appendChild(seg);
    if (mode === 'import') {
      const { wrap: fw } = field('Private Key (nsec or hex)', 'nsec1… or 64-char hex', nsecVal, v => { nsecVal = v; errMsg = ''; syncBtn(); }, { mono: true });
      body.appendChild(fw);
    }
  }

  function checkboxRow(label, checked, onChange) {
    const input = h('input', { type: 'checkbox', style: { marginTop: '3px', flex: '0 0 auto' } });
    input.checked = checked;
    input.addEventListener('change', e => onChange(e.target.checked));
    return h('label', { style: { display: 'flex', gap: '8px', alignItems: 'flex-start', cursor: 'pointer', fontSize: '13px', color: 'var(--mill-text-secondary)', lineHeight: '1.4' } }, input, h('span', {}, label));
  }

  // Background liveness probe for the Advanced operator dots (open + Add only).
  async function probeAdvanced(render, subset) {
    const targets = subset || selectedOperators.map(o => o.url);
    await Promise.all(targets.map(async u => { probeStatus[u] = await pomProbeServer(u); }));
    render();
  }

  // Take a pomegranate bunker URI and connect via mill's existing NIP-46 path.
  async function connectBunker(bunkerURI, render) {
    step = 'connecting-signer'; statusMsg = 'Connecting to your signer…'; errMsg = ''; render();
    try {
      const client = new NIP46Client({ relays: DEFAULT_RELAYS, metadata: { name: appName(), url: location.origin }, debug: false });
      const userPk = await client.connectViaBunker(bunkerURI, { timeoutMs: 90_000 });
      storeBunkerState({
        clientSecretKey: bytesToHex(client.clientSecretKey),
        remotePubkey: client.remotePubkey, relays: client.relays, userPubkey: userPk,
      });
      const signer = createNIP46Signer(client, userPk);
      persistServers();   // remember the selected central/operators after a real success
      onDone({ method: 'pomegranate', pubkey: userPk, bunkerUrl: bunkerURI, signer, nsec: createdNsec || undefined, pomegranate: signupMeta || { central: selectedCentral } });
    } catch (e) {
      errMsg = e.message || 'Could not connect to your signer.';
      step = 'idle'; render();
    }
  }

  // Route to the right step once we hold a valid token for `centralURL`. We read
  // the account with getAccount (not loginExisting — that would create a default
  // profile before the user commits).
  async function proceedAt(centralURL, token, render) {
    const email = pomTokenEmail(token);
    auth = { centralURL, token, email };
    const acct = await pomGetAccount(centralURL, token);
    if (intent === 'replace') {
      backedUp = false; ackReplace = false; nsecVal = '';
      Object.keys(eraseRequested).forEach(k => delete eraseRequested[k]);
      if (!acct) { account = null; mode = 'import'; step = 'new-account'; render(); return; }
      account = acct; mode = 'import';
      step = 'replace-confirm'; render(); return;
    }
    // Sign-in: new account → set one up; existing → confirm on the signed-in
    // screen (the point where we finally know the email/account) before connecting.
    if (!acct) { mode = 'generate'; nsecVal = ''; step = 'new-account'; render(); return; }
    account = acct; step = 'signed-in'; render();
  }

  // Continue from the signed-in screen: resolve the bunker (creating the default
  // profile now) and connect.
  async function continueSignedIn(render) {
    step = 'connecting-signer'; statusMsg = 'Connecting to your signer…'; errMsg = ''; render();
    try {
      const existing = await pomLogin(auth.centralURL, auth.token);
      if (!existing) { errMsg = 'Your account could not be resolved. Try again.'; step = 'signed-in'; render(); return; }
      await connectBunker(existing.bunkerURI, render);
    } catch (e) { errMsg = e.message || 'Could not connect to your signer.'; step = 'signed-in'; render(); }
  }

  // From the signed-in screen: switch to replacing the key (email/account known).
  function startReplaceFromSignedIn(render) {
    intent = 'replace'; mode = 'import'; nsecVal = '';
    backedUp = false; ackReplace = false; errMsg = '';
    Object.keys(eraseRequested).forEach(k => delete eraseRequested[k]);
    step = 'replace-confirm'; render();
  }

  async function start(render) {
    step = 'connecting'; errMsg = ''; render();
    try {
      const token = await pomAuthenticate(selectedCentral);   // popup opens inside the click
      const email = pomTokenEmail(token);
      // Cross-client discovery: is this account set up at a DIFFERENT central?
      // Skipped when pinned (the default). If so, do NOT auto-open a second popup —
      // the click's transient activation is already spent and Chrome blocks it;
      // show an interstitial whose button re-auths inside a fresh user gesture.
      const found = pinCentral ? null : await pomDiscover(email, relays);
      if (found && found.centralURL !== selectedCentral) {
        foundCtx = { token, email, foundCentral: found.centralURL };
        step = 'found-elsewhere'; render(); return;
      }
      await proceedAt(selectedCentral, token, render);
    } catch (e) {
      errMsg = e.message || 'Google sign-in failed.';
      step = 'idle'; render();
    }
  }

  // Interstitial: "Continue there" (sign-in) / "Replace the key there" (replace).
  // Re-auth at the discovered central inside this fresh click, then route.
  async function continueThere(render) {
    step = 'connecting'; errMsg = ''; render();
    try {
      const token = await pomAuthenticate(foundCtx.foundCentral);
      await proceedAt(foundCtx.foundCentral, token, render);
    } catch (e) {
      errMsg = e.message || 'Google sign-in failed.';
      step = 'found-elsewhere'; render();
    }
  }

  // Interstitial (replace only): ignore the discovered central and import at the
  // CONFIGURED one. signup() then publishes a fresh announcement that outranks the
  // old pointer, so future discovery resolves here. Reuses start()'s token.
  async function importHere(render) {
    step = 'connecting'; errMsg = ''; render();
    try {
      await proceedAt(selectedCentral, foundCtx.token, render);
    } catch (e) {
      errMsg = e.message || 'Sign-in failed.';
      step = 'found-elsewhere'; render();
    }
  }

  async function eraseAt(operatorURL, render) {
    errMsg = ''; render();
    try {
      await pomErasePopup(operatorURL);
      eraseRequested[operatorURL] = true;   // "requested" — confirm vs cancel is indistinguishable here
      render();
    } catch (e) { errMsg = e.message || 'Could not open the erase window.'; render(); }
  }

  // Format a signup failure as "host: status body" (host + trimmed server text).
  function signupErr(e) {
    if (!e) return 'Could not create your account.';
    if (e.floor) return e.message;
    const host = e.operator ? String(e.operator).replace(/^https?:\/\//, '')
      : (e.status ? selectedCentral.replace(/^https?:\/\//, '') : '');
    const parts = [];
    if (host) parts.push(host + ':');
    if (e.status) parts.push(String(e.status));
    const body = (e.body || '').trim().replace(/\s+/g, ' ').slice(0, 120);
    if (body) parts.push(body);
    return parts.length ? parts.join(' ') : (e.message || 'Could not create your account.');
  }

  // Wrap signup() so a single flaky/broken operator at registration time doesn't
  // fail the whole thing: probe first, drop unreachable ones, and on a 5xx/network
  // failure clear the pending registration and re-deal the SAME key across the
  // rest — down to `minOperators`. 4xx (client/protocol) and central failures are
  // never skipped. Sets `skipped`/`signupMeta`; throws on the floor or an
  // unskippable error. `sk` keeps its pubkey across re-deals, so operators that
  // already stored a shard accept the same key again.
  async function signupResilient({ centralURL, token, email, secretKey, render }) {
    let remaining = chosenOperators();
    let attemptToken = token, reauthed = false;
    const skips = [];
    // Pre-flight: drop operators that don't answer a health probe.
    const probes = await Promise.all(remaining.map(async op => [op, await pomProbeServer(op)]));
    probes.forEach(([op, st]) => { probeStatus[op] = st; });
    remaining = remaining.filter(op => {
      if (probeStatus[op] === 'down') { skips.push({ url: op, reason: 'not responding' }); return false; }
      return true;
    });
    skipped = skips.slice();
    for (;;) {
      if (remaining.length < minOperators) {
        const e = new Error(`Not enough operators are reachable (need at least ${minOperators}). Try again later or adjust Advanced.`);
        e.floor = true; throw e;
      }
      const t = thresholdFor(remaining.length);
      statusMsg = skips.length ? `Registering across ${remaining.length} operators…` : 'Registering your new key…'; render();
      try {
        const res = await pomSignup({ centralURL, token: attemptToken, email, operators: remaining, threshold: t, secretKey, relays });
        signupMeta = { central: centralURL, operators: remaining.slice(), threshold: t, skipped: skips.slice() };
        skipped = skips.slice();
        return res;
      } catch (e) {
        if (e.status === 401 && !reauthed) { reauthed = true; attemptToken = await pomAuthenticate(centralURL); continue; }
        // Any post-start failure may have left a pending/partial registration —
        // clear it before retrying or bailing (idempotent; no-op with no account).
        try { await pomDeleteAccount(centralURL, attemptToken); } catch {}
        if (e.operator && !pomIsShardConflict(e) && !(e.status >= 400 && e.status < 500)) {
          // Operator down / 5xx: drop it and re-deal across the rest.
          skips.push({ url: e.operator, reason: e.status ? `server error ${e.status}` : 'unreachable' });
          remaining = remaining.filter(op => pomMassageURL(op) !== pomMassageURL(e.operator));
          skipped = skips.slice();
          continue;
        }
        throw e;   // 4xx / shard-conflict / central failure → caller decides
      }
    }
  }

  async function doReplace(render) {
    step = 'replacing'; statusMsg = 'Erasing the old account…'; errMsg = ''; skipped = []; render();
    try {
      const secretKey = mode === 'import' ? hexToBytes(nsecToHex(nsecVal.trim())) : undefined;
      // Delete first (also clears any pending registration), re-auth once on 401.
      try {
        await pomDeleteAccount(auth.centralURL, auth.token);
      } catch (e) {
        if (e.status === 401) { auth.token = await pomAuthenticate(auth.centralURL); await pomDeleteAccount(auth.centralURL, auth.token); }
        else throw e;
      }
      const res = await signupResilient({ centralURL: auth.centralURL, token: auth.token, email: auth.email, secretKey, render });
      window.__pomBunker = res.bunkerURI;
      if (mode === 'import') {
        // They brought the key — nothing to reveal. Straight into the signer.
        await connectBunker(res.bunkerURI, render);
      } else {
        createdNsec = res.nsec; nsecSaved = false;
        step = 'created'; render();   // reveal the fresh nsec once, then Continue
      }
    } catch (e) {
      if (pomIsShardConflict(e) && e.operator) {
        // That operator's erase was cancelled — it still holds the old share.
        delete eraseRequested[pomMassageURL(e.operator)];
        errMsg = `${e.operator.replace(/^https?:\/\//, '')} still holds your old share — erase it and continue.`;
      } else {
        try { await pomDeleteAccount(auth.centralURL, auth.token); } catch {}   // so Retry never hits the 60s 409
        errMsg = signupErr(e);
      }
      step = 'replace-erase'; render();
    }
  }

  async function doSignup(render) {
    step = 'creating'; statusMsg = 'Creating your account…'; errMsg = ''; skipped = []; render();
    try {
      const secretKey = mode === 'import' ? hexToBytes(nsecToHex(nsecVal.trim())) : undefined;
      const res = await signupResilient({ centralURL: auth.centralURL, token: auth.token, email: auth.email, secretKey, render });
      createdNsec = res.nsec; nsecSaved = false;
      window.__pomBunker = res.bunkerURI;
      step = 'created'; render();
    } catch (e) {
      try { await pomDeleteAccount(auth.centralURL, auth.token); } catch {}   // so Retry never hits the 60s 409
      errMsg = signupErr(e);
      step = 'new-account'; render();
    }
  }

  async function addShard(operatorURL, render) {
    errMsg = ''; render();
    try {
      shards[operatorURL] = await requestOperatorShard(operatorURL);
      if (Object.keys(shards).length >= defaultThreshold) {
        recovered = reconstructFromShards(Object.values(shards));
        step = 'recovered'; render();
      } else { render(); }
    } catch (e) { errMsg = e.message || 'Could not recover that shard.'; render(); }
  }

  function render() {
    container.innerHTML = '';

    if (step === 'unconfigured') {
      const { wrap, body, footer } = flowWrap({ step: 0, total: 1, title: 'Google Sign-In Unavailable', subtitle: 'This app has not finished setting up Google sign-in.', onBack });
      body.appendChild(badge('warning', '🔧', 'Not configured', 'The developer needs to configure a pomegranate central server and operators to enable “Continue with Google”. Use another method for now.'));
      footer.appendChild(btn('Back', 'primary', onBack));
      container.appendChild(wrap);

    } else if (step === 'idle') {
      const { wrap, body, footer } = flowWrap({ step: 0, total: 3, title: 'Continue with Google', subtitle: 'Sign in with Google — your key is split across independent servers and never held whole.', onBack });
      if (errMsg) body.appendChild(h('div', { class: 'mill-error' }, errMsg));

      // Advanced disclosure — how-it-works, servers, and recovery. Collapsed by
      // default so most users never see any of the machinery.
      body.appendChild(h('button', { class: 'mill-consent-manage', type: 'button', style: { marginTop: '6px', fontWeight: '600' },
        onClick: () => { advancedOpen = !advancedOpen; render(); if (advancedOpen) probeAdvanced(render); } }, `${advancedOpen ? '▾' : '▸'} Advanced`));
      if (advancedOpen) {
        const panel = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px', padding: '10px', border: '1px solid var(--mill-border)', borderRadius: '10px', background: 'var(--mill-inset)' } });
        panel.appendChild(badge('info', '🔒', 'How this works', 'A Nostr key is created for you and split into encrypted shares across several operators (a threshold is needed to sign). Google only proves it’s you; the full key is never reassembled.'));
        if (allowCustomCentral) {
          panel.appendChild(h('div', { class: 'mill-label' }, 'Central server'));
          if (!customCentralMode) {
            const sel = h('select', { class: 'mill-input', style: { width: '100%', background: 'var(--mill-surface)', color: 'var(--mill-text)', border: '1px solid var(--mill-border)', borderRadius: '8px', padding: '8px 10px', fontSize: '13px' }, onChange: e => { if (e.target.value === '__custom__') { customCentralMode = true; } else { selectedCentral = e.target.value; } render(); } });
            centralChoices.forEach(c => { const o = h('option', { value: c, style: { background: 'var(--mill-surface)', color: 'var(--mill-text)' } }, c.replace(/^https?:\/\//, '') + (c === defaultCentral ? ' (default)' : '')); if (c === selectedCentral) o.selected = true; sel.appendChild(o); });
            sel.appendChild(h('option', { value: '__custom__', style: { background: 'var(--mill-surface)', color: 'var(--mill-text)' } }, 'Custom…'));
            panel.appendChild(sel);
          } else {
            const { wrap: cw, input: ci } = field('', 'https://central.example.com', '', () => {}, {}); cw.style.flex = '1';
            const useBtn = btn('Use', 'ghost small', () => { const v = ci.value.trim(); if (pomIsValidServerURL(v)) { selectedCentral = pomMassageURL(v); if (!centralChoices.includes(selectedCentral)) centralChoices.push(selectedCentral); customCentralMode = false; errMsg = ''; render(); } else { errMsg = 'Enter a valid https:// server URL'; render(); } });
            const cancelBtn = btn('Cancel', 'ghost small', () => { customCentralMode = false; render(); });
            panel.appendChild(h('div', { style: { display: 'flex', gap: '6px', alignItems: 'flex-start' } }, cw, useBtn, cancelBtn));
          }
        }
        if (allowCustomOperators) {
          panel.appendChild(h('div', { class: 'mill-label' }, 'Operators'));
          selectedOperators.forEach(o => {
            const st = probeStatus[o.url];
            const title = st === 'up' ? 'Responding' : st === 'down' ? 'Not responding' : 'Checking…';
            const dot = h('span', { title, style: { display: 'inline-block', width: '9px', height: '9px', borderRadius: '50%', flex: '0 0 auto', background: st === 'up' ? 'var(--mill-success)' : st === 'down' ? 'var(--mill-danger)' : 'var(--mill-border)' } });
            const cb = h('input', { type: 'checkbox' }); cb.checked = o.checked; cb.addEventListener('change', e => { o.checked = e.target.checked; render(); });
            panel.appendChild(h('label', { title, style: { display: 'flex', gap: '8px', alignItems: 'center', fontSize: '13px', cursor: 'pointer' } }, cb, dot, h('span', {}, o.url.replace(/^https?:\/\//, '') + (st === 'down' ? ' — not responding' : ''))));
          });
          panel.appendChild(h('div', { class: 'mill-hint', style: { display: 'flex', gap: '12px', alignItems: 'center' } },
            h('span', {}, '● responding'), h('span', { style: { color: 'var(--mill-danger)' } }, '● not responding')));
          const { wrap: aw, input: ai } = field('', 'https://po.example.com', '', () => {}, {}); aw.style.flex = '1';
          const addBtn = btn('Add', 'ghost small', () => { const v = ai.value.trim(); if (!pomIsValidServerURL(v)) { errMsg = 'Enter a valid https:// operator URL'; render(); return; } const u = pomMassageURL(v); if (!selectedOperators.find(x => x.url === u)) selectedOperators.push({ url: u, checked: true }); errMsg = ''; render(); probeAdvanced(render, [u]); });
          panel.appendChild(h('div', { style: { display: 'flex', gap: '6px', alignItems: 'flex-start' } }, aw, addBtn));
        }
        const n = chosenOperators().length;
        panel.appendChild(h('div', { class: 'mill-hint' }, n >= minOperators ? `Any ${effThreshold()} of the ${n} selected operators can sign.` : `Select at least ${minOperators} operators.`));
        panel.appendChild(h('div', { class: 'mill-hint' }, 'Applies to new accounts — existing accounts keep their recorded operators.'));
        // Recovery lives here — a rare, advanced action.
        panel.appendChild(h('button', { class: 'mill-consent-manage', type: 'button', style: { marginTop: '2px' },
          onClick: () => { returnTo = ''; step = 'recover'; errMsg = ''; render(); } }, 'Recover my key from operators'));
        if (!isDefaultSelection()) panel.appendChild(h('button', { class: 'mill-consent-manage', type: 'button', onClick: () => { resetServers(); errMsg = ''; render(); } }, 'Reset to defaults'));
        body.appendChild(panel);
      }
      // Status line — only when the selection is customised, to keep defaults clean.
      if (!isDefaultSelection()) {
        const n = chosenOperators().length;
        body.appendChild(h('div', { class: 'mill-hint', style: { marginTop: '2px' } }, `Signing in at ${selectedCentral.replace(/^https?:\/\//, '')} · ${n} operators, ${effThreshold()} needed`));
      }
      const blockPrimary = customCentralMode || chosenOperators().length < minOperators;
      footer.appendChild(btn('Back', 'ghost', onBack));
      footer.appendChild(btn([googleLogoOnWhite(18), 'Continue with Google'], 'primary', () => { intent = 'signin'; start(render); }, blockPrimary));
      container.appendChild(wrap);

    } else if (step === 'signed-in') {
      const { wrap, body, footer } = flowWrap({ step: 0, total: 1, title: 'Signed In', subtitle: 'Your Google account is linked to this Nostr identity.', onBack: () => { step = 'idle'; render(); } });
      body.appendChild(badge('success', '✅', 'You’re signed in', 'Continue to start using your account, or swap in a different key.'));
      body.appendChild(keyDisplay('Your account (npub)', hexToNpub(account.pubkey)));
      body.appendChild(h('button', { class: 'mill-consent-manage', type: 'button', style: { marginTop: '2px' },
        onClick: () => startReplaceFromSignedIn(render) }, 'Use a different key with this Google account'));
      if (errMsg) body.appendChild(h('div', { class: 'mill-error' }, errMsg));
      footer.appendChild(btn('Back', 'ghost', () => { step = 'idle'; render(); }));
      footer.appendChild(btn('Continue', 'primary', () => continueSignedIn(render)));
      container.appendChild(wrap);

    } else if (step === 'found-elsewhere') {
      const foundHost = foundCtx.foundCentral.replace(/^https?:\/\//, '');
      const cfgHost = selectedCentral.replace(/^https?:\/\//, '');
      const isReplace = intent === 'replace';
      const { wrap, body, footer } = flowWrap({ step: 0, total: isReplace ? 4 : 3, title: 'Account Found Elsewhere', subtitle: `This Google account already has a Nostr identity at ${foundHost}.`, onBack: () => { step = 'idle'; render(); } });
      if (isReplace) {
        body.appendChild(badge('info', '🔀', 'Where should your key live?', `Your account is at ${foundHost}. You can replace the key there, or import it here at ${cfgHost} — which creates the account here and makes this the identity other clients discover from now on.`));
        body.appendChild(btn(`Replace the key at ${foundHost}`, 'ghost', () => continueThere(render)));
        if (errMsg) body.appendChild(h('div', { class: 'mill-error' }, errMsg));
        footer.appendChild(btn('Cancel', 'ghost', () => { step = 'idle'; render(); }));
        footer.appendChild(btn(`Import here (${cfgHost})`, 'primary', () => importHere(render)));
      } else {
        body.appendChild(badge('info', '🔎', 'Use your existing account', `Sign in at ${foundHost} to use the identity you already have there. Signing in creates nothing new.`));
        if (errMsg) body.appendChild(h('div', { class: 'mill-error' }, errMsg));
        footer.appendChild(btn('Cancel', 'ghost', () => { step = 'idle'; render(); }));
        footer.appendChild(btn([googleLogoOnWhite(18), 'Continue there'], 'primary', () => continueThere(render)));
      }
      container.appendChild(wrap);

    } else if (step === 'new-account') {
      const importing = mode === 'import';
      const keyOk = () => !importing || isValidNsec(nsecVal.trim());
      const goBtn = btn(importing ? 'Import & Shard' : 'Create Account', 'primary', () => { if (keyOk()) doSignup(render); }, !keyOk());
      const { wrap, body, footer } = flowWrap({ step: 1, total: 3, title: 'Set Up Your Account', subtitle: 'Create a fresh key, or bring your own to shard across the operators.', onBack: () => { step = 'idle'; render(); } });
      keyChooser(body, () => { goBtn.disabled = !keyOk(); });
      if (importing) {
        body.appendChild(badge('warning', '⚠️', 'Sharding an existing identity', 'Your key will be split into shares and sent to the operators. They become semi-custodians of THIS identity — any threshold of them could rebuild it. Only do this with operators you trust, and keep your own backup of the key.'));
      } else {
        body.appendChild(badge('info', '🎲', 'Fresh key', 'A brand-new key is generated in your browser, sharded, and distributed. You never have to write anything down (though you can back it up on the next screen).'));
      }
      if (errMsg) body.appendChild(h('div', { class: 'mill-error' }, errMsg));
      footer.appendChild(btn('Back', 'ghost', () => { step = 'idle'; render(); }));
      footer.appendChild(goBtn);
      container.appendChild(wrap);

    } else if (step === 'replace-confirm') {
      const importing = mode === 'import';
      const targets = eraseTargets();
      const isSameKey = () => {
        if (!importing || !isValidNsec(nsecVal.trim())) return false;
        try { return getPublicKey(hexToBytes(nsecToHex(nsecVal.trim()))) === account.pubkey; } catch { return false; }
      };
      const keyValid = () => !importing || (isValidNsec(nsecVal.trim()) && !isSameKey());
      const canReplace = () => ackReplace && keyValid();
      const sameKeyErr = h('div', { class: 'mill-error', hidden: true }, "That's already the key on this account.");
      const replaceBtn = btn('Replace key', 'danger', () => { if (canReplace()) { errMsg = ''; step = 'replace-erase'; render(); } }, !canReplace());
      const sync = () => { sameKeyErr.hidden = !isSameKey(); replaceBtn.disabled = !canReplace(); };

      const { wrap, body, footer } = flowWrap({ step: 0, total: 4, title: 'Replace Your Key', subtitle: 'Put a different Nostr identity behind this Google account.', onBack: () => { step = 'idle'; render(); } });
      body.appendChild(keyDisplay(`Current identity — sharded across ${targets.length} operators, ${account.threshold} needed`, hexToNpub(account.pubkey)));
      body.appendChild(badge('danger', '⚠️', 'This permanently replaces your current identity', `This replaces the identity tied to ${auth.email}. Your posts, follows and messages belong to the current key; after replacing, nothing can sign as it again unless you keep a backup. If this identity matters to you, back it up first.`));
      body.appendChild(btn('Back up current key first', 'ghost', () => { returnTo = 'replace-confirm'; step = 'recover'; errMsg = ''; render(); }));
      if (backedUp) body.appendChild(h('div', { class: 'mill-hint' }, '✅ Backed up'));
      keyChooser(body, sync);
      if (importing) body.appendChild(sameKeyErr);
      body.appendChild(checkboxRow('I understand my current key will be erased from the operators and this cannot be undone.', ackReplace, v => { ackReplace = v; sync(); }));
      if (errMsg) body.appendChild(h('div', { class: 'mill-error' }, errMsg));
      footer.appendChild(btn('Back', 'ghost', () => { step = 'idle'; render(); }));
      footer.appendChild(replaceBtn);
      container.appendChild(wrap);

    } else if (step === 'replace-erase') {
      const targets = eraseTargets();
      const allRequested = targets.length > 0 && targets.every(op => eraseRequested[op]);
      const { wrap, body, footer } = flowWrap({ step: 1, total: 4, title: 'Erase Old Shares', subtitle: 'Sign in with Google at each operator and confirm the erase.', onBack: () => { step = 'replace-confirm'; render(); } });
      body.appendChild(h('div', { class: 'mill-hint' }, 'Do all of them — stopping halfway leaves your old key unrecoverable with no new key in place.'));
      targets.forEach(op => {
        const have = !!eraseRequested[op];
        const row = h('div', { class: 'mill-grant-row' });
        row.appendChild(h('div', { class: 'mill-grant-left' }, h('div', { class: 'mill-grant-kind' }, `${have ? '✅' : '⏳'} ${op.replace(/^https?:\/\//, '')}`)));
        row.appendChild(h('div', { class: 'mill-grant-actions' },
          btn(have ? 'Requested' : 'Erase', 'ghost', () => { if (!have) eraseAt(op, render); })));
        body.appendChild(row);
      });
      if (errMsg) body.appendChild(h('div', { class: 'mill-error' }, errMsg));
      footer.appendChild(btn('Back', 'ghost', () => { step = 'replace-confirm'; render(); }));
      footer.appendChild(btn('Continue', 'primary', () => doReplace(render), !allRequested));
      container.appendChild(wrap);

    } else if (step === 'connecting' || step === 'creating' || step === 'connecting-signer' || step === 'replacing') {
      const isReplace = step === 'replacing';
      const title = step === 'creating' ? 'Creating your account…' : isReplace ? 'Replacing your key…' : 'Connecting…';
      const sub = step === 'creating' ? 'Splitting and distributing your key…'
        : isReplace ? (statusMsg || 'Working…')
        : step === 'connecting-signer' ? 'Connecting to your signer…'
        : 'Approve access in the Google window.';
      const { wrap, body } = flowWrap({ step: isReplace ? 2 : 1, total: isReplace ? 4 : 3, title, subtitle: sub });
      const center = h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '14px', padding: '30px 0' } });
      center.appendChild(spinner()); center.appendChild(h('span', { style: { color: 'var(--mill-text-secondary)' } }, statusMsg || 'One moment…'));
      body.appendChild(center);
      container.appendChild(wrap);

    } else if (step === 'created') {
      const { wrap, body, footer } = flowWrap({ step: 2, total: 3, title: 'Account Created', subtitle: 'Your account is ready. Optionally save your key before continuing — it is otherwise held only as shares across the operators.', onBack: () => { step = 'idle'; render(); } });
      body.appendChild(badge('success', '🎉', 'You’re set up', 'You can sign in from any compatible app with this Google account.'));
      if (skipped.length) body.appendChild(badge('warning', '⚠️', 'Some operators were left out', `${skipped.map(s => `${s.url.replace(/^https?:\/\//, '')} (${s.reason})`).join('; ')}. Your key is sharded across ${signupMeta?.operators?.length ?? '?'} operators; any ${signupMeta?.threshold ?? '?'} can sign.`));
      body.appendChild(keyDisplay('Private Key (nsec) — optional backup, keep secret', createdNsec, true));
      body.appendChild(badge('muted', '💾', null, 'Saving this is optional — you can recover later with Google as long as the operators are online. But keeping your own copy means you never depend on them.'));
      footer.appendChild(btn('Continue', 'primary', () => connectBunker(window.__pomBunker, render)));
      container.appendChild(wrap);

    } else if (step === 'recover') {
      const { wrap, body, footer } = flowWrap({ step: 0, total: 2, title: 'Recover Your Key', subtitle: 'Sign in with Google at each operator to collect your key shares. Once enough are collected, your key is reassembled here, in your browser.', onBack: () => { step = returnTo || 'idle'; render(); } });
      body.appendChild(h('div', { class: 'mill-hint' }, `Collected ${Object.keys(shards).length} of ${defaultThreshold} needed.`));
      operatorChoices.forEach(op => {
        const have = !!shards[op];
        const row = h('div', { class: 'mill-grant-row' });
        row.appendChild(h('div', { class: 'mill-grant-left' }, h('div', { class: 'mill-grant-kind' }, `${have ? '✅' : '⏳'} ${op.replace(/^https?:\/\//, '')}`)));
        row.appendChild(h('div', { class: 'mill-grant-actions' },
          btn(have ? 'Got it' : 'Recover', 'ghost', () => { if (!have) addShard(op, render); })));
        body.appendChild(row);
      });
      if (errMsg) body.appendChild(h('div', { class: 'mill-error' }, errMsg));
      footer.appendChild(btn('Back', 'ghost', () => { step = returnTo || 'idle'; render(); }));
      container.appendChild(wrap);

    } else if (step === 'recovered') {
      const { wrap, body, footer } = flowWrap({ step: 1, total: 2, title: 'Key Recovered', subtitle: 'Your key has been reassembled. Save it somewhere only you control.', onBack: () => { step = 'recover'; render(); } });
      body.appendChild(keyDisplay('Private Key (nsec) — KEEP SECRET', recovered.nsec, true));
      body.appendChild(keyDisplay('Public Key (npub)', recovered.npub));
      body.appendChild(badge('warning', '🔑', 'This is your full key', 'Store it in a password manager or offline. Anyone with it controls your account.'));
      footer.appendChild(btn('Done', 'primary', () => { if (returnTo) { backedUp = true; step = returnTo; returnTo = ''; } else { step = 'idle'; } render(); }));
      container.appendChild(wrap);
    }
  }
  render();
  return container;
}

// ── Flow: New Keypair ─────────────────────────────────────────────────────────
function renderNewKeypairFlow(host, onDone, onBack) {
  let step = 0, keys = null, checks = [false, false, false], pw = '', pw2 = '', generating = false;
  const perms = Object.fromEntries(SIGN_CATS.map(c => [c.id, c.def]));
  const container = h('div', {});

  function render() {
    container.innerHTML = '';
    if (step === 0) {
      const { wrap, body, footer } = flowWrap({ step: 0, total: 5, title: 'Generate New Identity', subtitle: "Create a fresh Nostr keypair using your browser's CSPRNG.", onBack });
      if (generating) {
        const center = h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '14px', padding: '30px 0' } });
        center.appendChild(spinner()); center.appendChild(h('span', { style: { color: 'var(--mill-text-secondary)' } }, 'Generating secure random keys…'));
        body.appendChild(center);
      } else {
        body.appendChild(badge('info', '🎲', 'Cryptographically secure', 'Keys are generated using crypto.getRandomValues() — your browser\'s CSPRNG. Nothing is transmitted to any server.'));
        body.appendChild(badge('warning', '⚠️', 'Backup your key before using this identity', 'There is no account recovery or password reset. If you lose your nsec, you lose the identity — forever.'));
      }
      footer.appendChild(btn('Cancel', 'ghost', onBack));
      footer.appendChild(btn(generating ? 'Generating…' : 'Generate Keys', 'primary', async () => {
        generating = true; render();
        keys = await generateKeypair();
        generating = false; step = 1; render();
      }, generating));
      container.appendChild(wrap);
    } else if (step === 1 && keys) {
      const { wrap, body, footer } = flowWrap({ step: 1, total: 5, title: 'Save Your Keys', subtitle: 'Copy your private key now — this is the only time it will be shown in full.', onBack: () => { step = 0; render(); } });
      body.appendChild(badge('danger', '🔴', 'Never share your nsec', 'Anyone who sees your nsec can impersonate you, read your DMs, and permanently take over your account.'));
      body.appendChild(keyDisplay('Private Key (nsec) — KEEP SECRET', keys.nsec, true));
      body.appendChild(keyDisplay('Public Key (npub) — safe to share', keys.npub));
      body.appendChild(badge('muted', '💾', null, 'Save to a password manager, encrypted note, or paper stored offline. Never in a plain cloud note or screenshot.'));
      footer.appendChild(btn('Back', 'ghost', () => { step = 0; render(); }));
      footer.appendChild(btn("I've Saved My Keys", 'primary', () => { step = 2; render(); }));
      container.appendChild(wrap);
    } else if (step === 2) {
      const { wrap, body, footer } = flowWrap({ step: 2, total: 5, title: 'Confirm Backup', subtitle: "Check each box to confirm you've secured your key.", onBack: () => { step = 1; render(); } });
      const items = [
        'I have copied my nsec private key to a secure, private location.',
        'I understand that losing my nsec means permanently losing this identity with no recovery.',
        'I will never share my nsec or paste it into a site I do not fully trust.',
      ];
      items.forEach((text, i) => {
        const row = h('div', { class: `mill-check-item${checks[i] ? ' checked' : ''}`, onClick: () => { checks[i] = !checks[i]; render(); } });
        const box = h('div', { class: 'mill-check-box' }, checks[i] ? '✓' : '');
        row.appendChild(box);
        row.appendChild(h('span', { style: { fontSize: '13.5px', lineHeight: '1.55', color: 'var(--mill-text-secondary)' } }, text));
        body.appendChild(row);
      });
      footer.appendChild(btn('Back', 'ghost', () => { step = 1; render(); }));
      footer.appendChild(btn('Continue', 'primary', () => { step = 3; render(); }, !checks.every(Boolean)));
      container.appendChild(wrap);
    } else if (step === 3) {
      const { wrap, body, footer } = flowWrap({ step: 3, total: 5, title: 'Encrypt & Signing Settings', subtitle: 'Set a session password to protect your key in this browser, and choose what gets signed automatically.', onBack: () => { step = 2; render(); } });
      const isOk = () => pw.length >= 4 && pw === pw2;
      const contBtn = btn('Continue', 'primary', () => { if (isOk()) { step = 4; render(); } }, !isOk());
      const err1 = h('div', { class: 'mill-error' });
      const err2 = h('div', { class: 'mill-error' });
      const updateUi = () => {
        contBtn.disabled = !isOk();
        err1.textContent = pw && pw.length < 4 ? 'Minimum 4 characters' : '';
        err2.textContent = pw2 && pw !== pw2 ? 'Passwords do not match' : '';
      };
      const { wrap: pw1 } = field('Session Password', 'Minimum 4 characters', pw, v => { pw = v; updateUi(); }, { type: 'password' });
      const { wrap: pw2w } = field('Confirm Password', 'Repeat password', pw2, v => { pw2 = v; updateUi(); }, { type: 'password' });
      pw1.appendChild(err1); pw2w.appendChild(err2);
      body.appendChild(pw1); body.appendChild(pw2w);
      body.appendChild(h('div', { class: 'mill-divider' }));
      body.appendChild(signingBehaviorEditor(perms));
      footer.appendChild(btn('Back', 'ghost', () => { step = 2; render(); }));
      footer.appendChild(contBtn);
      container.appendChild(wrap);
    } else {
      const { wrap, body, footer } = flowWrap({ step: 4, total: 5, title: 'Welcome to Nostr', subtitle: 'Your new identity is ready.', onBack: () => { step = 3; render(); } });
      body.appendChild(keyDisplay('Your Public Key (npub)', keys?.npub || ''));
      body.appendChild(badge('success', '🎉', 'Identity created!', 'Your Nostr identity is ready. Share your npub so others can find and follow you. Your profile, follows, and notes are yours — no platform can take them away.'));
      footer.appendChild(btn('Back', 'ghost', () => { step = 3; render(); }));
      footer.appendChild(btn('Enter Nostr ✨', 'success', async () => {
        const encrypted = await encryptNsec(keys.privHex, pw);
        storeEncryptedNsec(encrypted);
        storeSignPerms(perms);   // so MILL.restore() can rebuild with the same policy after reload
        const signer = createPrivateKeySigner({
          pubkey: keys.pubHex, perms,
          promptPassword: sessionPrompt(host, pw),
          requestConsent: req => host.requestConsent({ ...req, npub: keys.npub }),
        });
        onDone({ method: 'newkey', pubkey: keys.pubHex, nsec: keys.nsec, perms, signer });
      }));
      container.appendChild(wrap);
    }
  }
  render();
  return container;
}

// ── Connected screen ──────────────────────────────────────────────────────────
function renderConnectedScreen(result, onDisconnect, opts = {}) {
  const m = METHOD_META[result.method] || {};
  const wrap = h('div', { class: 'mill-connected' });
  const avatar = h('div', { class: 'mill-connected-avatar' }, iconNode(m.icon, 40));
  avatar.style.background = `radial-gradient(circle, ${m.color}30, transparent)`;
  avatar.style.borderColor = m.color;
  wrap.appendChild(avatar);
  wrap.appendChild(h('div', { style: { textAlign: 'center' } },
    h('div', { style: { fontSize: '22px', fontWeight: '700', marginBottom: '4px' } }, 'Connected'),
    h('div', { style: { fontSize: '14px', color: 'var(--mill-text-secondary)' } }, `Signed in via ${m.label}`)
  ));
  if (result.pubkey) {
    wrap.appendChild(h('div', { style: { width: '100%', background: 'var(--mill-inset)', border: '1px solid var(--mill-border)', borderRadius: '10px', padding: '10px 14px' } },
      h('div', { style: { fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--mill-muted)', marginBottom: '6px' } }, 'Public Key'),
      h('code', { style: { fontSize: '12px', fontFamily: 'var(--mill-font-mono)', color: 'var(--mill-accent)', wordBreak: 'break-all', lineHeight: '1.6' } }, result.pubkey)
    ));
  }
  // "Take control" — only when mill actually holds the key (private-key-backed
  // methods). For NIP-07/46/55 the key lives elsewhere and there's nothing to
  // reveal. Hidden behind a quiet link, per the decision that normies should
  // never have to think about keys until they choose to.
  if (opts.onShowKeys && loadEncryptedNsec()) {
    wrap.appendChild(btn('Take control of my keys', 'ghost small', opts.onShowKeys));
  }
  wrap.appendChild(btn('Disconnect & Switch Account', 'ghost small', onDisconnect));
  return wrap;
}

// ── Flow: key export ("take control of my keys") ──────────────────────────────
// Reveals the private key mill has been holding, and exports a portable NIP-49
// ncryptsec any other Nostr client can import. Requires re-entering the session
// password / PIN first — seeing the key is exactly when re-authentication is
// warranted, and it means a shoulder-surfer on an unlocked tab still can't.
function renderKeyExport(host, result, onBack) {
  let step = 'auth', pw = '', privHex = '', errMsg = '';
  let pass = '', ncryptsec = '', exporting = false;
  const container = h('div', {});
  const isCloud = result?.method === 'google';

  function render() {
    container.innerHTML = '';

    if (step === 'auth') {
      const label = isCloud ? 'PIN' : 'Session password';
      const { wrap, body, footer } = flowWrap({ step: 0, total: 2, title: 'Take Control of Your Keys', subtitle: `Enter your ${label.toLowerCase()} to reveal your private key.`, onBack });
      body.appendChild(badge('warning', '🔑', 'Your private key is about to be shown', 'Anyone who sees it gains full control of your account. Make sure no one is watching your screen, and only save it somewhere private.'));
      const f = field(label, isCloud ? '4–8 letters or numbers' : 'Your password', pw, v => { pw = v; errMsg = ''; },
        { type: 'password', error: errMsg, maxlength: isCloud ? 8 : undefined });
      body.appendChild(f.wrap);
      const submit = async () => {
        try {
          const enc = loadEncryptedNsec();
          privHex = await decryptNsec(enc, pw);
          step = 'reveal'; render();
        } catch { errMsg = isCloud ? 'Wrong PIN' : 'Wrong password'; render(); }
      };
      if (f.input) f.input.addEventListener('keydown', e => { if (e.key === 'Enter' && pw) submit(); });
      footer.appendChild(btn('Cancel', 'ghost', onBack));
      footer.appendChild(btn('Reveal', 'primary', submit));
      container.appendChild(wrap);

    } else {
      const nsec = hexToNsec(privHex);
      const { wrap, body, footer } = flowWrap({ step: 1, total: 2, title: 'Your Keys', subtitle: 'This is your account. Save it somewhere only you control.', onBack: () => { step = 'auth'; pw = ''; privHex = ''; render(); } });
      body.appendChild(keyDisplay('Private Key (nsec) — KEEP SECRET', nsec, true));
      if (result?.pubkey) body.appendChild(keyDisplay('Public Key (npub) — safe to share', hexToNpub(result.pubkey)));

      if (isCloud) {
        body.appendChild(badge('info', '☁️', 'Your cloud backup still exists', 'A copy of this key is still encrypted in your Google Drive so you can keep signing in with Google. Saving your nsec here is an additional, portable copy — it does not remove the cloud one.'));
      }

      body.appendChild(h('div', { class: 'mill-divider' }));

      // Portable export: NIP-49 ncryptsec, importable by any Nostr client.
      body.appendChild(h('div', { style: { fontSize: '13px', fontWeight: '600', marginBottom: '2px' } }, 'Export an encrypted backup'));
      body.appendChild(h('div', { class: 'mill-hint' }, 'Protect your key with a passphrase (min 8 characters). The result is a standard ncryptsec you can import into any Nostr app.'));
      const pf = field('Backup passphrase', 'At least 8 characters', pass, v => { pass = v; }, { type: 'password' });
      body.appendChild(pf.wrap);
      if (ncryptsec) body.appendChild(keyDisplay('Encrypted Key (ncryptsec)', ncryptsec, true));
      if (errMsg) body.appendChild(h('div', { class: 'mill-error' }, errMsg));

      footer.appendChild(btn('Done', 'ghost', onBack));
      footer.appendChild(btn(exporting ? 'Encrypting…' : 'Export ncryptsec', 'primary', async () => {
        errMsg = '';
        if (pass.length < 8) { errMsg = 'Use at least 8 characters'; render(); return; }
        exporting = true; render();
        try { ncryptsec = exportNcryptsec(privHex, pass); }
        catch (e) { errMsg = e.message || 'Export failed'; }
        exporting = false; render();
      }, exporting));
      container.appendChild(wrap);
    }
  }
  render();
  return container;
}

// ── Flow: Unlock (standalone password prompt for restore) ─────────────────────
// Shown by MILL.restore() when a private-key signer needs the session password
// after a reload — the full picker stays closed; only the password is asked.
// ── Flow: signing consent ─────────────────────────────────────────────────────
// Shown per signature when neither a per-kind grant nor the category policy
// has already authorised it. Deliberately minimal by default — Amber shows one
// sentence and hides the payload behind "Show Details"; dumping raw JSON at
// someone every time trains them to click through without reading.
function renderConsentFlow(host, req, onDecide) {
  const { event, label, category } = req;
  let showDetails = false;
  let duration = 'once';                 // safe default: remember nothing
  const container = h('div', {});

  const appName = host.getAttribute?.('app-name') || document.title || 'This app';
  const npub    = req.npub || '';

  function render() {
    container.innerHTML = '';
    const { wrap, body, footer } = flowWrap({
      step: 0, total: 1,
      title: 'Approve Signing',
      subtitle: 'Review this request before it is signed with your private key.',
    });

    const head = h('div', { class: 'mill-consent-head' });
    head.appendChild(h('div', { class: 'mill-consent-icon' }, '✍️'));
    const ask = h('div', { class: 'mill-consent-ask' });
    ask.appendChild(h('div', {},
      h('span', {}, `${appName} wants you to sign ${kindArticle(label)} `),
      h('span', { class: 'mill-consent-kind' }, label),
    ));
    if (npub) ask.appendChild(h('div', { class: 'mill-consent-as' }, `Signing as ${npub}`));
    head.appendChild(ask);
    body.appendChild(head);

    const toggle = h('button', { class: 'mill-consent-toggle', type: 'button',
      onClick: () => { showDetails = !showDetails; render(); } },
      h('span', {}, showDetails ? '▾' : '▸'),
      h('span', {}, showDetails ? 'Hide details' : 'Show details'),
    );
    body.appendChild(toggle);

    if (showDetails) {
      const d = h('div', { class: 'mill-consent-details' });
      const field = (k, v) => {
        if (v === null || v === undefined || v === '') return;
        d.appendChild(h('div', { class: 'mill-consent-field' },
          h('div', { class: 'mill-consent-field-k' }, k),
          h('div', { class: 'mill-consent-field-v' }, String(v)),
        ));
      };
      const nip = kindNip(event?.kind);
      field('Kind', nip ? `${event?.kind} — ${label} (${nip})` : `${event?.kind} — ${label}`);
      if (event?.created_at) {
        const ts = new Date(event.created_at * 1000);
        field('Date', isNaN(ts) ? String(event.created_at) : ts.toLocaleString());
      }
      // Content is shown decoded, not as escaped JSON — the point is that a
      // person can actually read what they're signing.
      field('Content', event?.content ?? '');
      const tags = Array.isArray(event?.tags) ? event.tags : [];
      if (tags.length) field('Tags', tags.map(t => Array.isArray(t) ? t.join(' · ') : String(t)).join('\n'));
      body.appendChild(d);
    }

    const remember = h('div', { class: 'mill-consent-remember' });
    remember.appendChild(h('div', { class: 'mill-consent-remember-label' }, `Remember for ${label}`));
    const durs = h('div', { class: 'mill-consent-durations' });
    DURATIONS.forEach(o => {
      durs.appendChild(h('button', {
        class: `mill-consent-dur${duration === o.id ? ' active' : ''}`,
        type: 'button',
        onClick: () => { duration = o.id; render(); },
      }, o.label));
    });
    remember.appendChild(durs);
    body.appendChild(remember);

    // Mill is only ever on screen when it's asking for something, so this is
    // the one reliable place to offer a way into its settings — no host-app
    // menu wiring required.
    body.appendChild(h('button', { class: 'mill-consent-manage', type: 'button',
      onClick: () => onDecide({ manage: true }) }, 'Manage permissions'));

    // The chosen duration applies to whichever button is pressed, so
    // "reject this kind for an hour" is expressible — same as Amber.
    footer.appendChild(btn('Reject', 'ghost', () => onDecide({ approved: false, duration })));
    footer.appendChild(btn('Approve & Sign', 'primary', () => onDecide({ approved: true, duration })));
    container.appendChild(wrap);
  }
  render();
  return container;
}

// ── Flow: permissions manager ─────────────────────────────────────────────────
// Lists every live per-kind grant with the same two controls as the consent
// card — what, and for how long — so the two screens read as one system.
function renderPermissionsScreen(host, onBack) {
  const container = h('div', {});

  function render() {
    container.innerHTML = '';
    sweepExpiredGrants();
    const grants = listGrants();
    const { wrap, body, footer } = flowWrap({
      step: 0, total: 1,
      title: 'Signing Permissions',
      subtitle: 'Kinds you have already approved or blocked. Removing one means mill will ask again next time.',
      onBack,
    });

    if (!grants.length) {
      body.appendChild(badge('muted', '🗂', 'Nothing remembered yet',
        'When you approve a signing request and choose to remember it, it shows up here. Requests you approve "just this time" are never stored.'));
    } else {
      grants.forEach(g => {
        const row = h('div', { class: 'mill-grant-row' });
        const allowed = g.action !== 'deny';
        const when = g.dur === 'always' ? 'Always'
          : g.dur === 'session' ? 'This session'
          : `Until ${new Date(g.until).toLocaleTimeString()}`;
        row.appendChild(h('div', { class: 'mill-grant-left' },
          h('div', { class: 'mill-grant-kind' },
            `${allowed ? '✅' : '⛔'} ${kindLabel(g.kind)}`),
          h('div', { class: 'mill-grant-meta' }, `kind ${g.kind} · ${allowed ? 'allowed' : 'blocked'} · ${when}`),
        ));
        const actions = h('div', { class: 'mill-grant-actions' });
        const mk = (text, active, color, onClick) => {
          const b = h('button', { class: 'mill-grant-btn', type: 'button', onClick }, text);
          if (active) { b.style.borderColor = color; b.style.color = color; b.style.background = color + '1f'; }
          return b;
        };
        actions.appendChild(mk('Allow', allowed, 'var(--mill-success)',
          () => { saveGrant(g.kind, 'allow', g.dur || 'session'); render(); }));
        actions.appendChild(mk('Block', !allowed, 'var(--mill-danger)',
          () => { saveGrant(g.kind, 'deny', g.dur || 'session'); render(); }));
        actions.appendChild(mk('Ask', false, 'var(--mill-accent)',
          () => { revokeGrant(g.kind); render(); }));
        row.appendChild(actions);
        body.appendChild(row);
      });
      body.appendChild(h('div', { class: 'mill-hint' },
        'These apply only to private-key signing in this browser. NIP-07, NIP-46, and NIP-55 manage approvals in their own app.'));
    }

    if (grants.length) {
      footer.appendChild(btn('Forget all', 'ghost', () => { revokeAllGrants(); render(); }));
    }
    footer.appendChild(btn('Done', 'primary', onBack));
    container.appendChild(wrap);
  }
  render();
  return container;
}

// Password provider for a signer created during a fresh login.
//
// This is the UNLOCK gate only — consent is a separate gate handled by the
// consent card. The user typed this password seconds ago to log in, so that
// already is their once-per-session unlock; asking again here would stack a
// password prompt on top of every approval, which is the friction the
// two-gate split exists to remove.
//
// Authorisation is NOT weakened by this: an unauthorised kind never reaches
// unlock(), because authorize() throws first.
function sessionPrompt(_host, pw) {
  return () => Promise.resolve(pw);
}

function renderUnlockFlow(host, onSubmit, onCancel, opts = {}) {
  let pw = '', errMsg = '';
  const container = h('div', {});
  function render() {
    container.innerHTML = '';
    const { wrap, body, footer } = flowWrap({
      step: 0, total: 1,
      title: opts.title || 'Unlock Signing',
      subtitle: opts.subtitle || 'Enter your session password to unlock signing.',
    });
    body.appendChild(badge('info', '🔒', 'Session locked', 'Your key is encrypted and still stored for this tab. Enter the password you set at login to unlock it — once, for the rest of this session.'));
    const submit = () => {
      if (!pw) { errMsg = 'Password required'; render(); return; }
      onSubmit(pw);
    };
    const { wrap: pwWrap, input } = field('Session Password', 'Your login password', pw, v => { pw = v; errMsg = ''; }, { type: 'password', error: errMsg });
    if (input) input.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
    body.appendChild(pwWrap);
    if (errMsg) body.appendChild(h('div', { class: 'mill-error' }, errMsg));
    footer.appendChild(btn('Cancel', 'ghost', () => onCancel?.()));
    footer.appendChild(btn('Unlock', 'primary', submit));
    container.appendChild(wrap);
  }
  render();
  return container;
}

// ── NostrSignerElement — the Web Component ────────────────────────────────────
class NostrSignerElement extends HTMLElement {
  static get observedAttributes() { return ['theme', 'open']; }

  constructor() {
    super();
    this._shadow = this.attachShadow({ mode: 'open' });
    this._state = { open: false, method: null, connected: null, consent: null, settings: false };
    this._callbacks = { onConnected: null, onClose: null };
  }

  connectedCallback() {
    this._injectStyles();
    this._render();
  }

  disconnectedCallback() {
    try { this._state.connected?.signer?.disconnect?.(); } catch {}
  }

  attributeChangedCallback(name, _old, val) {
    if (name === 'theme') this._applyTheme(val);
    if (name === 'open')  { this._state.open = val !== null && val !== 'false'; this._render(); }
  }

  _injectStyles() {
    if (this._shadow.querySelector('style')) return;
    const style = document.createElement('style');
    style.textContent = BASE_CSS;
    this._shadow.appendChild(style);
  }

  _applyTheme(themeNameOrObj) {
    const host = this._shadow.host;
    const tokens = typeof themeNameOrObj === 'string'
      ? THEMES[themeNameOrObj] ?? THEMES.dark
      : { ...THEMES.dark, ...themeNameOrObj };
    for (const [prop, val] of Object.entries(tokens)) {
      // remap --mill- prefix to :host scope
      host.style.setProperty(prop, val);
    }
  }

  setTheme(theme) { this._applyTheme(theme); }

  open(opts = {}) {
    if (opts.onConnected) this._callbacks.onConnected = opts.onConnected;
    if (opts.onClose)     this._callbacks.onClose     = opts.onClose;
    // Always reset layout/methods/theme state per-open so callers don't inherit
    // values from previous opens. To clear a previous theme override, the caller
    // can pass theme: 'dark' explicitly.
    if (opts.theme)       this._applyTheme(opts.theme);
    this._state.methodFilter = opts.methods;            // undefined → defaults
    this._state.density      = opts.density;            // undefined → comfortable
    this._state.layout       = opts.layout;             // undefined → list
    this._state.callout      = 'callout' in opts ? opts.callout : undefined;  // undefined → 'newkey'
    this._state.relays       = Array.isArray(opts.relays) && opts.relays.length ? opts.relays : undefined;
    this._state.footer       = opts.footer;             // { text?, links?, attribution?, attributionHref? }
    this._state.header       = opts.header;             // { logo?, logoHeight?, title?, message?, align?, label? }
    this._state.tip          = 'tip' in opts ? opts.tip : undefined;   // string | false | undefined
    this._state.pomegranate  = opts.pomegranate;        // { central, operators[], threshold?, relays? }
    this._state.open      = true;
    this._state.method    = null;
    this._state.connected = null;
    this._state.unlock    = null;
    this._render();
  }

  /**
   * Open a minimal password-only prompt (no method picker) and resolve with the
   * entered password, or null if the user cancels. Used by MILL.restore() to
   * unlock a private-key signer after a reload.
   */
  promptPassword({ title, subtitle } = {}) {
    return new Promise(resolve => {
      this._state.unlock = { resolve, title, subtitle };
      this._state.open = true;
      this._state.method = null;
      this._state.connected = null;
      this._render();
    });
  }

  /**
   * Open the signing consent card and resolve with the user's decision:
   * { approved: boolean, duration: 'once'|'5m'|'1h'|'session'|'always' }.
   * Resolves { approved: false } if the modal is dismissed — a request the
   * user walked away from must never count as approval.
   */
  requestConsent(req) {
    return new Promise(resolve => {
      this._state.consent = { ...req, npub: req.npub || this._state.connected?.signer?.npub || '', resolve };
      this._state.open = true;
      this._state.method = null;
      this._render();
    });
  }

  /** Open the permissions manager. Optional for hosts; the consent card links here. */
  openSettings() {
    this._state.settings = true;
    this._state.open = true;
    this._state.method = null;
    this._render();
  }

  close() {
    // Resolve a pending unlock prompt as cancelled so callers don't hang.
    if (this._state.unlock) { const u = this._state.unlock; this._state.unlock = null; u.resolve(null); }
    // Dismissing a consent card is a refusal, never a silent approval, and it
    // must not be remembered — the user made no choice about future requests.
    if (this._state.consent) {
      const c = this._state.consent; this._state.consent = null;
      c.resolve({ approved: false, duration: 'once' });
    }
    this._state.settings = false;
    this._state.open = false;
    this._render();
    this._callbacks.onClose?.();
  }

  _render() {
    // Clear old modal if exists
    const old = this._shadow.querySelector('.mill-overlay');
    if (old) old.remove();
    if (!this._state.open) return;

    const overlay = h('div', { class: 'mill-overlay', onClick: e => { if (e.target === overlay) this.close(); } });
    const modal = h('div', { class: 'mill-modal' });

    // Header strip: dot + label + close. `header.label` overrides the label;
    // '' or false hides the dot+label (the close button always stays).
    const labelCfg = this._state.header?.label;
    const labelText = labelCfg === undefined ? 'Account Access' : labelCfg;
    const headerLeft = h('div', { style: { display: 'flex', alignItems: 'center' } });
    if (labelText) {
      headerLeft.appendChild(h('span', { class: 'mill-header-dot' }));
      headerLeft.appendChild(h('span', { class: 'mill-header-label' }, labelText));
    }
    const header = h('div', { class: 'mill-header' },
      headerLeft,
      h('button', { class: 'mill-close', onClick: () => this.close() }, '✕')
    );
    modal.appendChild(header);

    const body = h('div', { class: 'mill-body' });

    const onDone = result => {
      this._state.connected = result;
      this._state.open = true;
      this._dispatch('mill:connected', result);
      this._callbacks.onConnected?.(result);
      this._render();
    };

    const onBack = () => {
      this._state.method = null;
      this._render();
    };

    if (this._state.consent) {
      const decide = (decision) => {
        // "Manage permissions" keeps the request pending — the user is still
        // deciding, and settings changes should inform that decision.
        if (decision?.manage) { this._state.settings = true; this._render(); return; }
        const c = this._state.consent;
        this._state.consent = null;
        this._state.open = false;
        this._render();
        c?.resolve(decision);
      };
      if (this._state.settings) {
        body.appendChild(renderPermissionsScreen(this, () => { this._state.settings = false; this._render(); }));
      } else {
        body.appendChild(renderConsentFlow(this, this._state.consent, decide));
      }
    } else if (this._state.settings) {
      body.appendChild(renderPermissionsScreen(this, () => {
        this._state.settings = false;
        this._state.open = false;
        this._render();
      }));
    } else if (this._state.unlock) {
      const finish = (pw) => {
        const u = this._state.unlock;
        this._state.unlock = null;
        this._state.open = false;
        this._render();
        u?.resolve(pw);
      };
      body.appendChild(renderUnlockFlow(this,
        (pw) => finish(pw),
        () => finish(null),
        { title: this._state.unlock.title, subtitle: this._state.unlock.subtitle },
      ));
    } else if (this._state.connected && this._state.keyexport) {
      body.appendChild(renderKeyExport(this, this._state.connected, () => {
        this._state.keyexport = false; this._render();
      }));
    } else if (this._state.connected) {
      body.appendChild(renderConnectedScreen(this._state.connected, () => {
        try { this._state.connected?.signer?.disconnect?.(); } catch {}
        // Switching accounts: drop persisted restore state so a later
        // MILL.restore() can't rebuild the account we just left.
        clearStoredNsec(); clearSignPerms(); clearBunkerState();
        this._state.connected = null; this._state.method = null;
        this._dispatch('mill:disconnected', {});
        this._render();
      }, {
        onShowKeys: () => { this._state.keyexport = true; this._render(); },
      }));
    } else if (this._state.method) {
      const flowMap = {
        readonly:   () => renderReadOnlyFlow(this, onDone, onBack),
        privatekey: () => renderPrivateKeyFlow(this, onDone, onBack),
        nip07:      () => renderNIP07Flow(this, onDone, onBack),
        nip46:      () => renderNIP46Flow(this, onDone, onBack, { relays: this._state.relays }),
        nip55:      () => renderNIP55Flow(this, onDone, onBack),
        newkey:     () => renderNewKeypairFlow(this, onDone, onBack),
        google:     () => renderGoogleFlow(this, onDone, onBack),
        pomegranate:() => renderPomegranateFlow(this, onDone, onBack),
        _newhere:   () => renderNewHereChooser(this, id => { this._state.method = id; this._render(); }, onBack),
      };
      const flowFn = flowMap[this._state.method];
      if (flowFn) body.appendChild(flowFn());
    } else {
      body.appendChild(renderMethodSelection(this, id => {
        this._state.method = id; this._render();
      }, {
        methodFilter: this._state.methodFilter,
        density:      this._state.density,
        layout:       this._state.layout,
        callout:      this._state.callout,
        footer:       this._state.footer,
        header:       this._state.header,
        tip:          this._state.tip,
      }));
    }

    modal.appendChild(body);
    overlay.appendChild(modal);
    this._shadow.appendChild(overlay);
  }

  _dispatch(eventName, detail) {
    this.dispatchEvent(new CustomEvent(eventName, { bubbles: true, composed: true, detail }));
  }
}

customElements.define('nostr-signer', NostrSignerElement);

// ── Imperative API (MILL global) ──────────────────────────────────────────────
let _imperativeEl = null;
function _getOrCreateElement() {
  if (!_imperativeEl) {
    _imperativeEl = document.createElement('nostr-signer');
    document.body.appendChild(_imperativeEl);
  }
  return _imperativeEl;
}

const MILL = {
  /**
   * Open the signer modal.
   * @param {{ theme?: string|object, onConnected?: function, onClose?: function,
   *           appName?: string, amberCallback?: string }} opts
   *   appName       — name shown to the user's remote signer / bunker (NIP-46)
   *                   and Amber (NIP-55) instead of the default page title.
   *   amberCallback — server callback URL for the NIP-55 Amber round-trip.
   */
  open(opts = {}) {
    const el = _getOrCreateElement();
    // Surface host config as element attributes so the per-method flows
    // (which read attributes off the host element) pick them up.
    if (opts.appName) el.setAttribute('app-name', opts.appName);
    if (opts.amberCallback) el.setAttribute('amber-callback', opts.amberCallback);
    // Set/clear per-open so a reconfigured open() doesn't inherit stale config.
    if (opts.oauthShim) el.setAttribute('oauth-shim', opts.oauthShim); else el.removeAttribute('oauth-shim');
    el.open(opts);   // pomegranate config travels on _state (set in el.open)
    return el;
  },

  /**
   * Rebuild a signer after a page reload WITHOUT opening the picker, using the
   * state mill persisted at login (sessionStorage). The host is responsible for
   * remembering which method + pubkey the session used (e.g. from onConnected)
   * and passing them here.
   *
   * Accepts mill method ids (nip07, nip46, nip55, privatekey, newkey, readonly)
   * or the common grain-style aliases (browser_extension, bunker, amber,
   * encrypted_key, none).
   *
   * Returns the same signer shape onConnected gives, or null if restore isn't
   * possible (no persisted state, extension missing, user cancelled the
   * password prompt). On null, the host should fall back to MILL.open().
   *
   * @param {{ method: string, pubkey: string }} opts
   * @returns {Promise<object|null>}
   */
  async restore({ method, pubkey } = {}) {
    const m = RESTORE_METHOD_ALIASES[method] || method;
    switch (m) {
      case 'nip07':
        if (!window.nostr || typeof window.nostr.signEvent !== 'function') return null;
        try {
          const ext = await window.nostr.getPublicKey();
          if (pubkey && ext && ext.toLowerCase() !== pubkey.toLowerCase()) return null;
          return createNIP07Signer(pubkey || ext);
        } catch { return null; }

      case 'readonly':
        return pubkey ? createReadOnlySigner(pubkey) : null;

      case 'privatekey': {
        if (!loadEncryptedNsec() || !pubkey) return null;
        const el = _getOrCreateElement();
        return createPrivateKeySigner({
          pubkey,
          perms: loadSignPerms() || defaultPerms(),
          promptPassword: () => el.promptPassword({ subtitle: 'Enter your session password to unlock signing.' }),
          requestConsent: req => el.requestConsent({ ...req, npub: hexToNpub(pubkey) }),
        });
      }

      case 'nip46': {
        const st = loadBunkerState();
        if (!st || !st.clientSecretKey || !st.remotePubkey) return null;
        try {
          const client = new NIP46Client({
            relays: st.relays,
            clientSecretKey: hexToBytes(st.clientSecretKey),
          });
          await client.restore({ remotePubkey: st.remotePubkey, relays: st.relays, userPubkey: st.userPubkey });
          return createNIP46Signer(client, st.userPubkey || pubkey);
        } catch { return null; }
      }

      case 'nip55': {
        if (!pubkey) return null;
        const callbackUrl = _imperativeEl?.getAttribute?.('amber-callback') || null;
        const appName = _imperativeEl?.getAttribute?.('app-name') || document.title || 'Nostr App';
        return createNIP55Signer({ pubkey, callbackUrl, appName });
      }

      default:
        return null;
    }
  },

  /** Wipe all persisted restore state (call on logout). */
  clearRestoreState() {
    clearStoredNsec();
    clearSignPerms();
    clearBunkerState();
  },

  /** Apply a theme globally to the auto-created element. */
  setTheme(theme) {
    _getOrCreateElement().setTheme(theme);
  },

  /** Close the modal programmatically. */
  close() { _imperativeEl?.close(); },

  /**
   * Open the per-kind signing-permissions manager.
   *
   * Entirely optional — the consent card already links here, and mill is only
   * on screen when it's asking for something, so a host that never calls this
   * still gives users a way in. Wire it to a menu item if you want a direct
   * route. Private-key signing only; other methods manage approvals elsewhere.
   */
  openSettings() { _getOrCreateElement().openSettings(); },

  /** Expose theme utilities. */
  themes: THEMES,
  brandTheme,
  applyTheme,

  /** Install a returned signer as window.nostr (so existing nostr code works). */
  installAsWindowNostr,

  /** Low-level builders (advanced use). */
  signers: {
    createNIP07Signer, createNIP46Signer, createNIP55Signer,
    createPrivateKeySigner, createReadOnlySigner,
  },

  /** NIP-46 client class for advanced direct use. */
  NIP46Client,
};

// UMD/global export
if (typeof window !== 'undefined') window.MILL = MILL;

export default MILL;
// Named re-exports for ESM consumers; UMD/CJS consumers use MILL.* fields.
export { NostrSignerElement, THEMES, brandTheme, applyTheme };
