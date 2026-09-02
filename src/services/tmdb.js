'use strict';

const config = require('../config');
const { db, bumpRevision } = require('../db');
const { normalizeName } = require('./m3u');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const unique = (values) => [...new Set(values.filter(Boolean))];

const tmdbConfigured = () => Boolean(config.tmdbApiKey || config.tmdbAccessToken);

const requestJson = async (path, params) => {
  const url = new URL(`https://api.themoviedb.org/3${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const headers = { accept: 'application/json' };
  if (config.tmdbAccessToken) headers.authorization = `Bearer ${config.tmdbAccessToken}`;
  else if (config.tmdbApiKey) url.searchParams.set('api_key', config.tmdbApiKey);
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

const searchOne = async (type, query) => {
  const endpoint = type === 'series' ? '/search/tv' : '/search/movie';
  const results = [];
  for (const language of config.tmdbLanguages) {
    const data = await requestJson(endpoint, { query, language, include_adult: 'false', page: '1' });
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
  };
};

const enrichPlaylist = async (playlistId) => {
  if (!tmdbConfigured()) return { status: 'skipped', reason: 'TMDB_API_KEY o TMDB_ACCESS_TOKEN no configurado' };
  const max = config.tmdbMaxMatchesPerSync;
  const rows = db.prepare(`
    SELECT type, COALESCE(series_title, name) AS lookup_name, series_uid FROM items
    WHERE playlist_id = ? AND type IN ('movie', 'series')
    GROUP BY type, lookup_name, series_uid ORDER BY MIN(position) LIMIT ?
  `).all(playlistId, max);
  let matched = 0;
  for (const row of rows) {
    try {
      const match = await searchOne(row.type, row.lookup_name);
      if (!match) continue;
      const aliases = unique([match.title, match.originalTitle, ...match.aliases]);
      const aliasesJson = JSON.stringify(aliases);
      const searchable = normalizeName([row.lookup_name, ...aliases].join(' '));
      if (row.type === 'series' && row.series_uid) {
        db.prepare(`UPDATE items SET tmdb_id = ?, tmdb_type = ?, tmdb_title = ?, tmdb_original_title = ?, tmdb_titles = ?, search_name = ? WHERE series_uid = ?`).run(match.id, match.type, match.title, match.originalTitle, aliasesJson, searchable, row.series_uid);
        db.prepare(`UPDATE series SET tmdb_id = ?, tmdb_type = ?, tmdb_title = ?, tmdb_original_title = ?, tmdb_titles = ?, search_title = ?, logo = COALESCE(logo, ?) WHERE uid = ?`).run(match.id, match.type, match.title, match.originalTitle, aliasesJson, searchable, match.poster, row.series_uid);
      } else {
        db.prepare(`UPDATE items SET tmdb_id = ?, tmdb_type = ?, tmdb_title = ?, tmdb_original_title = ?, tmdb_titles = ?, search_name = ? WHERE playlist_id = ? AND type = ? AND name = ?`).run(match.id, match.type, match.title, match.originalTitle, aliasesJson, searchable, playlistId, row.type, row.lookup_name);
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

module.exports = { enrichPlaylist, tmdbConfigured };
