'use strict';

const express = require('express');
const { postFactura } = require('../controllers/facturas.controller');

const router = express.Router();

router.post('/facturas', postFactura);

module.exports = router;
