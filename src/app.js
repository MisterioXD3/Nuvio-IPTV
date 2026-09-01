'use strict';

const path = require('path');
const express = require('express');
const compression = require('compression');

const addon = require('./addon/routes');
const apiRouter = require('./web/api');

const createApp = () => {
  const app = express();

  app.disable('x-powered-by');
  app.set('etag', 'strong');
  app.use(compression());

  app.use('/api', apiRouter);
  app.use('/configure', express.static(path.join(__dirname, 'web', 'public'), { maxAge: '1h' }));
  app.get('/health', (req, res) => res.json({ ok: true, uptime: process.uptime() }));
  app.get('/', (req, res) => res.redirect('/configure/'));
  app.use('/', addon.router);
  app.use((req, res) => res.status(404).json({ error: 'No encontrado' }));

  return app;
};

module.exports = { createApp };
