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
        details: error.details
      }
    };
  }

  return {
    status: 500,
    body: {
      ok: false,
      code: 'INTERNAL_ERROR',
      message: 'Error interno al emitir documento tributario'
    }
  };
}

function parseBody(req) {
  if (!req.body) return {};

  if (typeof req.body === 'string') {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }

  return req.body;
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '');
}

function normalizeProductos(body) {
  const source = firstDefined(
    body.productos,
    body.items,
    body.detalle,
    body.detalles,
    body.lineas,
    body.lines,
    body.products
  );

  if (Array.isArray(source)) {
    return source;
  }

  if (source && typeof source === 'object') {
    return [source];
  }

  if (body.producto && typeof body.producto === 'object') {
    return [body.producto];
  }

  return [];
}

function normalizeCliente(body) {
  const cliente = body.cliente || body.receptor || {};

  return {
    nombre: firstDefined(cliente.nombre, cliente.razon_social, cliente.razonSocial, cliente.RznSocRecep, 'Consumidor final'),
    rut: firstDefined(cliente.rut, cliente.RUTRecep, '66666666-6'),
    razon_social: firstDefined(cliente.razon_social, cliente.razonSocial, cliente.nombre, cliente.RznSocRecep, 'Consumidor final'),
    giro: firstDefined(cliente.giro, cliente.GiroRecep, 'Sin giro informado'),
    direccion: firstDefined(cliente.direccion, cliente.DirRecep, 'Sin dirección informada'),
    comuna: firstDefined(cliente.comuna, cliente.CmnaRecep, 'Santiago'),
    ciudad: firstDefined(cliente.ciudad, cliente.CiudadRecep, cliente.comuna, 'Santiago'),
    email: firstDefined(cliente.email, cliente.correo, ''),
    telefono: firstDefined(cliente.telefono, cliente.phone, '')
  };
}

function normalizeDocumentoRequest(rawBody) {
  const body = rawBody || {};

  const productos = normalizeProductos(body);

  return {
    ...body,
    tipo_documento: String(
      firstDefined(body.tipo_documento, body.tipoDocumento, body.doc_type, 'factura')
    ).toLowerCase(),
    cliente: normalizeCliente(body),
    productos
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
    const rawBody = parseBody(req);
    const body = normalizeDocumentoRequest(rawBody);

    console.log('Solicitud DTE recibida', {
      tipo_documento: body.tipo_documento,
      productos: Array.isArray(body.productos) ? body.productos.length : 0,
      cliente_rut: body.cliente?.rut || null
    });

    const tipo = body.tipo_documento;

    let result;

    if (tipo === 'factura') {
      result = await liorenService.emitirFactura(body);
    } else if (tipo === 'factura_exenta' || tipo === 'factura-exenta') {
      result = await liorenService.emitirFacturaExenta(body);
    } else if (tipo === 'boleta') {
      result = await liorenService.emitirBoleta(body);
    } else {
      return res.status(400).json({
        ok: false,
        code: 'INVALID_DOCUMENT_TYPE',
        message: 'tipo_documento debe ser factura, factura_exenta o boleta'
      });
    }

    return res.status(201).json({
      ok: true,
      data: result
    });
  } catch (error) {
    console.error('Error emitiendo DTE Lioren', {
      name: error.name,
      message: error.message,
      code: error.code,
      status: error.status
    });

    const normalized = normalizeError(error);
    return res.status(normalized.status).json(normalized.body);
  }
}

module.exports = {
  postFactura
};
