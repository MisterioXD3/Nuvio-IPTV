'use strict';

const crypto = require('crypto');
const { Readable } = require('stream');

const config = require('../config');
const { db, bumpRevision } = require('../db');
const playlists = require('../db/playlists');
const { parseM3u } = require('./m3u');
const xtream = require('./xtream');

const BATCH_SIZE = 5000;

/**
 * Stable identifier that survives re-syncs, so entries saved in Nuvio keep
 * resolving after the playlist is refreshed and row ids change.
 */
const itemUid = (playlistId, item) =>
  crypto
    .createHash('sha1')
    .update(`${playlistId}|${item.extId || ''}|${item.url}`)
    .digest('base64url')
    .slice(0, 16);

const insertStaging = db.prepare(`
  INSERT INTO staging_items (playlist_id, uid, type, ext_id, name, search_name, group_name, logo, url, position, attrs)
  VALUES (@playlist_id, @uid, @type, @ext_id, @name, @search_name, @group_name, @logo, @url, @position, @attrs)
`);

const insertBatch = db.transaction((rows) => {
  for (const row of rows) insertStaging.run(row);
});

const swapPlaylistItems = db.transaction((playlistId) => {
  db.prepare('DELETE FROM items WHERE playlist_id = ?').run(playlistId);
  db.prepare(
    `INSERT INTO items (playlist_id, uid, type, ext_id, name, search_name, group_name, logo, url, position, attrs)
     SELECT playlist_id, uid, type, ext_id, name, search_name, group_name, logo, url, position, attrs
     FROM staging_items WHERE playlist_id = ?`
  ).run(playlistId);
  db.prepare('DELETE FROM staging_items WHERE playlist_id = ?').run(playlistId);

  db.prepare('DELETE FROM items_fts WHERE playlist_id = ?').run(playlistId);
  db.prepare(
    `INSERT INTO items_fts (text, playlist_id, item_id)
     SELECT search_name || ' ' || COALESCE(group_name, ''), playlist_id, id
     FROM items WHERE playlist_id = ?`
  ).run(playlistId);

  db.prepare('DELETE FROM groups WHERE playlist_id = ?').run(playlistId);
  db.prepare(
    `INSERT INTO groups (playlist_id, type, name, item_count)
     SELECT playlist_id, type, COALESCE(group_name, 'Sin grupo'), COUNT(*)
     FROM items WHERE playlist_id = ? GROUP BY playlist_id, type, group_name`
  ).run(playlistId);

  db.prepare('DELETE FROM playlist_stats WHERE playlist_id = ?').run(playlistId);
  db.prepare(
    `INSERT INTO playlist_stats (playlist_id, type, item_count, group_count)
     SELECT i.playlist_id, i.type, COUNT(*), COUNT(DISTINCT i.group_name)
     FROM items i WHERE i.playlist_id = ? GROUP BY i.playlist_id, i.type`
  ).run(playlistId);
});

const markSync = (playlistId, patch) => {
  db.prepare(
    `UPDATE playlists SET
       last_sync_at = COALESCE(@last_sync_at, last_sync_at),
       last_sync_status = @status,
       last_sync_error = @error,
       last_sync_duration_ms = @duration,
       http_etag = COALESCE(@etag, http_etag),
       http_last_modified = COALESCE(@last_modified, http_last_modified),
       content_hash = COALESCE(@content_hash, content_hash),
       bytes_downloaded = COALESCE(@bytes, bytes_downloaded),
       expires_at = COALESCE(@expires_at, expires_at),
       updated_at = datetime('now')
     WHERE id = @id`
  ).run({
    id: playlistId,
    last_sync_at: patch.lastSyncAt || null,
    status: patch.status,
    error: patch.error || null,
    duration: patch.durationMs || null,
    etag: patch.etag || null,
    last_modified: patch.lastModified || null,
    content_hash: patch.contentHash || null,
    bytes: patch.bytes != null ? patch.bytes : null,
    expires_at: patch.expiresAt || null,
  });
};

const running = new Map();

const runSync = async (playlistId, { force = false } = {}) => {
  const playlist = playlists.get(playlistId);
  if (!playlist) throw new Error(`Lista ${playlistId} no encontrada`);

  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.syncTimeoutMs);
  const userAgent = playlist.user_agent || config.defaultUserAgent;

  try {
    let expiresAt = null;
    if (playlist.kind === 'xtream') {
      try {
        const info = await xtream.fetchAccountInfo(playlist, { signal: controller.signal, userAgent });
        if (info && info.expiresAt) expiresAt = info.expiresAt;
      } catch {
        // Account info is best-effort; a failure here must not abort the sync.
      }
    }

    const url = playlist.kind === 'xtream' ? xtream.playlistUrl(playlist) : playlist.url;
    const headers = { 'user-agent': userAgent, accept: '*/*' };
    if (!force && playlist.http_etag) headers['if-none-match'] = playlist.http_etag;
    if (!force && playlist.http_last_modified) headers['if-modified-since'] = playlist.http_last_modified;

    const response = await fetch(url, { headers, signal: controller.signal, redirect: 'follow' });

    if (response.status === 304) {
      markSync(playlistId, {
        status: 'unchanged',
        lastSyncAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt,
        expiresAt,
      });
      return { status: 'unchanged', items: 0, durationMs: Date.now() - startedAt };
    }
    if (!response.ok) throw new Error(`HTTP ${response.status} al descargar la lista`);
    if (!response.body) throw new Error('Respuesta sin cuerpo');

    db.prepare('DELETE FROM staging_items WHERE playlist_id = ?').run(playlistId);

    const hash = crypto.createHash('sha1');
    let bytes = 0;
    const source = (async function* stream() {
      for await (const chunk of Readable.fromWeb(response.body)) {
        bytes += chunk.length;
        hash.update(chunk);
        yield chunk;
      }
    })();

    let count = 0;
    let batch = [];
    for await (const item of parseM3u(source)) {
      batch.push({
        playlist_id: playlistId,
        uid: itemUid(playlistId, item),
        type: item.type,
        ext_id: item.extId,
        name: item.name,
        search_name: item.searchName,
        group_name: item.group,
        logo: item.logo,
        url: item.url,
        position: item.position,
        attrs: item.attrs && Object.keys(item.attrs).length ? JSON.stringify(item.attrs) : null,
      });
      count += 1;
      if (batch.length >= BATCH_SIZE) {
        insertBatch(batch);
        batch = [];
      }
    }
    if (batch.length) insertBatch(batch);

    const contentHash = hash.digest('hex');
    if (!count) throw new Error('La lista no contiene entradas reproducibles');

    if (!force && contentHash === playlist.content_hash) {
      db.prepare('DELETE FROM staging_items WHERE playlist_id = ?').run(playlistId);
      markSync(playlistId, {
        status: 'unchanged',
        lastSyncAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt,
        bytes,
        expiresAt,
      });
      return { status: 'unchanged', items: count, durationMs: Date.now() - startedAt };
    }

    swapPlaylistItems(playlistId);
    markSync(playlistId, {
      status: 'ok',
      lastSyncAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      etag: response.headers.get('etag'),
      lastModified: response.headers.get('last-modified'),
      contentHash,
      bytes,
      expiresAt,
    });
    bumpRevision();
    return { status: 'ok', items: count, durationMs: Date.now() - startedAt };
  } catch (error) {
    db.prepare('DELETE FROM staging_items WHERE playlist_id = ?').run(playlistId);
    markSync(playlistId, {
      status: 'error',
      error: error.message,
      durationMs: Date.now() - startedAt,
    });
    throw error;
  } finally {
    clearTimeout(timeout);
  }
};

/** Deduplicates concurrent sync requests for the same playlist. */
const syncPlaylist = (playlistId, options) => {
  const key = String(playlistId);
  if (running.has(key)) return running.get(key);
  const promise = runSync(playlistId, options).finally(() => running.delete(key));
  running.set(key, promise);
  return promise;
};

const isSyncing = (playlistId) => running.has(String(playlistId));

module.exports = { syncPlaylist, isSyncing };
