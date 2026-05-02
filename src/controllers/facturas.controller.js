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

function maybeParseJson(value) {
  if (typeof value !== 'string') return value;

  const trimmed = value.trim();
  if (!trimmed) return value;

  if (
    (trimmed.startsWith('[') && trimmed.endsWith(']')) ||
    (trimmed.startsWith('{') && trimmed.endsWith('}'))
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return value;
    }
  }

  return value;
}

function objectValuesIfNumericObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

  const keys = Object.keys(value);
  if (!keys.length) return null;

  const allNumericKeys = keys.every((key) => /^\d+$/.test(key));
  if (!allNumericKeys) return null;

  return keys
    .sort((a, b) => Number(a) - Number(b))
    .map((key) => value[key]);
}

function normalizeProductos(body) {
  const candidates = [
    body.productos,
    body.items,
    body.detalle,
    body.detalles,
    body.lineas,
    body.lines,
    body.products,
    body.producto,
    body.item
  ];

  for (const candidate of candidates) {
    const source = maybeParseJson(candidate);

    if (Array.isArray(source) && source.length > 0) return source;

    const numericValues = objectValuesIfNumericObject(source);
    if (Array.isArray(numericValues) && numericValues.length > 0) return numericValues;

    if (source && typeof source === 'object' && !Array.isArray(source)) return [source];
  }

  return [];
}

function normalizeCliente(body) {
  const rawCliente = maybeParseJson(body.cliente) || maybeParseJson(body.receptor) || {};
  const cliente = rawCliente && typeof rawCliente === 'object' ? rawCliente : {};

  return {
    nombre: firstDefined(
      cliente.nombre,
      cliente.razon_social,
      cliente.razonSocial,
      cliente.rs,
      cliente.RznSocRecep,
      'Consumidor final'
    ),
    rut: firstDefined(
      cliente.rut,
      cliente.RUTRecep,
      '66666666-6'
    ),
    razon_social: firstDefined(
      cliente.razon_social,
      cliente.razonSocial,
      cliente.rs,
      cliente.nombre,
      cliente.RznSocRecep,
      'Consumidor final'
    ),
    giro: firstDefined(
      cliente.giro,
      cliente.GiroRecep,
      'Sin giro informado'
    ),
    direccion: firstDefined(
      cliente.direccion,
      cliente.DirRecep,
      'Sin dirección informada'
    ),
    comuna: firstDefined(
      cliente.comuna,
      cliente.CmnaRecep,
      process.env.LIOREN_DEFAULT_COMUNA_ID,
      95
    ),
    ciudad: firstDefined(
      cliente.ciudad,
      cliente.CiudadRecep,
      process.env.LIOREN_DEFAULT_CIUDAD_ID,
      76
    ),
    email: firstDefined(cliente.email, cliente.correo, ''),
    telefono: firstDefined(cliente.telefono, cliente.phone, '')
  };
}

function inferTipoDocumento(body) {
  const explicit = firstDefined(
    body.tipo_documento,
    body.tipoDocumento,
    body.doc_type,
    body.documento_solicitado
  );

  if (explicit) {
    const value = String(explicit).toLowerCase().trim();

    if (value === '39') return 'boleta';
    if (value === '34') return 'factura_exenta';
    if (value === '33') return 'factura';

    return value;
  }

  const tipodoc = String(
    firstDefined(
      body.emisor?.tipodoc,
      body.emisor?.tipo,
      body.tipo,
      ''
    )
  ).trim();

  if (tipodoc === '39') return 'boleta';
  if (tipodoc === '34') return 'factura_exenta';
  if (tipodoc === '33') return 'factura';

  return 'factura';
}

function normalizeDocumentoRequest(rawBody) {
  const body = rawBody || {};
  const productos = normalizeProductos(body);

  return {
    ...body,
    tipo_documento: inferTipoDocumento(body),
    cliente: normalizeCliente(body),
    productos
  };
}

function buildBodyDiagnostics(req, rawBody, normalizedBody) {
  const productosRaw = rawBody?.productos;
  const clienteRaw = rawBody?.cliente;

  return {
    content_type_seen: req.headers['content-type'] || null,
    raw_body_type: typeof rawBody,
    body_keys: rawBody && typeof rawBody === 'object' ? Object.keys(rawBody) : [],
    inferred_tipo_documento: normalizedBody.tipo_documento,
    emisor_tipodoc: rawBody?.emisor?.tipodoc || null,

    productos_raw_type: Array.isArray(productosRaw) ? 'array' : typeof productosRaw,
    productos_raw_is_array: Array.isArray(productosRaw),
    productos_raw_length: Array.isArray(productosRaw) ? productosRaw.length : undefined,
    productos_raw_preview: Array.isArray(productosRaw) ? productosRaw.slice(0, 2) : productosRaw,

    cliente_raw_type: typeof clienteRaw,
    cliente_raw_preview: clienteRaw,

    productos_normalizados_type: Array.isArray(normalizedBody.productos)
      ? 'array'
      : typeof normalizedBody.productos,
    productos_normalizados_length: Array.isArray(normalizedBody.productos)
      ? normalizedBody.productos.length
      : undefined,
    productos_normalizados_preview: Array.isArray(normalizedBody.productos)
      ? normalizedBody.productos.slice(0, 2)
      : normalizedBody.productos,

    cliente_normalizado: normalizedBody.cliente
  };
}

function tipoToDte(tipo) {
  if (tipo === 'boleta') {
    return { tipoDte: 39, exentoDocumento: false };
  }

  if (tipo === 'factura_exenta' || tipo === 'factura-exenta') {
    return { tipoDte: 34, exentoDocumento: true };
  }

  return { tipoDte: 33, exentoDocumento: false };
}

async function debugFacturaBody(req, res) {
  const rawBody = parseBody(req);
  const body = normalizeDocumentoRequest(rawBody);
  const diagnostics = buildBodyDiagnostics(req, rawBody, body);

  return res.status(200).json({
    ok: true,
    message: 'Diagnóstico de body recibido. No se llamó a Lioren.',
    diagnostics
  });
}

async function previewLiorenPayload(req, res) {
  try {
    const rawBody = parseBody(req);
    const body = normalizeDocumentoRequest(rawBody);
    const { tipoDte, exentoDocumento } = tipoToDte(body.tipo_documento);

    const liorenPayload = liorenService.buildPayload(body, tipoDte, exentoDocumento);
    const endpoint = body.tipo_documento === 'boleta' ? '/api/boletas' : '/api/dtes';

    return res.status(200).json({
      ok: true,
      message: 'Preview seguro. No se llamó a Lioren.',
      tipo_documento: body.tipo_documento,
      tipo_dte: tipoDte,
      endpoint_sugerido: endpoint,
      diagnostics: buildBodyDiagnostics(req, rawBody, body),
      lioren_payload: liorenPayload
    });
  } catch (error) {
    const normalized = normalizeError(error);
    return res.status(normalized.status).json(normalized.body);
  }
}

async function postFactura(req, res) {
  try {
    const rawBody = parseBody(req);
    const body = normalizeDocumentoRequest(rawBody);
    const diagnostics = buildBodyDiagnostics(req, rawBody, body);

    console.log('Solicitud DTE recibida', {
      tipo_documento: body.tipo_documento,
      emisor_tipodoc: rawBody?.emisor?.tipodoc || null,
      body_keys: diagnostics.body_keys,
      productos_raw_type: diagnostics.productos_raw_type,
      productos_raw_length: diagnostics.productos_raw_length,
      productos_normalizados_length: diagnostics.productos_normalizados_length,
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
        message: 'tipo_documento debe ser factura, factura_exenta o boleta',
        diagnostics
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
      status: error.status,
      details: error.details
    });

    const normalized = normalizeError(error);
    return res.status(normalized.status).json(normalized.body);
  }
}

module.exports = {
  postFactura,
  debugFacturaBody,
  previewLiorenPayload
};
