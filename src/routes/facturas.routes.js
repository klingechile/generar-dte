'use strict';

const express = require('express');

const {
  postFactura,
  debugFacturaBody,
  previewLiorenPayload
} = require('../controllers/facturas.controller');

const router = express.Router();

// Diagnóstico seguro: NO llama a Lioren.
router.post('/facturas/debug-body', debugFacturaBody);

// Preview seguro: arma el payload que se enviaría a Lioren, pero NO emite.
router.post('/facturas/preview-lioren', previewLiorenPayload);

// Emisión real.
router.post('/facturas', postFactura);

module.exports = router;
