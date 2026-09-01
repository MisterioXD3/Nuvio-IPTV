'use strict';

const config = require('../config');
const { db, getRevision } = require('../db');
const playlists = require('../db/playlists');
const { LruCache } = require('../lib/lru');
const { normalizeName } = require('./m3u');

const responseCache = new LruCache({
  max: config.responseCacheMaxEntries,
  ttlMs: config.responseCacheTtlMs,
});

const TYPE_LABEL = { tv: 'TV', movie: 'Películas', series: 'Series' };

const selectByGroup = db.prepare(`
  SELECT uid, name, logo, group_name, type FROM items
  WHERE playlist_id = ? AND type = ? AND group_name = ?
  ORDER BY position LIMIT ? OFFSET ?
`);

const selectByType = db.prepare(`
  SELECT uid, name, logo, group_name, type FROM items
  WHERE playlist_id = ? AND type = ?
  ORDER BY position LIMIT ? OFFSET ?
`);

const selectSearch = db.prepare(`
  SELECT i.uid, i.name, i.logo, i.group_name, i.type FROM items_fts f
  JOIN items i ON i.id = f.item_id
  WHERE items_fts MATCH ? AND f.playlist_id = ? AND i.type = ?
  ORDER BY i.position LIMIT ? OFFSET ?
`);

const selectByUid = db.prepare(`
  SELECT i.*, p.name AS playlist_name, p.user_agent AS playlist_user_agent
  FROM items i JOIN playlists p ON p.id = i.playlist_id
  WHERE i.uid = ? LIMIT 1
`);

const selectSeriesByType = db.prepare(`
  SELECT uid, title, logo, group_name, episode_count, season_count FROM series
  WHERE playlist_id = ? ORDER BY position LIMIT ? OFFSET ?
`);

const selectSeriesByGroup = db.prepare(`
  SELECT uid, title, logo, group_name, episode_count, season_count FROM series
  WHERE playlist_id = ? AND group_name = ? ORDER BY position LIMIT ? OFFSET ?
`);

const selectSeriesSearch = db.prepare(`
  SELECT uid, title, logo, group_name, episode_count, season_count FROM series
  WHERE playlist_id = ? AND search_title LIKE ? ORDER BY position LIMIT ? OFFSET ?
`);

const selectSeriesByUid = db.prepare(`
  SELECT s.*, p.name AS playlist_name FROM series s
  JOIN playlists p ON p.id = s.playlist_id
  WHERE s.uid = ? LIMIT 1
`);

const selectEpisodes = db.prepare(`
  SELECT uid, name, season, episode, logo FROM items
  WHERE series_uid = ? ORDER BY season, episode, position
`);

const selectGroups = db.prepare(
  'SELECT name, item_count FROM groups WHERE playlist_id = ? AND type = ? ORDER BY name'
);

const selectTypes = db.prepare(
  'SELECT type, item_count, group_count FROM playlist_stats WHERE playlist_id = ? ORDER BY type'
);

const ftsQuery = (search) => {
  const terms = normalizeName(search)
    .split(' ')
    .filter(Boolean)
    .slice(0, 8)
    .map((term) => `"${term}"*`);
  return terms.length ? terms.join(' AND ') : null;
};

const catalogId = (playlistId, type) => `iptv-${playlistId}-${type}`;

const parseCatalogId = (id) => {
  const match = /^iptv-(\d+)-(tv|movie|series)$/.exec(id);
  return match ? { playlistId: Number(match[1]), type: match[2] } : null;
};

/**
 * Catalog descriptors for the manifest, ordered by the user-defined playlist
 * order so Nuvio renders the rows in the same sequence as the web UI.
 */
const describeCatalogs = () =>
  playlists.listEnabled().flatMap((playlist) =>
    selectTypes.all(playlist.id).map(({ type }) => ({
      id: catalogId(playlist.id, type),
      type,
      name: `${playlist.name} · ${TYPE_LABEL[type] || type}`,
      extra: [
        { name: 'genre', options: selectGroups.all(playlist.id, type).map((g) => g.name).slice(0, 1000), isRequired: false },
        { name: 'search', isRequired: false },
        { name: 'skip', isRequired: false },
      ],
    }))
  );

const toSeriesPreview = (row) => ({
  id: `iptv:${row.uid}`,
  type: 'series',
  name: row.title,
  poster: row.logo || undefined,
  posterShape: 'poster',
  logo: row.logo || undefined,
  genres: row.group_name ? [row.group_name] : undefined,
  description: `${row.episode_count} episodio(s) · ${row.season_count} temporada(s)`,
});

const toMetaPreview = (row) => ({
  id: `iptv:${row.uid}`,
  type: row.type,
  name: row.name,
  poster: row.logo || undefined,
  posterShape: row.type === 'tv' ? 'square' : 'poster',
  logo: row.logo || undefined,
  genres: row.group_name ? [row.group_name] : undefined,
});

const getCatalog = ({ id, type, genre, search, skip }) => {
  const parsed = parseCatalogId(id);
  if (!parsed || parsed.type !== type) return null;
  const playlist = playlists.get(parsed.playlistId);
  if (!playlist || !playlist.enabled) return null;

  const limit = config.catalogPageSize;
  const offset = Number.isFinite(skip) ? Math.max(0, skip) : 0;
  const cacheKey = `cat:${getRevision()}:${id}:${genre || ''}:${search || ''}:${offset}`;
  const cached = responseCache.get(cacheKey);
  if (cached) return cached;

  if (type === 'series') {
    let seriesRows;
    if (search) {
      const needle = `%${normalizeName(search)}%`;
      seriesRows = selectSeriesSearch.all(parsed.playlistId, needle, limit, offset);
    } else if (genre) {
      seriesRows = selectSeriesByGroup.all(parsed.playlistId, genre, limit, offset);
    } else {
      seriesRows = selectSeriesByType.all(parsed.playlistId, limit, offset);
    }
    return responseCache.set(cacheKey, { metas: seriesRows.map(toSeriesPreview) });
  }

  let rows;
  if (search) {
    const query = ftsQuery(search);
    rows = query ? selectSearch.all(query, parsed.playlistId, type, limit, offset) : [];
  } else if (genre) {
    rows = selectByGroup.all(parsed.playlistId, type, genre, limit, offset);
  } else {
    rows = selectByType.all(parsed.playlistId, type, limit, offset);
  }

  return responseCache.set(cacheKey, { metas: rows.map(toMetaPreview) });
};

const getMeta = (type, id) => {
  const uid = id.startsWith('iptv:') ? id.slice(5) : null;
  if (!uid) return null;
  const cacheKey = `meta:${getRevision()}:${uid}`;
  const cached = responseCache.get(cacheKey);
  if (cached) return cached;

  if (type === 'series') {
    const show = selectSeriesByUid.get(uid);
    if (show) {
      const episodes = selectEpisodes.all(uid);
      const meta = {
        meta: {
          id: `iptv:${show.uid}`,
          type: 'series',
          name: show.title,
          poster: show.logo || undefined,
          posterShape: 'poster',
          background: show.logo || undefined,
          logo: show.logo || undefined,
          genres: show.group_name ? [show.group_name] : undefined,
          description: `${show.group_name || ''}${show.group_name ? ' · ' : ''}${show.playlist_name}`,
          videos: episodes.map((row) => ({
            id: `iptv:${row.uid}`,
            title: episodeTitle(row, show.title),
            season: row.season || 1,
            episode: row.episode || 1,
            thumbnail: row.logo || show.logo || undefined,
            available: true,
          })),
        },
      };
      return responseCache.set(cacheKey, meta);
    }
  }

  const row = selectByUid.get(uid);
  if (!row || row.type !== type) return null;

  const meta = {
    meta: {
      id: `iptv:${row.uid}`,
      type: row.type,
      name: row.name,
      poster: row.logo || undefined,
      posterShape: row.type === 'tv' ? 'square' : 'poster',
      background: row.logo || undefined,
      logo: row.logo || undefined,
      genres: row.group_name ? [row.group_name] : undefined,
      description: `${row.group_name || ''}${row.group_name ? ' · ' : ''}${row.playlist_name}`,
    },
  };
  return responseCache.set(cacheKey, meta);
};

// Keeps the chapter name readable inside the show page: drops the repeated
// series title and falls back to "TxEE" when nothing is left.
const episodeTitle = (row, showTitle) => {
  const stripped = row.name.replace(showTitle, '').replace(/^[\s._-]+/, '').trim();
  return stripped || `T${row.season || 1} E${row.episode || 1}`;
};

const getStreams = (type, id) => {
  const uid = id.startsWith('iptv:') ? id.slice(5) : null;
  if (!uid) return null;
  const cacheKey = `stream:${getRevision()}:${uid}`;
  const cached = responseCache.get(cacheKey);
  if (cached) return cached;

  const row = selectByUid.get(uid);
  if (!row || row.type !== type) return null;

  const attrs = row.attrs ? JSON.parse(row.attrs) : {};
  const userAgent = attrs['http-user-agent'] || row.playlist_user_agent || config.defaultUserAgent;
  const payload = {
    streams: [
      {
        name: row.playlist_name,
        title: row.group_name ? `${row.name}\n${row.group_name}` : row.name,
        url: row.url,
        behaviorHints: {
          notWebReady: true,
          proxyHeaders: { request: { 'User-Agent': userAgent } },
        },
      },
    ],
  };
  return responseCache.set(cacheKey, payload);
};

const groupsFor = (playlistId, type) => selectGroups.all(playlistId, type);
const typesFor = (playlistId) => selectTypes.all(playlistId);

const clearCache = () => responseCache.clear();
const cacheStats = () => responseCache.stats();

module.exports = {
  describeCatalogs,
  getCatalog,
  getMeta,
  getStreams,
  groupsFor,
  typesFor,
  clearCache,
  cacheStats,
  catalogId,
};
