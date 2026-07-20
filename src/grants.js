/**
 * MILL — grants.js
 * Per-kind signing grants for the private-key signer.
 *
 * Model follows Amber's, which splits the decision into two orthogonal axes:
 *   what     — allow | deny | ask
 *   how long — this time only | 5m | 1h | this session | always
 *
 * A grant is keyed by event kind, not by category. Amber keys on
 * (app, type, kind) with an explicit note that this prevents "kind-A rejects
 * leaking to kind-B requests"; mill lives inside a single app, so the app axis
 * collapses and the key is just the kind.
 *
 * Deny carries its own expiry so "reject this for an hour" is expressible —
 * that's why Amber's schema has both acceptUntil and rejectUntil.
 *
 * Storage split matters:
 *   - 'always' grants → localStorage, outliving the tab.
 *   - everything else → sessionStorage, dying with the tab AND with the
 *     encrypted key blob, which also lives in sessionStorage. A grant that
 *     outlived the key it authorises would be meaningless.
 */

const SESSION_KEY = 'mill:grants:session';
const ALWAYS_KEY  = 'mill:grants:always';

export const FOREVER = 8640000000000000;   // max safe Date value

// Duration options for the consent card. `ms: null` means "don't remember" —
// deliberately first and default, so the safe choice is the no-op and
// persistence is always an active opt-in (Amber defaults its picker to Never).
export const DURATIONS = [
  { id: 'once',    label: 'Just this time', ms: null },
  { id: '5m',      label: '5 minutes',      ms: 5 * 60 * 1000 },
  { id: '1h',      label: '1 hour',         ms: 60 * 60 * 1000 },
  { id: 'session', label: 'This session',   ms: FOREVER },   // sessionStorage bounds it
  { id: 'always',  label: 'Always',         ms: FOREVER },   // localStorage: survives reload
];

export function durationById(id) { return DURATIONS.find(d => d.id === id) || DURATIONS[0]; }

function read(store, key) {
  try {
    const raw = store.getItem(key);
    const val = raw ? JSON.parse(raw) : null;
    return val && typeof val === 'object' ? val : {};
  } catch { return {}; }
}

function write(store, key, table) {
  try { store.setItem(key, JSON.stringify(table)); } catch {}
}

/**
 * Resolve the effective grant for a kind.
 * Returns 'allow' | 'deny' | null, where null means "ask the user".
 *
 * Expiry is checked at read time rather than trusted to a sweep — a stale row
 * must never authorise a signature just because cleanup hasn't run yet.
 */
export function grantFor(kind, now = Date.now()) {
  const k = String(kind);
  // Persistent grants are checked first: an explicit "always" outranks a
  // leftover time-boxed row for the same kind.
  for (const [store, key] of [[safeLocal(), ALWAYS_KEY], [safeSession(), SESSION_KEY]]) {
    if (!store) continue;
    const row = read(store, key)[k];
    if (!row) continue;
    if (typeof row.until === 'number' && row.until > now) {
      return row.action === 'deny' ? 'deny' : 'allow';
    }
  }
  return null;
}

/**
 * Record a decision. `durationId` of 'once' stores nothing — the decision
 * applies to the in-flight request only.
 */
export function saveGrant(kind, action, durationId, now = Date.now()) {
  const dur = durationById(durationId);
  if (dur.ms === null) return;                       // "just this time" — don't persist

  const persistent = dur.id === 'always';
  const store = persistent ? safeLocal() : safeSession();
  if (!store) return;
  const key   = persistent ? ALWAYS_KEY : SESSION_KEY;
  const table = read(store, key);
  table[String(kind)] = {
    action: action === 'deny' ? 'deny' : 'allow',
    until:  dur.ms === FOREVER ? FOREVER : now + dur.ms,
    dur:    dur.id,
  };
  write(store, key, table);
}

/**
 * Every live grant, for the management screen.
 *
 * Deduped by kind: a kind can hold a row in both stores, and grantFor()
 * resolves that by letting the persistent one win. This must agree, or the
 * screen would list a kind twice and offer to revoke a row that isn't the one
 * actually in force.
 */
export function listGrants(now = Date.now()) {
  const seen = new Map();
  for (const [store, key, scope] of [[safeLocal(), ALWAYS_KEY, 'always'], [safeSession(), SESSION_KEY, 'session']]) {
    if (!store) continue;
    const table = read(store, key);
    for (const [kind, row] of Object.entries(table)) {
      if (typeof row?.until !== 'number' || row.until <= now) continue;
      if (seen.has(kind)) continue;                  // persistent store wins
      seen.set(kind, { kind: Number(kind), action: row.action, until: row.until, dur: row.dur, scope });
    }
  }
  return [...seen.values()].sort((a, b) => a.kind - b.kind);
}

/** Drop a single kind's grant from both stores. Returns it to "ask". */
export function revokeGrant(kind) {
  const k = String(kind);
  for (const [store, key] of [[safeLocal(), ALWAYS_KEY], [safeSession(), SESSION_KEY]]) {
    if (!store) continue;
    const table = read(store, key);
    if (k in table) { delete table[k]; write(store, key, table); }
  }
}

export function revokeAllGrants() {
  try { safeLocal()?.removeItem(ALWAYS_KEY); } catch {}
  try { safeSession()?.removeItem(SESSION_KEY); } catch {}
}

/**
 * Drop expired rows. Purely housekeeping so the stores don't grow without
 * bound — grantFor() already refuses expired rows, so correctness does not
 * depend on this running.
 */
export function sweepExpiredGrants(now = Date.now()) {
  for (const [store, key] of [[safeLocal(), ALWAYS_KEY], [safeSession(), SESSION_KEY]]) {
    if (!store) continue;
    const table = read(store, key);
    let dirty = false;
    for (const [kind, row] of Object.entries(table)) {
      if (typeof row?.until !== 'number' || row.until <= now) { delete table[kind]; dirty = true; }
    }
    if (dirty) write(store, key, table);
  }
}

// Storage can throw outright in some privacy modes / sandboxed iframes.
function safeSession() { try { return window.sessionStorage; } catch { return null; } }
function safeLocal()   { try { return window.localStorage;   } catch { return null; } }
