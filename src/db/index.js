'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const config = require('../config');

fs.mkdirSync(path.dirname(config.databasePath), { recursive: true });

const db = new Database(config.databasePath);

db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('temp_store = MEMORY');
db.pragma('mmap_size = 268435456');
db.pragma('cache_size = -65536');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS playlists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'm3u',
  url TEXT NOT NULL,
  username TEXT,
  password TEXT,
  user_agent TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  position INTEGER NOT NULL DEFAULT 0,
  refresh_hours REAL NOT NULL DEFAULT 12,
  expires_at TEXT,
  last_sync_at TEXT,
  last_sync_status TEXT,
  last_sync_error TEXT,
  last_sync_duration_ms INTEGER,
  http_etag TEXT,
  http_last_modified TEXT,
  content_hash TEXT,
  bytes_downloaded INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  uid TEXT NOT NULL,
  type TEXT NOT NULL,
  ext_id TEXT,
  name TEXT NOT NULL,
  search_name TEXT NOT NULL,
  group_name TEXT,
  logo TEXT,
  url TEXT NOT NULL,
  position INTEGER NOT NULL,
  attrs TEXT,
  series_uid TEXT,
  series_key TEXT,
  series_title TEXT,
  series_search TEXT,
  season INTEGER,
  episode INTEGER
);

CREATE INDEX IF NOT EXISTS idx_items_playlist_type_pos ON items (playlist_id, type, position);
CREATE INDEX IF NOT EXISTS idx_items_series ON items (series_uid, season, episode);
CREATE INDEX IF NOT EXISTS idx_items_playlist_group ON items (playlist_id, type, group_name, position);
CREATE INDEX IF NOT EXISTS idx_items_search ON items (search_name);
CREATE INDEX IF NOT EXISTS idx_items_uid ON items (uid);

-- Rows land here while a playlist downloads so the live table keeps serving the
-- previous snapshot; the swap into items is a single fast transaction.
CREATE TABLE IF NOT EXISTS staging_items (
  playlist_id INTEGER NOT NULL,
  uid TEXT NOT NULL,
  type TEXT NOT NULL,
  ext_id TEXT,
  name TEXT NOT NULL,
  search_name TEXT NOT NULL,
  group_name TEXT,
  logo TEXT,
  url TEXT NOT NULL,
  position INTEGER NOT NULL,
  attrs TEXT,
  series_uid TEXT,
  series_key TEXT,
  series_title TEXT,
  series_search TEXT,
  season INTEGER,
  episode INTEGER
);

CREATE INDEX IF NOT EXISTS idx_staging_playlist ON staging_items (playlist_id);

-- Standalone FTS index (not external-content) so a playlist can be reindexed
-- in isolation without touching the other playlists' entries.
CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(
  text,
  playlist_id UNINDEXED,
  item_id UNINDEXED,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TABLE IF NOT EXISTS groups (
  playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  item_count INTEGER NOT NULL,
  PRIMARY KEY (playlist_id, type, name)
);

CREATE TABLE IF NOT EXISTS playlist_stats (
  playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  item_count INTEGER NOT NULL,
  group_count INTEGER NOT NULL,
  PRIMARY KEY (playlist_id, type)
);

-- One row per show, rebuilt on every sync, so the series catalog shows a single
-- poster per title instead of one per episode.
CREATE TABLE IF NOT EXISTS series (
  playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  uid TEXT NOT NULL,
  series_key TEXT NOT NULL,
  title TEXT NOT NULL,
  search_title TEXT NOT NULL,
  group_name TEXT,
  logo TEXT,
  episode_count INTEGER NOT NULL,
  season_count INTEGER NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY (playlist_id, series_key)
);

CREATE INDEX IF NOT EXISTS idx_series_playlist_pos ON series (playlist_id, position);
CREATE INDEX IF NOT EXISTS idx_series_group ON series (playlist_id, group_name, position);
CREATE INDEX IF NOT EXISTS idx_series_search ON series (playlist_id, search_title);
CREATE INDEX IF NOT EXISTS idx_series_uid ON series (uid);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tmdb_profiles (
  id TEXT PRIMARY KEY,
  api_key TEXT,
  access_token TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// Adds columns introduced after a database was first created.
const addMissingColumns = (table, columns) => {
  const existing = new Set(db.pragma(`table_info(${table})`).map((column) => column.name));
  for (const [name, type] of columns) {
    if (!existing.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
  }
};

const SERIES_COLUMNS = [
  ['series_uid', 'TEXT'],
  ['series_key', 'TEXT'],
  ['series_title', 'TEXT'],
  ['series_search', 'TEXT'],
  ['season', 'INTEGER'],
  ['episode', 'INTEGER'],
];
const TMDB_COLUMNS = [
  ['tmdb_id', 'INTEGER'],
  ['tmdb_type', 'TEXT'],
  ['tmdb_title', 'TEXT'],
  ['tmdb_original_title', 'TEXT'],
  ['tmdb_titles', 'TEXT'],
];
addMissingColumns('items', SERIES_COLUMNS);
addMissingColumns('staging_items', SERIES_COLUMNS);
addMissingColumns('items', TMDB_COLUMNS);
addMissingColumns('series', TMDB_COLUMNS);

const getMetaStmt = db.prepare('SELECT value FROM meta WHERE key = ?');
const setMetaStmt = db.prepare(
  'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
);

const getMeta = (key, fallback = null) => {
  const row = getMetaStmt.get(key);
  return row ? row.value : fallback;
};

const setMeta = (key, value) => setMetaStmt.run(key, String(value));

/**
 * Monotonic counter bumped whenever playlists or their items change. It is part
 * of every cache key so a configuration change invalidates cached responses
 * without walking the cache.
 */
const bumpRevision = () => {
  const next = Number(getMeta('revision', '0')) + 1;
  setMeta('revision', next);
  return next;
};

const getRevision = () => Number(getMeta('revision', '0'));

module.exports = { db, getMeta, setMeta, bumpRevision, getRevision };
