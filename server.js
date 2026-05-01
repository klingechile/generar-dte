'use strict';

require('dotenv').config();

const express = require('express');
const facturasRoutes = require('./src/routes/facturas.routes');

const app = express();

app.use(express.json({ limit: '1mb' }));

// Nunca exponer LIOREN_BEARER_TOKEN al frontend.
// El frontend llama este endpoint interno; el backend firma la solicitud hacia Lioren.
app.use('/api', facturasRoutes);

app.use((err, req, res, next) => {
  console.error('Unhandled error', { message: err.message, name: err.name });
  res.status(500).json({ ok: false, message: 'Error interno' });
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`API Klinge escuchando en puerto ${port}`);
});
