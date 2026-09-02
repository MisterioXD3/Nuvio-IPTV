'use strict';

const express = require('express');

const config = require('../config');
const playlists = require('../db/playlists');
const catalog = require('../services/catalog');
const { syncPlaylist, isSyncing } = require('../services/sync');
const { enrichAll, tmdbStatus } = require('../services/tmdb');
const { db } = require('../db');

const router = express.Router();

router.use(express.json({ limit: '256kb' }));

router.use((req, res, next) => {
  if (!config.adminToken) return next();
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : req.query.token;
  if (token !== config.adminToken) return res.status(401).json({ error: 'No autorizado' });
  return next();
});

const daysUntil = (value) => {
  if (!value) return null;
  const ts = Date.parse(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`);
  if (Number.isNaN(ts)) return null;
  return Math.round((ts - Date.now()) / 86400000);
};

const present = (playlist) => {
  const stats = playlists.stats(playlist.id);
  return {
    id: playlist.id,
    name: playlist.name,
    kind: playlist.kind,
    url: playlist.url,
    username: playlist.username,
    hasPassword: Boolean(playlist.password),
    userAgent: playlist.user_agent,
    enabled: Boolean(playlist.enabled),
    position: playlist.position,
    refreshHours: playlist.refresh_hours,
    expiresAt: playlist.expires_at,
    daysUntilExpiry: daysUntil(playlist.expires_at),
    lastSyncAt: playlist.last_sync_at,
    lastSyncStatus: playlist.last_sync_status,
    lastSyncError: playlist.last_sync_error,
    lastSyncDurationMs: playlist.last_sync_duration_ms,
    bytesDownloaded: playlist.bytes_downloaded,
    syncing: isSyncing(playlist.id),
    resources: stats.map((row) => ({
      type: row.type,
      items: row.item_count,
      groups: row.group_count,
    })),
    totalItems: stats.reduce((sum, row) => sum + row.item_count, 0),
  };
};

router.get('/tmdb', (req, res) => {
  res.json(tmdbStatus());
});

router.post('/tmdb/enrich', async (req, res) => {
  try {
    return res.json({ results: await enrichAll(), status: tmdbStatus() });
  } catch (error) {
    return res.status(502).json({ error: error.message, status: tmdbStatus() });
  }
});

router.get('/playlists', (req, res) => {
  res.json({ playlists: playlists.list().map(present) });
});

router.post('/playlists', (req, res) => {
  const { name, url } = req.body || {};
  if (!name || !url) return res.status(400).json({ error: 'Nombre y URL son obligatorios' });
  const created = playlists.create({
    name,
    url,
    kind: req.body.kind,
    username: req.body.username,
    password: req.body.password,
    user_agent: req.body.userAgent || req.body.user_agent,
    enabled: req.body.enabled,
    refresh_hours: req.body.refreshHours || req.body.refresh_hours,
    expires_at: req.body.expiresAt || req.body.expires_at,
  });
  catalog.clearCache();
  syncPlaylist(created.id).catch(() => {});
  return res.status(201).json({ playlist: present(created) });
});

router.patch('/playlists/:id', (req, res) => {
  const playlist = playlists.get(Number(req.params.id));
  if (!playlist) return res.status(404).json({ error: 'Lista no encontrada' });
  const updated = playlists.update(playlist.id, {
    name: req.body.name,
    url: req.body.url,
    kind: req.body.kind,
    username: req.body.username,
    password: req.body.password,
    user_agent: req.body.userAgent,
    enabled: req.body.enabled,
    refresh_hours: req.body.refreshHours,
    expires_at: req.body.expiresAt,
  });
  catalog.clearCache();
  return res.json({ playlist: present(updated) });
});

router.delete('/playlists/:id', (req, res) => {
  playlists.remove(Number(req.params.id));
  catalog.clearCache();
  res.status(204).end();
});

router.post('/playlists/reorder', (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids.map(Number) : null;
  if (!ids || !ids.length) return res.status(400).json({ error: 'Se requiere el arreglo ids' });
  playlists.reorder(ids);
  catalog.clearCache();
  return res.json({ playlists: playlists.list().map(present) });
});

router.post('/playlists/:id/sync', async (req, res) => {
  const playlist = playlists.get(Number(req.params.id));
  if (!playlist) return res.status(404).json({ error: 'Lista no encontrada' });
  try {
    const result = await syncPlaylist(playlist.id, { force: req.body && req.body.force });
    catalog.clearCache();
    return res.json({ result, playlist: present(playlists.get(playlist.id)) });
  } catch (error) {
    return res.status(502).json({ error: error.message, playlist: present(playlists.get(playlist.id)) });
  }
});

router.get('/playlists/:id/groups', (req, res) => {
  const id = Number(req.params.id);
  res.json({
    types: catalog.typesFor(id).map((row) => ({
      type: row.type,
      items: row.item_count,
      groups: catalog.groupsFor(id, row.type),
    })),
  });
});

router.get('/stats', (req, res) => {
  const totals = db
    .prepare('SELECT type, COUNT(*) AS items FROM items GROUP BY type')
    .all();
  res.json({
    manifestUrl: null,
    totals,
    totalItems: totals.reduce((sum, row) => sum + row.items, 0),
    playlists: playlists.list().length,
    enabledPlaylists: playlists.listEnabled().length,
    cache: catalog.cacheStats(),
    uptimeSeconds: Math.round(process.uptime()),
    memoryMb: Math.round(process.memoryUsage().rss / 1048576),
  });
});

router.post('/cache/clear', (req, res) => {
  catalog.clearCache();
  res.json({ ok: true });
});

module.exports = router;
