'use strict';

const config = require('../config');
const playlists = require('../db/playlists');
const sync = require('./sync');

const FIELDS = ['name', 'kind', 'url', 'username', 'password', 'user_agent', 'refresh_hours', 'expires_at'];

const normalize = (entry) => {
  const out = {};
  for (const field of FIELDS) {
    const camel = field.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
    const value = entry[field] !== undefined ? entry[field] : entry[camel];
    if (value !== undefined) out[field] = value;
  }
  if (entry.enabled !== undefined) out.enabled = entry.enabled;
  return out;
};

// Recrea las listas declaradas en PLAYLISTS_JSON. Útil en plataformas sin disco
// persistente, donde la base se pierde en cada reinicio.
const seedFromEnv = () => {
  if (!config.seedPlaylists) return [];
  let entries;
  try {
    entries = JSON.parse(config.seedPlaylists);
  } catch (error) {
    console.error('[nuvio-iptv] PLAYLISTS_JSON no es JSON válido:', error.message);
    return [];
  }
  if (!Array.isArray(entries)) {
    console.error('[nuvio-iptv] PLAYLISTS_JSON debe ser un array de listas');
    return [];
  }

  const existing = new Map(playlists.list().map((playlist) => [playlist.url, playlist]));
  const created = [];
  for (const entry of entries) {
    if (!entry || !entry.url) continue;
    const input = normalize(entry);
    const current = existing.get(input.url);
    if (current) {
      playlists.update(current.id, input);
      continue;
    }
    const playlist = playlists.create({ name: input.url, ...input });
    created.push(playlist);
  }

  for (const playlist of created) {
    sync.syncPlaylist(playlist.id).catch((error) => {
      console.error(`[nuvio-iptv] fallo al sincronizar ${playlist.name}:`, error.message);
    });
  }
  if (created.length) {
    console.log(`[nuvio-iptv] ${created.length} lista(s) creadas desde PLAYLISTS_JSON`);
  }
  return created;
};

module.exports = { seedFromEnv };
