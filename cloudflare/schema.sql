PRAGMA foreign_keys = ON;

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
CREATE INDEX IF NOT EXISTS idx_items_playlist_type_pos ON items(playlist_id,type,position);
CREATE INDEX IF NOT EXISTS idx_items_playlist_group ON items(playlist_id,type,group_name,position);
CREATE INDEX IF NOT EXISTS idx_items_uid ON items(uid);
CREATE INDEX IF NOT EXISTS idx_items_series ON items(series_uid,season,episode);
CREATE TABLE IF NOT EXISTS groups (playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,type TEXT NOT NULL,name TEXT NOT NULL,item_count INTEGER NOT NULL,PRIMARY KEY(playlist_id,type,name));
CREATE TABLE IF NOT EXISTS playlist_stats (playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,type TEXT NOT NULL,item_count INTEGER NOT NULL,group_count INTEGER NOT NULL,PRIMARY KEY(playlist_id,type));
CREATE TABLE IF NOT EXISTS series (playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,uid TEXT NOT NULL,series_key TEXT NOT NULL,title TEXT NOT NULL,search_title TEXT NOT NULL,group_name TEXT,logo TEXT,episode_count INTEGER NOT NULL,season_count INTEGER NOT NULL,position INTEGER NOT NULL,PRIMARY KEY(playlist_id,series_key));
CREATE INDEX IF NOT EXISTS idx_series_playlist_pos ON series(playlist_id,position);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(text,playlist_id UNINDEXED,item_id UNINDEXED,tokenize='unicode61 remove_diacritics 2');
