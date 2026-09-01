'use strict';

const config = require('./config');
const { createApp } = require('./app');
const scheduler = require('./services/scheduler');

const server = createApp().listen(config.port, config.host, () => {
  console.log(`[nuvio-iptv] escuchando en http://${config.host}:${config.port}`);
  console.log(`[nuvio-iptv] manifest: http://${config.host}:${config.port}/manifest.json`);
  console.log(`[nuvio-iptv] configuración: http://${config.host}:${config.port}/configure/`);
  scheduler.start();
});

const shutdown = () => server.close(() => process.exit(0));
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
