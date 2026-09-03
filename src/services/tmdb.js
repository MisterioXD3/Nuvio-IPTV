'use strict';

const crypto = require('crypto');
const config = require('../config');
const { db, bumpRevision } = require('../db');
const { normalizeName } = require('./m3u');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const unique = (values) => [...new Set(values.filter(Boolean))];

const tmdbConfigured = () => Boolean(config.tmdbApiKey || config.tmdbAccessToken);
let enrichmentJob = null;
const profileById = db.prepare('SELECT id, api_key, access_token FROM tmdb_profiles WHERE id = ?');
const profileStatus = (id) => {
  const profile = profileById.get(id);
  return { id, configured: Boolean(profile && (profile.api_key || profile.access_token)), hasApiKey: Boolean(profile?.api_key), hasAccessToken: Boolean(profile?.access_token) };
};
const saveProfile = ({ id, apiKey, accessToken }) => {
  const profileId = id || crypto.randomBytes(12).toString('base64url');
  db.prepare(`INSERT INTO tmdb_profiles (id, api_key, access_token, updated_at) VALUES (?, ?, ?, datetime('now')) ON CONFLICT(id) DO UPDATE SET api_key = excluded.api_key, access_token = excluded.access_token, updated_at = datetime('now')`).run(profileId, apiKey || null, accessToken || null);
  return profileStatus(profileId);
};
const getProfileCredentials = (id) => {
  const row = id ? profileById.get(id) : null;
  return row ? { apiKey: row.api_key, accessToken: row.access_token } : {};
};

const requestJson = async (path, params, credentials = {}) => {
  const url = new URL(`https://api.themoviedb.org/3${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const headers = { accept: 'application/json' };
  const accessToken = credentials.accessToken || config.tmdbAccessToken;
  const apiKey = credentials.apiKey || config.tmdbApiKey;
  if (accessToken) headers.authorization = `Bearer ${accessToken}`;
  else if (apiKey) url.searchParams.set('api_key', apiKey);
  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error(`TMDb HTTP ${response.status}`);
  return response.json();
};

const resultTitle = (result) => result.title || result.name || result.original_title || result.original_name || '';
const resultOriginalTitle = (result) => result.original_title || result.original_name || '';

const scoreResult = (query, result) => {
  const needle = normalizeName(query);
  const candidates = unique([resultTitle(result), resultOriginalTitle(result), ...(result.alternative_titles || [])].map(normalizeName));
  if (!needle || !candidates.length) return -1;
  if (candidates.includes(needle)) return 100;
  if (candidates.some((candidate) => candidate.startsWith(needle) || needle.startsWith(candidate))) return 80;
  const queryWords = new Set(needle.split(' '));
  const best = Math.max(...candidates.map((candidate) => {
    const hits = candidate.split(' ').filter((word) => queryWords.has(word)).length;
    return (hits / Math.max(queryWords.size, candidate.split(' ').length)) * 60;
  }));
  return best;
};

const searchOne = async (type, query, credentials = {}) => {
  const endpoint = type === 'series' ? '/search/tv' : '/search/movie';
  const results = [];
  for (const language of config.tmdbLanguages) {
    const data = await requestJson(endpoint, { query, language, include_adult: 'false', page: '1' }, credentials);
    results.push(...(data.results || []).slice(0, 5).map((result) => ({ ...result, language })));
    await sleep(config.tmdbRequestDelayMs);
  }
  const ranked = results
    .filter((result) => result.id && scoreResult(query, result) >= config.tmdbMinMatchScore)
    .sort((a, b) => scoreResult(query, b) - scoreResult(query, a) || (b.popularity || 0) - (a.popularity || 0));
  const best = ranked[0];
  if (!best) return null;
  const aliases = unique(results.filter((result) => result.id === best.id).flatMap((result) => [result.title, result.name, result.original_title, result.original_name]));
  return {
    id: best.id,
    type,
    title: resultTitle(best),
    originalTitle: resultOriginalTitle(best),
    aliases,
    poster: best.poster_path ? `https://image.tmdb.org/t/p/w500${best.poster_path}` : null,
    backdrop: best.backdrop_path ? `https://image.tmdb.org/t/p/w1280${best.backdrop_path}` : null,
    overview: best.overview || null,
    year: (best.release_date || best.first_air_date || '').slice(0, 4) || null,
    rating: best.vote_average || null,
    genres: Array.isArray(best.genre_ids) ? best.genre_ids : [],
  };
};

const getDetailsByImdbId = async (imdbId, credentials = {}) => {
  const data = await requestJson(`/find/${encodeURIComponent(imdbId)}`, { external_source: 'imdb_id' }, credentials);
  if (data.movie_results?.length) return { type: 'movie', details: data.movie_results[0] };
  if (data.tv_results?.length) return { type: 'series', details: data.tv_results[0] };
  return null;
};

const getDetailsById = async (tmdbId, type, credentials = {}) => {
  const endpoint = type === 'series' ? `/tv/${encodeURIComponent(tmdbId)}` : `/movie/${encodeURIComponent(tmdbId)}`;
  return requestJson(endpoint, { append_to_response: 'alternative_titles,external_ids' }, credentials);
};
const collectTitles = (details, type) => {
  const values = [type === 'series' ? details.name : details.title, type === 'series' ? details.original_name : details.original_title];
  const alternatives = details.alternative_titles?.titles || details.alternative_titles?.results || [];
  return [...new Set([...values, ...alternatives.map((entry) => entry.title)].filter(Boolean))];
};
const detailsToMeta = (details, type, id) => {
  const releaseDate = type === 'series' ? details.first_air_date : details.release_date;
  return {
    id,
    type,
    name: type === 'series' ? details.name || details.original_name : details.title || details.original_title,
    poster: details.poster_path ? `https://image.tmdb.org/t/p/w500${details.poster_path}` : undefined,
    background: details.backdrop_path ? `https://image.tmdb.org/t/p/w1280${details.backdrop_path}` : undefined,
    description: details.overview || undefined,
    year: releaseDate ? releaseDate.slice(0, 4) : undefined,
    releaseInfo: releaseDate ? releaseDate.slice(0, 4) : undefined,
    imdbRating: details.vote_average ? String(Math.round(details.vote_average * 10) / 10) : undefined,
    genres: Array.isArray(details.genres) ? details.genres.map((genre) => genre.name) : undefined,
  };
};

const tmdbStatus = () => {
  const totals = db.prepare(`SELECT type, COUNT(*) AS total, SUM(CASE WHEN tmdb_id IS NOT NULL THEN 1 ELSE 0 END) AS matched FROM items WHERE type IN ('movie', 'series') GROUP BY type`).all();
  return {
    configured: tmdbConfigured(),
    languages: config.tmdbLanguages,
    maxMatchesPerSync: config.tmdbMaxMatchesPerSync,
    totals,
    job: enrichmentJob ? { status: enrichmentJob.status, startedAt: enrichmentJob.startedAt, finishedAt: enrichmentJob.finishedAt || null, error: enrichmentJob.error || null, results: enrichmentJob.results || [] } : null,
  };
};

const startEnrichment = (credentials = {}) => {
  if (enrichmentJob?.status === 'running') return enrichmentJob;
  enrichmentJob = { status: 'running', startedAt: new Date().toISOString(), results: [] };
  enrichAll(credentials)
    .then((results) => { enrichmentJob = { ...enrichmentJob, status: 'completed', finishedAt: new Date().toISOString(), results }; })
    .catch((error) => { enrichmentJob = { ...enrichmentJob, status: 'failed', finishedAt: new Date().toISOString(), error: error.message }; });
  return enrichmentJob;
};

const enrichAll = async (credentials = {}) => {
  const results = [];
  for (const playlist of db.prepare('SELECT id FROM playlists WHERE enabled = 1 ORDER BY position').all()) {
    results.push({ playlistId: playlist.id, ...(await enrichPlaylist(playlist.id, credentials)) });
  }
  return results;
};

const enrichPlaylist = async (playlistId, credentials = {}) => {
  if (!tmdbConfigured() && !credentials.apiKey && !credentials.accessToken) return { status: 'skipped', reason: 'TMDB_API_KEY o TMDB_ACCESS_TOKEN no configurado' };
  const max = config.tmdbMaxMatchesPerSync;
  const rows = db.prepare(`
    SELECT type, COALESCE(series_title, name) AS lookup_name, series_uid FROM items
    WHERE playlist_id = ? AND type IN ('movie', 'series')
    GROUP BY type, lookup_name, series_uid ORDER BY MIN(position) LIMIT ?
  `).all(playlistId, max);
  let matched = 0;
  for (const row of rows) {
    try {
      const match = await searchOne(row.type, row.lookup_name, credentials);
      if (!match) continue;
      const aliases = unique([match.title, match.originalTitle, ...match.aliases]);
      const aliasesJson = JSON.stringify(aliases);
      const searchable = normalizeName([row.lookup_name, ...aliases].join(' '));
      if (row.type === 'series' && row.series_uid) {
        db.prepare(`UPDATE items SET tmdb_id = ?, tmdb_type = ?, tmdb_title = ?, tmdb_original_title = ?, tmdb_titles = ?, tmdb_poster = ?, tmdb_backdrop = ?, tmdb_overview = ?, tmdb_year = ?, tmdb_rating = ?, tmdb_genres = ?, search_name = ? WHERE series_uid = ?`).run(match.id, match.type, match.title, match.originalTitle, aliasesJson, match.poster, match.backdrop, match.overview, match.year ? Number(match.year) : null, match.rating, JSON.stringify(match.genres), searchable, row.series_uid);
        db.prepare(`UPDATE series SET tmdb_id = ?, tmdb_type = ?, tmdb_title = ?, tmdb_original_title = ?, tmdb_titles = ?, tmdb_poster = ?, tmdb_backdrop = ?, tmdb_overview = ?, tmdb_year = ?, tmdb_rating = ?, tmdb_genres = ?, search_title = ?, logo = COALESCE(logo, ?) WHERE uid = ?`).run(match.id, match.type, match.title, match.originalTitle, aliasesJson, match.poster, match.backdrop, match.overview, match.year ? Number(match.year) : null, match.rating, JSON.stringify(match.genres), searchable, match.poster, row.series_uid);
      } else {
        db.prepare(`UPDATE items SET tmdb_id = ?, tmdb_type = ?, tmdb_title = ?, tmdb_original_title = ?, tmdb_titles = ?, tmdb_poster = ?, tmdb_backdrop = ?, tmdb_overview = ?, tmdb_year = ?, tmdb_rating = ?, tmdb_genres = ?, search_name = ? WHERE playlist_id = ? AND type = ? AND name = ?`).run(match.id, match.type, match.title, match.originalTitle, aliasesJson, match.poster, match.backdrop, match.overview, match.year ? Number(match.year) : null, match.rating, JSON.stringify(match.genres), searchable, playlistId, row.type, row.lookup_name);
      }
      matched += 1;
    } catch (error) {
      console.warn(`[nuvio-iptv] TMDb no pudo resolver \"${row.lookup_name}\": ${error.message}`);
    }
  }
  if (matched) {
    db.prepare('DELETE FROM items_fts WHERE playlist_id = ?').run(playlistId);
    db.prepare(`INSERT INTO items_fts (text, playlist_id, item_id) SELECT search_name || ' ' || COALESCE(group_name, ''), playlist_id, id FROM items WHERE playlist_id = ?`).run(playlistId);
    bumpRevision();
  }
  return { status: 'ok', candidates: rows.length, matched };
};

module.exports = { enrichPlaylist, enrichAll, startEnrichment, tmdbConfigured, tmdbStatus, saveProfile, profileStatus, getProfileCredentials, getDetailsById, getDetailsByImdbId, collectTitles, detailsToMeta };
