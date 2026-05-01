'use strict';

const { LiorenService, LiorenError } = require('../services/LiorenService');

const liorenService = new LiorenService();

function normalizeError(error) {
  if (error instanceof LiorenError) {
    return {
      status: error.status || 500,
      body: {
        ok: false,
        code: error.code,
        message: error.message,
        details: error.details,
      },
    };
  }

  return {
    status: 500,
    body: {
      ok: false,
      code: 'INTERNAL_ERROR',
      message: 'Error interno al emitir documento tributario',
    },
  };
}

/**
 * POST /api/facturas
 *
 * body.tipo_documento:
 * - factura
 * - factura_exenta
 * - boleta
 */
async function postFactura(req, res) {
  try {
    const tipo = String(req.body?.tipo_documento || req.body?.tipoDocumento || 'factura').toLowerCase();

    let result;
    if (tipo === 'factura') {
      result = await liorenService.emitirFactura(req.body);
    } else if (tipo === 'factura_exenta' || tipo === 'factura-exenta') {
      result = await liorenService.emitirFacturaExenta(req.body);
    } else if (tipo === 'boleta') {
      result = await liorenService.emitirBoleta(req.body);
    } else {
      return res.status(400).json({
        ok: false,
        code: 'INVALID_DOCUMENT_TYPE',
        message: 'tipo_documento debe ser factura, factura_exenta o boleta',
      });
    }

    return res.status(201).json({
      ok: true,
      data: result,
    });
  } catch (error) {
    req.log?.error?.(
      {
        err: {
          name: error.name,
          message: error.message,
          code: error.code,
          status: error.status,
        },
      },
      'Error emitiendo DTE Lioren'
    );

    const normalized = normalizeError(error);
    return res.status(normalized.status).json(normalized.body);
  }
}

module.exports = {
  postFactura,
};
