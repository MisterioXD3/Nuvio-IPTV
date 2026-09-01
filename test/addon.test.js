'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nuvio-iptv-test-'));
process.env.DATABASE_PATH = path.join(process.env.DATA_DIR, 'test.db');

const playlists = require('../src/db/playlists');
const { syncPlaylist } = require('../src/services/sync');
const catalog = require('../src/services/catalog');
const { createApp } = require('../src/app');

const ENTRIES = 5000;

const buildPlaylist = () => {
  const lines = ['#EXTM3U'];
  for (let i = 0; i < ENTRIES; i += 1) {
    const group = i % 2 ? 'Deportes' : 'Noticias';
    lines.push(
      `#EXTINF:-1 tvg-id="ch${i}" tvg-logo="http://logo/${i}.png" group-title="${group}",Canal ${i}`,
      `http://origin/live/${i}.ts`
    );
  }
  return `${lines.join('\n')}\n`;
};

let origin;
let originUrl;
let addonUrl;
let addonServer;

test.before(async () => {
  const body = buildPlaylist();
  origin = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
    res.end(body);
  });
  await new Promise((resolve) => origin.listen(0, '127.0.0.1', resolve));
  originUrl = `http://127.0.0.1:${origin.address().port}/lista.m3u`;

  addonServer = createApp().listen(0, '127.0.0.1');
  await new Promise((resolve) => addonServer.once('listening', resolve));
  addonUrl = `http://127.0.0.1:${addonServer.address().port}`;
});

test.after(async () => {
  await new Promise((resolve) => origin.close(resolve));
  await new Promise((resolve) => addonServer.close(resolve));
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
});

test('sincroniza una lista y expone catálogo, meta y stream', async () => {
  const playlist = playlists.create({ name: 'Prueba', url: originUrl, refresh_hours: 0 });
  const result = await syncPlaylist(playlist.id, { force: true });
  assert.equal(result.status, 'ok');
  assert.equal(result.items, ENTRIES);

  const manifest = await (await fetch(`${addonUrl}/manifest.json`)).json();
  const catalogEntry = manifest.catalogs.find((entry) => entry.type === 'tv');
  assert.ok(catalogEntry, 'el manifest debe incluir un catálogo de TV');
  assert.ok(catalogEntry.extra.find((extra) => extra.name === 'genre').options.includes('Deportes'));

  const page = await (
    await fetch(`${addonUrl}/catalog/tv/${catalogEntry.id}/skip=100.json`)
  ).json();
  assert.equal(page.metas.length, 100);
  assert.equal(page.metas[0].name, 'Canal 100');

  const byGenre = await (
    await fetch(`${addonUrl}/catalog/tv/${catalogEntry.id}/${encodeURIComponent('genre=Deportes')}.json`)
  ).json();
  assert.ok(byGenre.metas.every((meta) => meta.genres[0] === 'Deportes'));

  const search = await (
    await fetch(`${addonUrl}/catalog/tv/${catalogEntry.id}/${encodeURIComponent('search=canal 4242')}.json`)
  ).json();
  assert.equal(search.metas[0].name, 'Canal 4242');

  const id = page.metas[0].id;
  const meta = await (await fetch(`${addonUrl}/meta/tv/${id}.json`)).json();
  assert.equal(meta.meta.name, 'Canal 100');

  const streams = await (await fetch(`${addonUrl}/stream/tv/${id}.json`)).json();
  assert.equal(streams.streams[0].url, 'http://origin/live/100.ts');
  assert.ok(streams.streams[0].behaviorHints.proxyHeaders.request['User-Agent']);
});

test('detecta contenido idéntico y evita reescribir la base', async () => {
  const [playlist] = playlists.list();
  const second = await syncPlaylist(playlist.id);
  assert.equal(second.status, 'unchanged');
});

test('los identificadores sobreviven a una resincronización', async () => {
  const [playlist] = playlists.list();
  const before = catalog.getCatalog({ id: `iptv-${playlist.id}-tv`, type: 'tv', skip: 0 }).metas[0].id;
  await syncPlaylist(playlist.id, { force: true });
  const after = catalog.getCatalog({ id: `iptv-${playlist.id}-tv`, type: 'tv', skip: 0 }).metas[0].id;
  assert.equal(before, after);
});

test('las listas ocultas desaparecen del manifest', async () => {
  const [playlist] = playlists.list();
  playlists.update(playlist.id, { enabled: false });
  const manifest = await (await fetch(`${addonUrl}/manifest.json`)).json();
  assert.equal(manifest.catalogs.length, 0);
  playlists.update(playlist.id, { enabled: true });
});
