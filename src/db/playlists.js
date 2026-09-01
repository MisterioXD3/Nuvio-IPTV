'use strict';

const { db, bumpRevision } = require('./index');

const selectAll = db.prepare('SELECT * FROM playlists ORDER BY position ASC, id ASC');
const selectEnabled = db.prepare(
  'SELECT * FROM playlists WHERE enabled = 1 ORDER BY position ASC, id ASC'
);
const selectById = db.prepare('SELECT * FROM playlists WHERE id = ?');
const selectStats = db.prepare('SELECT * FROM playlist_stats WHERE playlist_id = ?');
const selectMaxPosition = db.prepare('SELECT COALESCE(MAX(position), -1) AS max FROM playlists');

const insertStmt = db.prepare(`
  INSERT INTO playlists (name, kind, url, username, password, user_agent, enabled, position, refresh_hours, expires_at)
  VALUES (@name, @kind, @url, @username, @password, @user_agent, @enabled, @position, @refresh_hours, @expires_at)
`);

const UPDATABLE = [
  'name',
  'kind',
  'url',
  'username',
  'password',
  'user_agent',
  'enabled',
  'refresh_hours',
  'expires_at',
  'position',
];

const list = () => selectAll.all();
const listEnabled = () => selectEnabled.all();
const get = (id) => selectById.get(id);
const stats = (id) => selectStats.all(id);

const create = (input) => {
  const position = selectMaxPosition.get().max + 1;
  const info = insertStmt.run({
    name: input.name,
    kind: input.kind || 'm3u',
    url: input.url,
    username: input.username || null,
    password: input.password || null,
    user_agent: input.user_agent || null,
    enabled: input.enabled === false ? 0 : 1,
    position,
    refresh_hours: input.refresh_hours != null ? Number(input.refresh_hours) : 12,
    expires_at: input.expires_at || null,
  });
  bumpRevision();
  return get(info.lastInsertRowid);
};

const update = (id, patch) => {
  const fields = UPDATABLE.filter((key) => patch[key] !== undefined);
  if (!fields.length) return get(id);
  const assignments = fields.map((key) => `${key} = @${key}`).join(', ');
  const values = { id };
  for (const key of fields) {
    const value = patch[key];
    values[key] = key === 'enabled' ? (value ? 1 : 0) : value === '' ? null : value;
  }
  db.prepare(`UPDATE playlists SET ${assignments}, updated_at = datetime('now') WHERE id = @id`).run(
    values
  );
  bumpRevision();
  return get(id);
};

const remove = (id) => {
  db.prepare('DELETE FROM playlists WHERE id = ?').run(id);
  db.prepare('DELETE FROM staging_items WHERE playlist_id = ?').run(id);
  db.prepare('DELETE FROM items_fts WHERE playlist_id = ?').run(id);
  bumpRevision();
};

const reorder = db.transaction((orderedIds) => {
  const stmt = db.prepare('UPDATE playlists SET position = ?, updated_at = datetime(\'now\') WHERE id = ?');
  orderedIds.forEach((id, index) => stmt.run(index, id));
  bumpRevision();
});

module.exports = { list, listEnabled, get, stats, create, update, remove, reorder };
