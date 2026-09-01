'use strict';

const config = require('../config');
const playlists = require('../db/playlists');
const { syncPlaylist, isSyncing } = require('./sync');

const dueForSync = (playlist) => {
  if (!playlist.enabled) return false;
  if (playlist.refresh_hours <= 0) return false;
  if (!playlist.last_sync_at) return true;
  const raw = playlist.last_sync_at;
  const last = Date.parse(raw.includes('T') ? raw : `${raw.replace(' ', 'T')}Z`);
  if (Number.isNaN(last)) return true;
  return Date.now() - last >= playlist.refresh_hours * 3600 * 1000;
};

const tick = async () => {
  for (const playlist of playlists.list()) {
    if (!dueForSync(playlist) || isSyncing(playlist.id)) continue;
    try {
      await syncPlaylist(playlist.id);
    } catch (error) {
      console.error(`[sync] ${playlist.name}: ${error.message}`);
    }
  }
};

const start = () => {
  const timer = setInterval(() => {
    tick().catch((error) => console.error('[scheduler]', error));
  }, config.schedulerIntervalMs);
  timer.unref();
  tick().catch((error) => console.error('[scheduler]', error));
  return timer;
};

module.exports = { start, dueForSync };
