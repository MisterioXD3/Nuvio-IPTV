'use strict';

const config = require('../config');
const { db, getRevision } = require('../db');
const playlists = require('../db/playlists');
const { LruCache } = require('../lib/lru');
const { normalizeName } = require('./m3u');
const { getProfileCredentials, resolveTitle, getDetailsById, getDetailsByImdbId, collectTitles, detailsToMeta } = require('./tmdb');

const responseCache = new LruCache({
  max: config.responseCacheMaxEntries,
  ttlMs: config.responseCacheTtlMs,
});

const TYPE_LABEL = { tv: 'TV', movie: 'Películas', series: 'Series' };

const selectByGroup = db.prepare(`
  SELECT uid, name, logo, group_name, type, tmdb_id, tmdb_type, tmdb_title, tmdb_original_title, tmdb_titles, tmdb_poster, tmdb_backdrop, tmdb_overview, tmdb_year, tmdb_rating, tmdb_genres FROM items
  WHERE playlist_id = ? AND type = ? AND group_name = ?
  ORDER BY position LIMIT ? OFFSET ?
`);

const selectByType = db.prepare(`
  SELECT uid, name, logo, group_name, type, tmdb_id, tmdb_type, tmdb_title, tmdb_original_title, tmdb_titles, tmdb_poster, tmdb_backdrop, tmdb_overview, tmdb_year, tmdb_rating, tmdb_genres FROM items
  WHERE playlist_id = ? AND type = ?
  ORDER BY position LIMIT ? OFFSET ?
`);

const selectSearch = db.prepare(`
  SELECT i.uid, i.name, i.logo, i.group_name, i.type, i.tmdb_id, i.tmdb_type, i.tmdb_title, i.tmdb_original_title, i.tmdb_titles, i.tmdb_poster, i.tmdb_backdrop, i.tmdb_overview, i.tmdb_year, i.tmdb_rating, i.tmdb_genres FROM items_fts f
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
  SELECT uid, title, logo, group_name, episode_count, season_count, tmdb_id, tmdb_type, tmdb_title, tmdb_original_title, tmdb_titles, tmdb_poster, tmdb_backdrop, tmdb_overview, tmdb_year, tmdb_rating, tmdb_genres FROM series
  WHERE playlist_id = ? ORDER BY position LIMIT ? OFFSET ?
`);

const selectSeriesByGroup = db.prepare(`
  SELECT uid, title, logo, group_name, episode_count, season_count, tmdb_id, tmdb_type, tmdb_title, tmdb_original_title, tmdb_titles, tmdb_poster, tmdb_backdrop, tmdb_overview, tmdb_year, tmdb_rating, tmdb_genres FROM series
  WHERE playlist_id = ? AND group_name = ? ORDER BY position LIMIT ? OFFSET ?
`);

const selectSeriesSearch = db.prepare(`
  SELECT uid, title, logo, group_name, episode_count, season_count, tmdb_id, tmdb_type, tmdb_title, tmdb_original_title, tmdb_titles, tmdb_poster, tmdb_backdrop, tmdb_overview, tmdb_year, tmdb_rating, tmdb_genres FROM series
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

const externalId = (row) => row.tmdb_id ? `tmdb:${row.tmdb_id}` : `iptv:${row.uid}`;
const toSeriesPreview = (row) => ({
  id: externalId(row),
  type: 'series',
  name: row.tmdb_title || row.title,
  poster: row.tmdb_poster || row.logo || undefined,
  posterShape: 'poster',
  background: row.tmdb_backdrop || undefined,
  logo: row.tmdb_poster || row.logo || undefined,
  genres: row.group_name ? [row.group_name] : undefined,
  description: row.tmdb_overview || `${row.episode_count} episodio(s) · ${row.season_count} temporada(s)`,
  year: row.tmdb_year || undefined,
  links: row.tmdb_id ? [{ name: 'tmdb', category: 'series', url: `https://www.themoviedb.org/tv/${row.tmdb_id}` }] : undefined,
});

const toMetaPreview = (row) => ({
  id: externalId(row),
  type: row.type,
  name: row.tmdb_title || row.name,
  poster: row.tmdb_poster || row.logo || undefined,
  posterShape: row.type === 'tv' ? 'square' : 'poster',
  background: row.tmdb_backdrop || undefined,
  logo: row.tmdb_poster || row.logo || undefined,
  genres: row.group_name ? [row.group_name] : undefined,
  description: row.tmdb_overview || undefined,
  year: row.tmdb_year || undefined,
  links: row.tmdb_id ? [{ name: 'tmdb', category: row.type, url: `https://www.themoviedb.org/${row.type === 'movie' ? 'movie' : 'tv'}/${row.tmdb_id}` }] : undefined,
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

const getExternalMeta = async (type, id, profileId) => {
  try {
    const credentials = getProfileCredentials(profileId);
    let resolved;
    if (id.startsWith('iptv:')) {
      const row = selectByUid.get(id.slice(5));
      if (row) {
        const match = await resolveTitle(type, row.series_title || row.name, row.year, credentials);
        if (match) resolved = { type, details: await getDetailsById(match.id, type, credentials) };
      }
    } else if (id.startsWith('tt')) resolved = await getDetailsByImdbId(id.split(':')[0], credentials);
    else {
      const match = /^tmdb:(?:(movie|series):)?(\d+)/.exec(id);
      if (match) resolved = { type: match[1] || type, details: await getDetailsById(match[2], match[1] || type, credentials) };
    }
    if (!resolved?.details) return null;
    return { meta: detailsToMeta(resolved.details, resolved.type, id) };
  } catch {
    return null;
  }
};

const getMeta = async (type, id, profileId) => {
  const uid = id.startsWith('iptv:') ? id.slice(5) : null;
  const tmdb = /^tmdb:(?:(movie|series):)?(\d+)(?::(\d+):(\d+))?$/.exec(id);
  const imdb = /^tt\d+/.test(id);
  if (!uid && !tmdb && !imdb) return null;
  const cacheKey = `meta:${getRevision()}:${profileId || 'default'}:${id}`;
  const cached = responseCache.get(cacheKey);
  if (cached) return cached;

  if (type === 'series') {
    const show = tmdb ? db.prepare('SELECT s.*, p.name AS playlist_name FROM series s JOIN playlists p ON p.id = s.playlist_id WHERE s.tmdb_id = ? LIMIT 1').get(Number(tmdb[2])) : selectSeriesByUid.get(uid);
    if (show) {
      const episodes = selectEpisodes.all(show.uid);
      const meta = {
        meta: {
          id: externalId(show, 'series'),
          type: 'series',
          name: show.tmdb_title || show.title,
          poster: show.tmdb_poster || show.logo || undefined,
          posterShape: 'poster',
          background: show.tmdb_backdrop || undefined,
          logo: show.tmdb_poster || show.logo || undefined,
          genres: show.group_name ? [show.group_name] : undefined,
          description: show.tmdb_overview || `${show.group_name || ''}${show.group_name ? ' · ' : ''}${show.playlist_name}`,
          year: show.tmdb_year || undefined,
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
      if (tmdb || profileId) {
        const enriched = await getExternalMeta('series', id, profileId);
        if (enriched) {
          enriched.meta.videos = [...(meta.meta.videos || []), ...(enriched.meta.videos || [])];
          enriched.meta.id = meta.meta.id;
          return responseCache.set(cacheKey, enriched);
        }
      }
      return responseCache.set(cacheKey, meta);
    }
  }

  const row = tmdb ? db.prepare('SELECT i.*, p.name AS playlist_name, p.user_agent AS playlist_user_agent FROM items i JOIN playlists p ON p.id = i.playlist_id WHERE i.tmdb_id = ? AND i.type = ? LIMIT 1').get(Number(tmdb[2]), type) : uid ? selectByUid.get(uid) : null;
  if (!row || row.type !== type) return getExternalMeta(type, id, profileId);

  const meta = {
    meta: {
      id: externalId(row),
      type: row.type,
      name: row.tmdb_title || row.name,
      poster: row.tmdb_poster || row.logo || undefined,
      posterShape: row.type === 'tv' ? 'square' : 'poster',
      background: row.tmdb_backdrop || undefined,
      logo: row.tmdb_poster || row.logo || undefined,
      genres: row.group_name ? [row.group_name] : undefined,
      description: row.tmdb_overview || `${row.group_name || ''}${row.group_name ? ' · ' : ''}${row.playlist_name}`,
      year: row.tmdb_year || undefined,
    },
  };
  if (tmdb || profileId) {
    const enriched = await getExternalMeta(type, id, profileId);
    if (enriched) {
      enriched.meta.id = meta.meta.id;
      return responseCache.set(cacheKey, enriched);
    }
  }
  return responseCache.set(cacheKey, meta);
};

// Keeps the chapter name readable inside the show page: drops the repeated
// series title and falls back to "TxEE" when nothing is left.
const episodeTitle = (row, showTitle) => {
  const stripped = row.name.replace(showTitle, '').replace(/^[\s._-]+/, '').trim();
  return stripped || `T${row.season || 1} E${row.episode || 1}`;
};

const matchTitle = (value) => normalizeName(String(value || '')).replace(/\b(?:19|20)\d{2}\b/g, ' ').replace(/\s+/g, ' ').trim();

const getGlobalStreams = async (type, id, profileId) => {
  try {
    const credentials = getProfileCredentials(profileId);
  if (!credentials.apiKey && !credentials.accessToken && !config.tmdbApiKey && !config.tmdbAccessToken) return null;
  let resolved;
  if (id.startsWith('tt')) resolved = await getDetailsByImdbId(id.split(':')[0], credentials);
  else {
    const match = /^tmdb:(?:(movie|series):)?(\d+)/.exec(id);
    if (match) resolved = { type: match[1] || type, details: await getDetailsById(match[2], match[1] || type, credentials) };
  }
  if (!resolved?.details) return null;
      const titles = collectTitles(resolved.details, resolved.type).map(matchTitle).filter(Boolean);
    const releaseDate = resolved.type === 'series' ? resolved.details.first_air_date : resolved.details.release_date;
    const targetYear = String(releaseDate || '').slice(0, 4);
    const yearFrom = (value) => (String(value || '').match(/\b(?:19|20)\d{2}\b/) || [])[0] || null;

  const episode = id.match(/:(\d+):(\d+)$/);
  const rows = db.prepare(`SELECT i.*, p.name AS playlist_name, p.user_agent AS playlist_user_agent, s.title AS series_title FROM items i JOIN playlists p ON p.id = i.playlist_id LEFT JOIN series s ON s.uid = i.series_uid WHERE p.enabled = 1 AND i.type = ? ORDER BY i.position`).all(resolved.type);
  const matches = rows.filter((row) => {
    if (resolved.type === 'series' && (!episode || row.season !== Number(episode[1]) || row.episode !== Number(episode[2]))) return false;
    if (row.tmdb_id && Number(row.tmdb_id) === Number(resolved.details.id)) return true;
    const candidates = [row.name, row.series_title, row.tmdb_title, row.tmdb_original_title];
    try { candidates.push(...(row.tmdb_titles ? JSON.parse(row.tmdb_titles) : [])); } catch {}
    const titleMatch = candidates.some((candidate) => {
      const normalized = matchTitle(candidate);
      return normalized && titles.some((title) => normalized === title || normalized.startsWith(`${title} `) || title.startsWith(`${normalized} `));
    });
    if (!titleMatch) return false;
    if (!targetYear) return true;
    const candidateYears = candidates.map(yearFrom).filter(Boolean);
    return candidateYears.includes(targetYear);
  });
  return { streams: matches.slice(0, 12).map((row) => {
    const attrs = row.attrs ? JSON.parse(row.attrs) : {};
    const userAgent = attrs['http-user-agent'] || row.playlist_user_agent || config.defaultUserAgent;
    return { name: 'IPTV', title: row.group_name ? `${row.name}\n${row.group_name}` : row.name, url: row.url, behaviorHints: { notWebReady: true, proxyHeaders: { request: { 'User-Agent': userAgent } } } };
  }) };
  } catch {
    return null;
  }
};

const getStreams = async (type, id, profileId) => {
  const uid = id.startsWith('iptv:') ? id.slice(5) : null;
  const tmdb = /^tmdb:(?:(movie|series):)?(\d+)(?::(\d+):(\d+))?$/.exec(id);
  if (!uid && !tmdb && !id.startsWith('tt')) return null;
  const cacheKey = `stream:${getRevision()}:${profileId || 'default'}:${id}`;
  const cached = responseCache.get(cacheKey);
  if (cached) return cached;

  if (tmdb) {
    const global = await getGlobalStreams(type, id, profileId);
    if (global?.streams?.length) return responseCache.set(cacheKey, global);
  }
  const row = tmdb ? db.prepare('SELECT i.*, p.name AS playlist_name, p.user_agent AS playlist_user_agent FROM items i JOIN playlists p ON p.id = i.playlist_id WHERE i.tmdb_id = ? AND i.type = ? LIMIT 1').get(Number(tmdb[2]), type) : uid ? selectByUid.get(uid) : null;
  if (!row || row.type !== type) return getGlobalStreams(type, id, profileId);

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
