'use strict';

const express = require('express');

const config = require('../config');
const catalog = require('../services/catalog');
const { getRevision } = require('../db');
const { profileStatus, getProfileCredentials } = require('../services/tmdb');

const CACHE_HEADER = `public, max-age=${Math.floor(config.responseCacheTtlMs / 1000)}, stale-while-revalidate=86400`;

const buildManifest = () => {
  const catalogs = catalog.describeCatalogs();
  const types = [...new Set(catalogs.map((entry) => entry.type))];
  return {
    id: config.addonId,
    version: config.addonVersion,
    name: config.addonName,
    description:
      'Agrega varias listas IPTV grandes a Nuvio con caché, sincronización programada y configuración web.',
    logo: 'https://dl.strem.io/addon-logo.png',
    resources: ['catalog', 'meta', 'stream'],
    types: types.length ? types : ['tv'],
    idPrefixes: ['iptv:'],
    catalogs,
    behaviorHints: { configurable: true, configurationRequired: false },
  };
};

/** Decodes Stremio's `key=value&key=value` extra segment. */
const parseExtra = (raw) => {
  const extra = {};
  if (!raw) return extra;
  for (const part of decodeURIComponent(raw).split('&')) {
    if (!part) continue;
    const index = part.indexOf('=');
    if (index === -1) continue;
    extra[part.slice(0, index)] = part.slice(index + 1);
  }
  return extra;
};

const router = express.Router();
const profilePath = (path) => `/p/:profile${path}`;

router.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', '*');
  next();
});

let manifestCache = { revision: -1, value: null };

router.get([ '/manifest.json', profilePath('/manifest.json') ], (req, res) => {
  const revision = getRevision();
  if (manifestCache.revision !== revision) {
    manifestCache = { revision, value: buildManifest() };
  }
  res.set('Cache-Control', CACHE_HEADER).json(manifestCache.value);
});

router.get([ '/catalog/:type/:id.json', profilePath('/catalog/:type/:id.json') ], (req, res) => {
  const result = catalog.getCatalog({
    id: req.params.id,
    type: req.params.type,
          skip: 0,
      profileId: req.params.profile || null,

  });
  if (!result) return res.status(404).json({ metas: [] });
  return res.set('Cache-Control', CACHE_HEADER).json(result);
});

router.get([ '/catalog/:type/:id/:extra.json', profilePath('/catalog/:type/:id/:extra.json') ], (req, res) => {
  const extra = parseExtra(req.params.extra);
  const result = catalog.getCatalog({
    id: req.params.id,
    type: req.params.type,
    genre: extra.genre,
    search: extra.search,
    skip: extra.skip ? Number(extra.skip) : 0,
    profileId: req.params.profile || null,
  });
  if (!result) return res.status(404).json({ metas: [] });
  return res.set('Cache-Control', CACHE_HEADER).json(result);
});

router.get([ '/meta/:type/:id.json', profilePath('/meta/:type/:id.json') ], async (req, res) => {
  const result = await catalog.getMeta(req.params.type, req.params.id, req.params.profile || null);
  if (!result) return res.status(404).json({ meta: null });
  return res.set('Cache-Control', CACHE_HEADER).json(result);
});

router.get([ '/stream/:type/:id.json', profilePath('/stream/:type/:id.json') ], async (req, res) => {
  const result = await catalog.getStreams(req.params.type, req.params.id, req.params.profile || null);
  if (!result) return res.status(404).json({ streams: [] });
  return res.set('Cache-Control', CACHE_HEADER).json(result);
});

module.exports = { router, buildManifest };
