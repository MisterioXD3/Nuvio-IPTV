'use strict';

/**
 * Generates a synthetic M3U playlist for load testing.
 * Usage: node scripts/generate-playlist.js <entries> <output>
 */
const fs = require('fs');

const count = Number(process.argv[2] || 100000);
const output = process.argv[3] || 'big.m3u';

const groups = ['Deportes', 'Noticias', 'Cine', 'VOD Peliculas', 'Series Netflix', 'Infantil', 'Musica'];
const stream = fs.createWriteStream(output);
stream.write('#EXTM3U\n');

for (let i = 0; i < count; i += 1) {
  const group = groups[i % groups.length];
  const isVod = group.startsWith('VOD');
  const isSeries = group.startsWith('Series');
  const url = isVod
    ? `http://example.com/movie/user/pass/${i}.mp4`
    : isSeries
      ? `http://example.com/series/user/pass/${i}.mkv`
      : `http://example.com/live/user/pass/${i}.ts`;
  const name = isSeries
    ? `Serie ${Math.floor(i / 40)} S${String((Math.floor(i / 10) % 4) + 1).padStart(2, '0')}E${String((i % 10) + 1).padStart(2, '0')}`
    : `Canal ${i}`;
  stream.write(
    `#EXTINF:-1 tvg-id="ch${i}" tvg-name="${name}" tvg-logo="http://example.com/logo/${i}.png" group-title="${group}",${name}\n${url}\n`
  );
}

stream.end(() => console.log(`Escritas ${count} entradas en ${output}`));
