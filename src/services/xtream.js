'use strict';

const config = require('../config');
const buildBase = (url) => url.replace(/\/+$/, '').replace(/\/(get|player_api)\.php.*$/i, '');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const playlistUrl = (playlist) => {
  const base = buildBase(playlist.url);
  const params = new URLSearchParams({
    username: playlist.username || '',
    password: playlist.password || '',
    type: 'm3u_plus',
    output: 'ts',
  });
  return `${base}/get.php?${params.toString()}`;
};

/**
 * Reads the Xtream Codes account info so the UI can show the real subscription
 * expiry instead of a manually typed one.
 */
const fetchAccountInfo = async (playlist, { signal, userAgent } = {}) => {
  const base = buildBase(playlist.url);
  const params = new URLSearchParams({
    username: playlist.username || '',
    password: playlist.password || '',
  });
  let response;
  for (let attempt = 0; attempt <= config.syncRetries; attempt += 1) {
    response = await fetch(`${base}/player_api.php?${params.toString()}`, {
      signal,
      headers: { accept: 'application/json', 'user-agent': userAgent || config.defaultUserAgent },
    });
    if (response.ok || ![408, 425, 429, 500, 502, 503, 504].includes(response.status) || attempt === config.syncRetries) break;
    await wait(Math.min(config.syncRetryBaseMs * (2 ** attempt), 30000));
  }
  if (!response.ok) throw new Error(`player_api respondió ${response.status}`);
  const payload = await response.json();
  const info = payload && payload.user_info;
  if (!info) return null;
  return {
    status: info.status || null,
    expiresAt: info.exp_date ? new Date(Number(info.exp_date) * 1000).toISOString() : null,
    maxConnections: info.max_connections ? Number(info.max_connections) : null,
    activeConnections: info.active_cons != null ? Number(info.active_cons) : null,
  };
};

module.exports = { playlistUrl, fetchAccountInfo, buildBase };
