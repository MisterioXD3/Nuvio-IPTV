'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { Readable } = require('node:stream');

const { parseM3u, normalizeName, detectType } = require('../src/services/m3u');

const collect = async (text, chunkSize = 7) => {
  const buffer = Buffer.from(text, 'utf8');
  const chunks = [];
  for (let i = 0; i < buffer.length; i += chunkSize) chunks.push(buffer.subarray(i, i + chunkSize));
  const items = [];
  for await (const item of parseM3u(Readable.from(chunks))) items.push(item);
  return items;
};

const SAMPLE = `#EXTM3U
#EXTINF:-1 tvg-id="cnn.us" tvg-logo="http://logo/cnn.png" group-title="Noticias",CNN
#EXTVLCOPT:http-user-agent=MiAgente/1.0
http://server/live/cnn.ts
#EXTGRP:Cine
#EXTINF:-1,Matrix
http://server/movie/1.mp4
`;

test('parsea atributos, grupos y user-agent en trozos arbitrarios', async () => {
  const items = await collect(SAMPLE);
  assert.equal(items.length, 2);

  assert.deepEqual(
    {
      name: items[0].name,
      group: items[0].group,
      type: items[0].type,
      logo: items[0].logo,
      extId: items[0].extId,
      agent: items[0].attrs['http-user-agent'],
    },
    {
      name: 'CNN',
      group: 'Noticias',
      type: 'tv',
      logo: 'http://logo/cnn.png',
      extId: 'cnn.us',
      agent: 'MiAgente/1.0',
    }
  );

  assert.equal(items[1].name, 'Matrix');
  assert.equal(items[1].group, 'Cine');
  assert.equal(items[1].type, 'movie');
});

test('normaliza nombres para búsqueda sin acentos', () => {
  assert.equal(normalizeName('Canal Ñ Deportes+ HD'), 'canal n deportes hd');
});

test('clasifica por ruta y por grupo', () => {
  assert.equal(detectType('Deportes', 'http://s/live/1.ts'), 'tv');
  assert.equal(detectType('VOD Peliculas', 'http://s/x/1'), 'movie');
  assert.equal(detectType('Series', 'http://s/x/1'), 'series');
  assert.equal(detectType('Cualquiera', 'http://s/series/1.mkv'), 'series');
});
