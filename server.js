'use strict';

require('dotenv').config();

const express = require('express');
const facturasRoutes = require('./src/routes/facturas.routes');

const app = express();

app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

// CORS mínimo para que el CRM pueda llamar el backend desde el navegador.
app.use((req, res, next) => {
  const allowedOrigin = process.env.CORS_ORIGIN || '*';
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Accept');

  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }

  return next();
});

// Rutas de salud requeridas por Railway.
app.get('/', (req, res) => {
  res.status(200).json({
    ok: true,
    service: 'generar-dte',
    message: 'API Klinge DTE activa',
  });
});

app.get('/health', (req, res) => {
  res.status(200).json({
    ok: true,
    service: 'generar-dte',
    has_lioren_token: Boolean(process.env.LIOREN_BEARER_TOKEN),
  });
});

app.get('/healthz', (req, res) => {
  res.status(200).json({ ok: true });
});

// Nunca exponer LIOREN_BEARER_TOKEN al frontend.
// El frontend llama este endpoint interno; el backend firma la solicitud hacia Lioren.
app.use('/api', facturasRoutes);

app.use((req, res) => {
  res.status(404).json({
    ok: false,
    code: 'NOT_FOUND',
    message: `Ruta no encontrada: ${req.method} ${req.originalUrl}`,
  });
});

app.use((err, req, res, next) => {
  console.error('Unhandled error', { message: err.message, name: err.name });
  res.status(500).json({ ok: false, message: 'Error interno' });
});

const port = Number(process.env.PORT || 3000);
const server = app.listen(port, '0.0.0.0', () => {
  console.log(`API Klinge escuchando en puerto ${port}`);
});

process.on('SIGTERM', () => {
  console.log('SIGTERM recibido, cerrando servidor HTTP');
  server.close(() => process.exit(0));
});
