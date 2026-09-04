'use strict';

const crypto = require('crypto');
const { Readable } = require('stream');

const config = require('../config');
const { db, bumpRevision } = require('../db');
const playlists = require('../db/playlists');
const { parseM3u } = require('./m3u');
const xtream = require('./xtream');
const { enrichPlaylist } = require('./tmdb');

const BATCH_SIZE = 5000;
const RETRYABLE_STATUS = new Set([403, 408, 425, 429, 500, 502, 503, 504]);

const retryDelay = (attempt, response) => {
  const retryAfter = Number(response?.headers?.get('retry-after'));
  if (Number.isFinite(retryAfter) && retryAfter >= 0) return Math.min(retryAfter * 1000, 30000);
  return Math.min(config.syncRetryBaseMs * (2 ** attempt), 30000);
};

const fetchPlaylist = async (url, options) => {
  let lastError;
  const userAgents = options.userAgents?.length ? options.userAgents : [config.defaultUserAgent];
  for (let attempt = 0; attempt <= config.syncRetries; attempt += 1) {
    try {
      const headers = { ...options.headers, 'user-agent': userAgents[attempt % userAgents.length] };
      const response = await fetch(url, { ...options, headers });
      if (response.ok || response.status === 304 || !RETRYABLE_STATUS.has(response.status) || attempt === config.syncRetries) return response;
      response.body?.cancel();
      await new Promise((resolve) => setTimeout(resolve, retryDelay(attempt, response)));
    } catch (error) {
      lastError = error;
      if (options.signal?.aborted || attempt === config.syncRetries) throw error;
      await new Promise((resolve) => setTimeout(resolve, retryDelay(attempt)));
    }
  }
  throw lastError || new Error('No se pudo descargar la lista');
};

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

const seriesUid = (playlistId, key) =>
  crypto.createHash('sha1').update(`s|${playlistId}|${key}`).digest('base64url').slice(0, 16);

const insertStaging = db.prepare(`
  INSERT INTO staging_items (playlist_id, uid, type, ext_id, name, search_name, group_name, logo, url, position, attrs,
    series_uid, series_key, series_title, series_search, season, episode)
  VALUES (@playlist_id, @uid, @type, @ext_id, @name, @search_name, @group_name, @logo, @url, @position, @attrs,
    @series_uid, @series_key, @series_title, @series_search, @season, @episode)
`);

const insertBatch = db.transaction((rows) => {
  for (const row of rows) insertStaging.run(row);
});

const swapPlaylistItems = db.transaction((playlistId) => {
  db.prepare('DELETE FROM items WHERE playlist_id = ?').run(playlistId);
  db.prepare(
    `INSERT INTO items (playlist_id, uid, type, ext_id, name, search_name, group_name, logo, url, position, attrs,
       series_uid, series_key, series_title, series_search, season, episode)
     SELECT playlist_id, uid, type, ext_id, name, search_name, group_name, logo, url, position, attrs,
       series_uid, series_key, series_title, series_search, season, episode
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

  db.prepare('DELETE FROM series WHERE playlist_id = ?').run(playlistId);
  db.prepare(
    `INSERT INTO series (playlist_id, uid, series_key, title, search_title, group_name, logo, episode_count, season_count, position)
     SELECT playlist_id, series_uid, series_key, MIN(series_title), MIN(series_search), MIN(group_name),
            MIN(logo), COUNT(*), COUNT(DISTINCT season), MIN(position)
     FROM items WHERE playlist_id = ? AND type = 'series' AND series_uid IS NOT NULL
     GROUP BY playlist_id, series_uid, series_key`
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

    const urls = playlist.kind === 'xtream' ? xtream.playlistUrls(playlist) : [playlist.url];
    const headers = { 'user-agent': userAgent, accept: '*/*', 'accept-encoding': 'gzip, deflate, br' };
    if (!force && playlist.http_etag) headers['if-none-match'] = playlist.http_etag;
    if (!force && playlist.http_last_modified) headers['if-modified-since'] = playlist.http_last_modified;

    let response = null;
    let lastFetchError = null;
    for (const candidateUrl of urls) {
      try {
        const candidateResponse = await fetchPlaylist(candidateUrl, {
          headers: { ...headers, referer: playlist.url },
          signal: controller.signal,
          redirect: 'follow',
          userAgents: config.syncUserAgents,
        });
        if (candidateResponse.ok || candidateResponse.status === 304) {
          response = candidateResponse;
          break;
        }
        lastFetchError = new Error(`HTTP ${candidateResponse.status} al descargar la lista`);
        candidateResponse.body?.cancel();
      } catch (error) {
        lastFetchError = error;
        if (controller.signal.aborted) throw error;
      }
    }
    if (!response) throw lastFetchError || new Error('No se pudo descargar la lista');

    if (response.status === 304) {
      markSync(playlistId, {
        status: 'unchanged',
        lastSyncAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt,
        expiresAt,
      });
      enrichPlaylist(playlistId).catch((error) => console.warn(`[nuvio-iptv] enriquecimiento TMDb fallido: ${error.message}`));
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
        series_uid: item.series ? seriesUid(playlistId, item.series.key) : null,
        series_key: item.series ? item.series.key : null,
        series_title: item.series ? item.series.title : null,
        series_search: item.series ? item.series.searchTitle : null,
        season: item.series ? item.series.season : null,
        episode: item.series ? item.series.episode : null,
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
      enrichPlaylist(playlistId).catch((error) => console.warn(`[nuvio-iptv] enriquecimiento TMDb fallido: ${error.message}`));
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
    enrichPlaylist(playlistId).catch((error) => console.warn(`[nuvio-iptv] enriquecimiento TMDb fallido: ${error.message}`));
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
