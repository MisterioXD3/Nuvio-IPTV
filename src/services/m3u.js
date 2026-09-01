'use strict';

const ATTR_RE = /([A-Za-z0-9_-]+)="([^"]*)"/g;

const parseExtinf = (line) => {
  const commaIndex = line.indexOf(',');
  const head = commaIndex === -1 ? line : line.slice(0, commaIndex);
  const name = commaIndex === -1 ? '' : line.slice(commaIndex + 1).trim();
  const attrs = {};
  ATTR_RE.lastIndex = 0;
  let match = ATTR_RE.exec(head);
  while (match) {
    attrs[match[1].toLowerCase()] = match[2];
    match = ATTR_RE.exec(head);
  }
  return { name, attrs };
};

const MOVIE_HINT = /(^|[^a-z])(vod|movies?|pel[ií]culas?|cine|film)([^a-z]|$)/i;
const SERIES_HINT = /(^|[^a-z])(series?|shows?|novelas?|temporadas?)([^a-z]|$)/i;

const detectType = (group, url) => {
  if (/\/series\//i.test(url)) return 'series';
  if (/\/movie\//i.test(url)) return 'movie';
  if (group) {
    if (SERIES_HINT.test(group)) return 'series';
    if (MOVIE_HINT.test(group)) return 'movie';
  }
  if (/\.(mp4|mkv|avi)(\?|$)/i.test(url)) return 'movie';
  return 'tv';
};

const normalizeName = (name) =>
  name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

// Episode markers used by IPTV providers: "S01 E02", "S01E02", "1x02",
// "Temporada 1 Capitulo 2", "T1 Ep2"...
const EPISODE_PATTERNS = [
  /^(.*?)[\s._-]*\b[sS](\d{1,3})[\s._-]*[eExX](\d{1,4})\b[\s._-]*(.*)$/,
  /^(.*?)[\s._-]+(\d{1,3})[xX](\d{1,4})\b[\s._-]*(.*)$/,
  /^(.*?)[\s._-]*\b(?:temporadas?|seasons?|temp|t)[\s._-]*(\d{1,3})[\s._-]*(?:capitulos?|cap|episodios?|episodes?|ep|e)[\s._-]*(\d{1,4})\b[\s._-]*(.*)$/i,
];

const cleanTitle = (value) => value.replace(/[\s._-]+$/, '').replace(/^[\s._-]+/, '').trim();

/**
 * Splits an episode entry into series title, season and episode so every
 * chapter of a show collapses into a single poster.
 */
const parseEpisode = (name) => {
  for (const pattern of EPISODE_PATTERNS) {
    const match = pattern.exec(name);
    if (!match) continue;
    const title = cleanTitle(match[1]);
    if (!title) continue;
    return {
      seriesTitle: title,
      season: Number(match[2]),
      episode: Number(match[3]),
      episodeTitle: cleanTitle(match[4] || '') || null,
    };
  }
  return null;
};

// Entries without a recognizable episode marker become a one-episode show, so
// nothing disappears from the series catalog.
const seriesInfo = (episode, name, group) => {
  const title = episode ? episode.seriesTitle : name;
  const key = normalizeName(title) || normalizeName(name);
  return {
    key: `${key}|${group || ''}`,
    title,
    searchTitle: key,
    season: episode ? episode.season : 1,
    episode: episode ? episode.episode : 1,
    episodeTitle: episode ? episode.episodeTitle : null,
  };
};

/**
 * Streams an M3U playlist of arbitrary size, yielding one parsed entry at a
 * time. Only a single line is held in memory beyond the incoming chunk, so a
 * multi-hundred-megabyte playlist parses in constant memory.
 *
 * @param {AsyncIterable<Buffer|Uint8Array>} source
 */
async function* parseM3u(source) {
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let pending = null;
  let pendingGroup = null;
  let pendingUserAgent = null;
  let position = 0;

  const handleLine = (rawLine) => {
    const line = rawLine.trim();
    if (!line) return null;

    if (line.startsWith('#EXTINF')) {
      pending = parseExtinf(line);
      return null;
    }
    if (line.startsWith('#EXTGRP')) {
      pendingGroup = line.slice(line.indexOf(':') + 1).trim();
      return null;
    }
    if (line.startsWith('#EXTVLCOPT')) {
      const value = line.slice(line.indexOf(':') + 1).trim();
      const [key, ...rest] = value.split('=');
      if (key.toLowerCase() === 'http-user-agent') pendingUserAgent = rest.join('=');
      return null;
    }
    if (line.startsWith('#')) return null;

    const entry = pending;
    const group = (entry && entry.attrs['group-title']) || pendingGroup || 'Sin grupo';
    const name = (entry && entry.name) || (entry && entry.attrs['tvg-name']) || line;
    const attrs = entry ? entry.attrs : {};
    pending = null;
    pendingGroup = null;
    const userAgent = pendingUserAgent;
    pendingUserAgent = null;

    const type = detectType(group, line);
    const episode = type === 'series' ? parseEpisode(name) : null;

    return {
      type,
      extId: attrs['tvg-id'] || null,
      name,
      searchName: normalizeName(name),
      group,
      logo: attrs['tvg-logo'] || attrs['logo'] || null,
      url: line,
      position: position++,
      attrs: userAgent ? { ...attrs, 'http-user-agent': userAgent } : attrs,
      series: type === 'series' ? seriesInfo(episode, name, group) : null,
    };
  };

  for await (const chunk of source) {
    buffer += decoder.decode(chunk, { stream: true });
    let newlineIndex = buffer.indexOf('\n');
    while (newlineIndex !== -1) {
      const item = handleLine(buffer.slice(0, newlineIndex));
      if (item) yield item;
      buffer = buffer.slice(newlineIndex + 1);
      newlineIndex = buffer.indexOf('\n');
    }
  }
  buffer += decoder.decode();
  if (buffer) {
    const item = handleLine(buffer);
    if (item) yield item;
  }
}

module.exports = { parseM3u, normalizeName, detectType, parseEpisode };
