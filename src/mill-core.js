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
  google:     { label: 'Google',            icon: '🔵',  color: 'var(--mill-accent)'  },
};

const METHODS_LIST = [
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
  const b = h('button', { class: `mill-btn ${variant}`, onClick }, label);
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

  const hdr = h('div', { style: { marginBottom: '22px' } });
  const logo = h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '6px' } },
    h('div', { style: { width: '32px', height: '32px', borderRadius: '8px', background: 'var(--mill-accent-dim)', border: '1px solid var(--mill-border-light)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '16px' } }, '⚡'),
    h('span', { style: { fontSize: '12px', textTransform: 'uppercase', letterSpacing: '0.12em', color: 'var(--mill-muted)', fontWeight: '600' } }, 'Nostr Signer')
  );
  hdr.appendChild(logo);
  hdr.appendChild(h('div', { style: { fontSize: '22px', fontWeight: '700', marginBottom: '5px' } }, 'Connect Your Account'));
  hdr.appendChild(h('div', { style: { fontSize: '13px', color: 'var(--mill-text-secondary)', lineHeight: '1.55' } },
    'Choose how to access this Nostr client. Each method has different security tradeoffs.'
  ));
  wrap.appendChild(hdr);

  // methodFilter accepts:
  //   undefined / [] → show all defaults (newkey appears as a separated callout above sign-in methods)
  //   ['nip07', 'nip46']           → only these, in this order; newkey is treated as just another card
  //   [{ id: 'nip07', label: 'My Ext', icon: '⚡' }, ...]  → override built-in fields
  const explicit = Array.isArray(methodFilter) && methodFilter.length;
  const resolved = explicit
    ? methodFilter.map(entry => {
        const id = typeof entry === 'string' ? entry : entry?.id;
        const base = METHODS_LIST.find(m => m.id === id);
        if (!base) return null;
        return typeof entry === 'object' ? { ...base, ...entry } : base;
      }).filter(Boolean)
    : METHODS_LIST.filter(m => !DEFAULT_HIDDEN_METHODS.has(m.id));

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
    const googleAvailable = !!host?.getAttribute?.('oauth-shim');
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
    callout.appendChild(h('div', { class: 'mill-method-icon', style: { width: '32px', height: '32px', fontSize: '17px' } }, calloutEntry.icon));
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
    }, m.icon);
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

  const tip = h('p', { style: { marginTop: '16px', fontSize: '11.5px', color: 'var(--mill-muted)', textAlign: 'center', lineHeight: '1.6' } });
  tip.innerHTML = 'Not sure? <span style="color:var(--mill-accent);cursor:pointer">NIP-07 browser extension</span> is recommended.';
  wrap.appendChild(tip);

  return wrap;
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
      debug: true,                 // always console.log — it's a debug-friendly default for v0.1.x betas
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
    card.appendChild(h('div', { class: 'mill-method-icon', style: { width: '34px', height: '34px', fontSize: '18px' } }, icon));
    const txt = h('div', { style: { flex: '1', minWidth: '0' } });
    txt.appendChild(h('div', { style: { fontSize: '14px', fontWeight: '600', color: primary ? 'var(--mill-accent)' : 'var(--mill-text)' } }, title));
    txt.appendChild(h('div', { style: { fontSize: '12px', color: 'var(--mill-text-secondary)', marginTop: '2px', lineHeight: '1.45' } }, sub));
    card.appendChild(txt);
    card.appendChild(h('span', { class: 'mill-arrow', style: primary ? { color: 'var(--mill-accent)' } : {} }, '→'));
    return card;
  };

  body.appendChild(option('🔵', 'Continue with Google',
    'Easiest. Your key is created and safely stored for you — nothing to write down.',
    true, () => onSelect('google')));
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
  let token = null;               // { accessToken, ... }
  let backups = [];              // Drive file list
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
      // Try each backup with the PIN; the first that decrypts is the account.
      // (Multi-account chooser is a later refinement — one identity is the norm.)
      for (const f of backups) {
        try {
          const blob = await withAuth(getToken, t => downloadBackup(t, f.id));
          const privHex = await decryptCloudBlob(blob, pin);
          const pubHex = getPublicKey(hexToBytes(privHex));
          await finish(privHex, hexToNpub(pubHex), pubHex);
          return;
        } catch { /* wrong PIN or unrelated file — try the next */ }
      }
      errMsg = 'That PIN did not unlock your account. Try again.';
      step = 'unlock'; render();
    } catch (e) {
      errMsg = e.message || 'Something went wrong.';
      step = 'unlock'; render();
    }
  }

  async function createAndUpload(render) {
    step = 'working'; errMsg = ''; render();
    try {
      const keys = await generateKeypair();
      const blob = await encryptCloudBlob(keys.privHex, pin);
      // Upload BEFORE trusting it locally — wisp's ordering, so a failed upload
      // never leaves a key that exists only on this device.
      await withAuth(getToken, t => uploadBackup(t, blob));
      await finish(keys.privHex, keys.npub, keys.pubHex);
    } catch (e) {
      errMsg = e.message || 'Could not save your account to Google.';
      step = 'setup'; render();
    }
  }

  function pinField(label, val, onInput) {
    // inputmode numeric + pattern so phones show a number pad; 4 digits like a
    // phone passcode, per the product decision.
    const { wrap } = field(label, '• • • •', val, onInput, { type: 'password', inputmode: 'numeric', maxlength: '4' });
    return wrap;
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
      body.appendChild(badge('info', '🔒', 'How this works', 'A new Nostr key is created for you (or your existing one is restored). It is encrypted with a PIN and saved to a private folder in your Google Drive that only this sign-in can read.'));
      if (errMsg) body.appendChild(h('div', { class: 'mill-error' }, errMsg));
      footer.appendChild(btn('Back', 'ghost', onBack));
      footer.appendChild(btn('Continue with Google', 'primary', () => connect(render)));
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
      const okBtn = btn('Unlock', 'primary', () => { if (/^\d{4}$/.test(pin)) unlock(render); }, !/^\d{4}$/.test(pin));
      const { wrap, body, footer } = flowWrap({ step: 2, total: 3, title: 'Enter your PIN', subtitle: 'Welcome back. Enter the PIN you set to unlock your account.', onBack: () => { step = 'idle'; pin = ''; render(); } });
      const f = pinField('PIN', pin, v => { pin = v.replace(/\D/g, '').slice(0, 4); okBtn.disabled = !/^\d{4}$/.test(pin); });
      body.appendChild(f);
      if (errMsg) body.appendChild(h('div', { class: 'mill-error' }, errMsg));
      const inp = f.querySelector('input'); if (inp) inp.addEventListener('keydown', e => { if (e.key === 'Enter' && /^\d{4}$/.test(pin)) unlock(render); });
      footer.appendChild(btn('Back', 'ghost', () => { step = 'idle'; pin = ''; render(); }));
      footer.appendChild(okBtn);
      container.appendChild(wrap);

    } else if (step === 'setup') {
      const ok = () => /^\d{4}$/.test(pin) && pin === pin2;
      const okBtn = btn('Create Account', 'primary', () => { if (ok()) createAndUpload(render); }, !ok());
      const { wrap, body, footer } = flowWrap({ step: 2, total: 3, title: 'Choose a PIN', subtitle: 'Pick a 4-digit PIN. You will use it to unlock your account on other devices.', onBack: () => { step = 'idle'; pin = ''; pin2 = ''; render(); } });
      const err = h('div', { class: 'mill-error' });
      const sync = () => { okBtn.disabled = !ok(); err.textContent = (pin2 && pin !== pin2) ? 'PINs do not match' : ''; };
      body.appendChild(pinField('PIN', pin, v => { pin = v.replace(/\D/g, '').slice(0, 4); sync(); }));
      body.appendChild(pinField('Confirm PIN', pin2, v => { pin2 = v.replace(/\D/g, '').slice(0, 4); sync(); }));
      body.appendChild(err);
      // Honest about what the PIN does and does not do — no security theatre.
      body.appendChild(badge('muted', 'ℹ️', 'About your PIN', 'The PIN stops someone casually opening your account. Your real protection is your Google account and its security — keep that locked down. If you forget the PIN, you can still recover using an exported key, if you saved one.'));
      if (errMsg) body.appendChild(h('div', { class: 'mill-error' }, errMsg));
      footer.appendChild(btn('Back', 'ghost', () => { step = 'idle'; pin = ''; pin2 = ''; render(); }));
      footer.appendChild(okBtn);
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
  const avatar = h('div', { class: 'mill-connected-avatar' }, m.icon);
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
      const f = field(label, isCloud ? '• • • •' : 'Your password', pw, v => { pw = v; errMsg = ''; },
        { type: 'password', error: errMsg, inputmode: isCloud ? 'numeric' : undefined, maxlength: isCloud ? 4 : undefined });
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

    // Header
    const header = h('div', { class: 'mill-header' },
      h('div', { style: { display: 'flex', alignItems: 'center' } },
        h('span', { class: 'mill-header-dot' }),
        h('span', { class: 'mill-header-label' }, 'Account Access')
      ),
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
    if (opts.oauthShim) el.setAttribute('oauth-shim', opts.oauthShim);
    el.open(opts);
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
