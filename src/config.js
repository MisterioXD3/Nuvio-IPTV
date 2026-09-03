'use strict';

const path = require('path');

const num = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');

module.exports = {
  port: num(process.env.PORT, 7010),
  host: process.env.HOST || '0.0.0.0',
  dataDir,
  databasePath: process.env.DATABASE_PATH || path.join(dataDir, 'iptv.db'),
  addonId: process.env.ADDON_ID || 'community.nuvio.iptv',
  addonName: process.env.ADDON_NAME || 'Nuvio IPTV',
  addonVersion: require('../package.json').version,
  // Milliseconds a rendered catalog/meta/stream response stays in the memory cache.
  responseCacheTtlMs: num(process.env.RESPONSE_CACHE_TTL_MS, 5 * 60 * 1000),
  responseCacheMaxEntries: num(process.env.RESPONSE_CACHE_MAX_ENTRIES, 2000),
  catalogPageSize: num(process.env.CATALOG_PAGE_SIZE, 100),
  // How often the scheduler looks for playlists whose refresh interval elapsed.
  schedulerIntervalMs: num(process.env.SCHEDULER_INTERVAL_MS, 60 * 1000),
  syncTimeoutMs: num(process.env.SYNC_TIMEOUT_MS, 10 * 60 * 1000),
  defaultUserAgent: process.env.DEFAULT_USER_AGENT || 'VLC/3.0.20 LibVLC/3.0.20',
  streamsPerResultLimit: num(process.env.STREAMS_PER_RESULT_LIMIT, 0),
  adminToken: process.env.ADMIN_TOKEN || null,
  seedPlaylists: process.env.PLAYLISTS_JSON || null,
  tmdbApiKey: process.env.TMDB_API_KEY || null,
  tmdbAccessToken: process.env.TMDB_ACCESS_TOKEN || null,
  tmdbLanguages: (process.env.TMDB_LANGUAGES || 'es-ES,en-US,pt-BR,fr-FR,de-DE,it-IT').split(',').map((value) => value.trim()).filter(Boolean),
  tmdbMaxMatchesPerSync: num(process.env.TMDB_MAX_MATCHES_PER_SYNC, 250),
  tmdbMinMatchScore: num(process.env.TMDB_MIN_MATCH_SCORE, 60),
  tmdbRequestDelayMs: num(process.env.TMDB_REQUEST_DELAY_MS, 50),
  tmdbCacheTtlMs: num(process.env.TMDB_CACHE_TTL_MS, 24 * 60 * 60 * 1000),
  tmdbRequestTimeoutMs: num(process.env.TMDB_REQUEST_TIMEOUT_MS, 12000),
};
