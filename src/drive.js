/**
 * MILL — drive.js
 * Google Drive appDataFolder access for cloud-backed keys.
 *
 * Raw Drive REST v3 over fetch — no SDK, keeping mill dependency-free. The
 * appDataFolder is a per-application hidden space: the user can see that an
 * app stores data and can delete it, but cannot browse it, and other apps
 * cannot see it at all.
 *
 * `drive.appdata` is classified NON-SENSITIVE by Google, so it needs no
 * security assessment, no audit and no verification video — the one Drive
 * scope that avoids all of it.
 */

export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';

const API    = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';

// Opaque filenames, stolen from wisp's design. If backups were named by npub,
// anyone with access to the Drive account could map a Google identity to a
// Nostr identity without ever decrypting anything. The npub is recoverable
// only by decrypting the contents.
const PREFIX = 'mill_bk_';
const SUFFIX = '.bin';

export class DriveAuthError extends Error {
  constructor(msg = 'Drive authorization expired') { super(msg); this.name = 'DriveAuthError'; }
}

function newBackupName() {
  const uuid = (crypto.randomUUID?.() || Math.random().toString(36).slice(2) + Date.now().toString(36));
  return `${PREFIX}${uuid}${SUFFIX}`;
}

async function driveFetch(url, token, init = {}) {
  const res = await fetch(url, {
    ...init,
    headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` },
  });
  // 401 means the access token lapsed. Surface it as a distinct type so the
  // caller can silently re-request a token and retry exactly once, rather than
  // showing the user an error for something we can fix.
  if (res.status === 401) throw new DriveAuthError();
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Drive ${res.status}: ${body.slice(0, 200)}`);
  }
  return res;
}

/** List mill backup files in the app data folder, newest first. */
export async function listBackups(token) {
  const params = new URLSearchParams({
    spaces: 'appDataFolder',
    fields: 'files(id,name,modifiedTime,size)',
    orderBy: 'modifiedTime desc',
    pageSize: '100',
    q: `name contains '${PREFIX}' and trashed = false`,
  });
  const res = await driveFetch(`${API}/files?${params}`, token);
  const data = await res.json();
  return (data.files || []).filter(f => f.name?.startsWith(PREFIX));
}

/** Fetch one backup's contents as text (the NIP-44 blob). */
export async function downloadBackup(token, fileId) {
  const res = await driveFetch(`${API}/files/${encodeURIComponent(fileId)}?alt=media`, token);
  return res.text();
}

/**
 * Write a new backup. Always creates a fresh file rather than updating in
 * place — wisp does the same, to sidestep the delete-then-upload race where a
 * failure between the two steps leaves the user with no backup at all. Callers
 * that are replacing a key should upload first, verify, then delete the old id.
 */
export async function uploadBackup(token, content) {
  const boundary = `mill${Math.random().toString(36).slice(2)}`;
  const metadata = { name: newBackupName(), parents: ['appDataFolder'] };
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n` +
    `${content}\r\n` +
    `--${boundary}--`;

  const res = await driveFetch(`${UPLOAD}/files?uploadType=multipart&fields=id,name`, token, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
  });
  return res.json();
}

export async function deleteBackup(token, fileId) {
  await driveFetch(`${API}/files/${encodeURIComponent(fileId)}`, token, { method: 'DELETE' });
}

/**
 * Run a Drive operation, refreshing the token once if it has expired.
 * `getToken(forceRefresh)` should return a valid access token.
 */
export async function withAuth(getToken, fn) {
  let token = await getToken(false);
  try {
    return await fn(token);
  } catch (e) {
    if (!(e instanceof DriveAuthError)) throw e;
    token = await getToken(true);
    return fn(token);
  }
}
