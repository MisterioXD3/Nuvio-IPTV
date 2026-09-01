'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nuvio-series-test-'));
process.env.DATABASE_PATH = path.join(process.env.DATA_DIR, 'test.db');

const { parseEpisode } = require('../src/services/m3u');
const playlists = require('../src/db/playlists');
const { syncPlaylist } = require('../src/services/sync');
const { createApp } = require('../src/app');

const EPISODES = [
  ['Breaking Bad S01 E01', 'Breaking Bad', 1, 1],
  ['Breaking Bad S01E02 Cat in the Bag', 'Breaking Bad', 1, 2],
  ['Breaking Bad S02E01', 'Breaking Bad', 2, 1],
  ['La Casa de Papel 1x03', 'La Casa de Papel', 1, 3],
  ['Dark - Temporada 2 Capitulo 5', 'Dark', 2, 5],
];

const buildPlaylist = () => {
  const lines = ['#EXTM3U'];
  EPISODES.forEach(([name], index) => {
    lines.push(
      `#EXTINF:-1 tvg-logo="http://logo/${index}.png" group-title="Series",${name}`,
      `http://origin/series/${index}.mkv`
    );
  });
  return `${lines.join('\n')}\n`;
};

let origin;
let addonServer;
let addonUrl;
let playlist;

test.before(async () => {
  const body = buildPlaylist();
  origin = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
    res.end(body);
  });
  await new Promise((resolve) => origin.listen(0, '127.0.0.1', resolve));

  addonServer = createApp().listen(0, '127.0.0.1');
  await new Promise((resolve) => addonServer.once('listening', resolve));
  addonUrl = `http://127.0.0.1:${addonServer.address().port}`;

  playlist = playlists.create({
    name: 'Series',
    url: `http://127.0.0.1:${origin.address().port}/lista.m3u`,
    refresh_hours: 0,
  });
  await syncPlaylist(playlist.id, { force: true });
});

test.after(async () => {
  await new Promise((resolve) => origin.close(resolve));
  await new Promise((resolve) => addonServer.close(resolve));
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
});

test('reconoce los formatos de episodio habituales', () => {
  for (const [name, title, season, episode] of EPISODES) {
    const parsed = parseEpisode(name);
    assert.ok(parsed, `sin coincidencia para ${name}`);
    assert.equal(parsed.seriesTitle, title);
    assert.equal(parsed.season, season);
    assert.equal(parsed.episode, episode);
  }
});

test('el catálogo muestra una sola portada por serie', async () => {
  const id = `iptv-${playlist.id}-series`;
  const page = await (await fetch(`${addonUrl}/catalog/series/${id}.json`)).json();
  const names = page.metas.map((meta) => meta.name).sort();
  assert.deepEqual(names, ['Breaking Bad', 'Dark', 'La Casa de Papel']);
});

test('la serie agrupa sus episodios por temporada y son reproducibles', async () => {
  const id = `iptv-${playlist.id}-series`;
  const page = await (await fetch(`${addonUrl}/catalog/series/${id}.json`)).json();
  const show = page.metas.find((meta) => meta.name === 'Breaking Bad');

  const meta = await (await fetch(`${addonUrl}/meta/series/${show.id}.json`)).json();
  assert.equal(meta.meta.videos.length, 3);
  assert.deepEqual(
    meta.meta.videos.map((video) => [video.season, video.episode]),
    [[1, 1], [1, 2], [2, 1]]
  );

  const episode = meta.meta.videos[1];
  const streams = await (await fetch(`${addonUrl}/stream/series/${episode.id}.json`)).json();
  assert.equal(streams.streams[0].url, 'http://origin/series/1.mkv');
});

test('la búsqueda de series devuelve la portada, no los capítulos', async () => {
  const id = `iptv-${playlist.id}-series`;
  const query = encodeURIComponent('search=casa de papel');
  const page = await (await fetch(`${addonUrl}/catalog/series/${id}/${query}.json`)).json();
  assert.equal(page.metas.length, 1);
  assert.equal(page.metas[0].name, 'La Casa de Papel');
});
