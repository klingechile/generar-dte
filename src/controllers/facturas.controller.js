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

  buildPayload(data, tipoDte, exentoDocumento) {
    const fecha = firstDefined(
      data.emisor?.fecha,
      data.fecha,
      data.fecha_emision,
      new Date().toISOString().slice(0, 10)
    );

    const rutEmisor = firstDefined(
      data.emisor?.rut,
      data.rut_emisor,
      process.env.LIOREN_RUT_EMISOR
    );

    if (!rutEmisor) {
      throw new LiorenError('LIOREN_RUT_EMISOR no está configurado', {
        status: 500,
        code: 'LIOREN_RUT_EMISOR_MISSING'
      });
    }

    /*
     * Caso 1:
     * El frontend ya manda formato directo Lioren:
     * emisor + receptor + detalles + expects
     */
    if (
      data.emisor &&
      data.receptor &&
      Array.isArray(data.detalles) &&
      data.detalles.length > 0
    ) {
      const detallesDirectos = data.detalles.map((item, index) => {
        const cantidad = toNumber(
          firstDefined(item.cantidad, item.qty, item.QtyItem, item.quantity),
          1
        );

        const precio = round(
          firstDefined(
            item.precio,
            item.precio_unitario,
            item.PrcItem,
            item.price,
            item.monto_unitario,
            0
          )
        );

        const descuento = round(
          firstDefined(item.descuento, item.descuento_monto, item.discount, 0)
        );

        const monto = round(
          firstDefined(item.monto, item.total, cantidad * precio - descuento)
        );

        return {
          codigo: normalizeItemCode(item, index),
          nombre: firstDefined(
            item.nombre,
            item.descripcion,
            item.NmbItem,
            item.name,
            item.sku,
            `Item ${index + 1}`
          ),
          cantidad,
          precio,
          exento: Boolean(firstDefined(item.exento, exentoDocumento)),
          monto
        };
      });

      const payloadDirecto = {
        emisor: {
          rut: cleanRut(rutEmisor),
          tipodoc: String(tipoDte || data.emisor.tipodoc || data.emisor.tipo),
          fecha
        },
        receptor: {
          rut: cleanRut(
            firstDefined(
              data.receptor.rut,
              data.receptor.RUTRecep,
              tipoDte === 39 ? '66666666-6' : ''
            )
          ),
          rs: firstDefined(
            data.receptor.rs,
            data.receptor.razon_social,
            data.receptor.razonSocial,
            data.receptor.nombre,
            tipoDte === 39 ? 'Consumidor final' : ''
          ),
          giro: firstDefined(
            data.receptor.giro,
            data.receptor.GiroRecep,
            tipoDte === 39 ? 'Particular' : 'Sin giro informado'
          ),
          comuna: Number(
            firstDefined(
              data.receptor.comuna,
              data.receptor.comuna_id,
              process.env.LIOREN_DEFAULT_COMUNA_ID,
              95
            )
          ),
          ciudad: Number(
            firstDefined(
              data.receptor.ciudad,
              data.receptor.ciudad_id,
              process.env.LIOREN_DEFAULT_CIUDAD_ID,
              76
            )
          ),
          direccion: firstDefined(
            data.receptor.direccion,
            data.receptor.DirRecep,
            tipoDte === 39 ? 'Sin dirección' : 'Sin dirección informada'
          )
        },
        detalles: detallesDirectos,
        expects: normalizeExpects(
          firstDefined(
            data.expects,
            data.formato_documento,
            data.formatoDocumento,
            process.env.LIOREN_EXPECTS,
            'pdf'
          )
        )
      };

      const folioDirecto = firstDefined(data.folio, data.emisor?.folio);

      if (folioDirecto !== undefined && folioDirecto !== null && folioDirecto !== '') {
        payloadDirecto.folio = Number(folioDirecto);
      }

      return payloadDirecto;
    }

    /*
     * Caso 2:
     * Formato CRM:
     * cliente + productos
     */
    const cliente = data.cliente || data.receptor || {};
    const productos = normalizeItems(data);

    if (!productos.length) {
      throw new LiorenError('Debe incluir al menos un producto', {
        status: 400,
        code: 'NO_ITEMS',
        details: {
          body_keys: data && typeof data === 'object' ? Object.keys(data) : [],
          accepted_item_keys: [
            'productos',
            'items',
            'detalle',
            'detalles',
            'lineas',
            'documento.detalle',
            'data.productos'
          ]
        }
      });
    }

    const comuna = Number(
      firstDefined(
        cliente.comuna,
        cliente.comuna_id,
        cliente.comunaId,
        cliente.CmnaRecep,
        process.env.LIOREN_DEFAULT_COMUNA_ID,
        95
      )
    );

    const ciudad = Number(
      firstDefined(
        cliente.ciudad,
        cliente.ciudad_id,
        cliente.ciudadId,
        cliente.CiudadRecep,
        process.env.LIOREN_DEFAULT_CIUDAD_ID,
        76
      )
    );

    const razonSocial = firstDefined(
      cliente.rs,
      cliente.razon_social,
      cliente.razonSocial,
      cliente.nombre,
      cliente.RznSocRecep,
      tipoDte === 39 ? 'Consumidor final' : ''
    );

    const detalles = productos.map((item, index) => {
      const cantidad = toNumber(
        firstDefined(item.cantidad, item.qty, item.QtyItem, item.quantity),
        1
      );

      const precio = round(
        firstDefined(
          item.precio,
          item.precio_unitario,
          item.PrcItem,
          item.price,
          item.monto_unitario,
          0
        )
      );

      const descuento = round(
        firstDefined(item.descuento, item.descuento_monto, item.discount, 0)
      );

      const monto = round(
        firstDefined(item.monto, item.total, cantidad * precio - descuento)
      );

      const nombre = firstDefined(
        item.nombre,
        item.descripcion,
        item.NmbItem,
        item.name,
        item.sku,
        `Item ${index + 1}`
      );

      return {
        codigo: normalizeItemCode(item, index),
        nombre,
        cantidad,
        precio,
        exento: Boolean(firstDefined(item.exento, exentoDocumento)),
        monto
      };
    });

    const payload = {
      emisor: {
        rut: cleanRut(rutEmisor),
        tipodoc: String(tipoDte),
        fecha
      },
      receptor: {
        rut: cleanRut(
          firstDefined(
            cliente.rut,
            cliente.RUTRecep,
            tipoDte === 39 ? '66666666-6' : ''
          )
        ),
        rs: razonSocial,
        giro: firstDefined(
          cliente.giro,
          cliente.GiroRecep,
          tipoDte === 39 ? 'Particular' : 'Sin giro informado'
        ),
        comuna,
        ciudad,
        direccion: firstDefined(
          cliente.direccion,
          cliente.DirRecep,
          tipoDte === 39 ? 'Sin dirección' : 'Sin dirección informada'
        )
      },
      detalles,
      expects: normalizeExpects(
        firstDefined(
          data.expects,
          data.formato_documento,
          data.formatoDocumento,
          process.env.LIOREN_EXPECTS,
          'pdf'
        )
      )
    };

    const folio = firstDefined(data.folio, data.emisor?.folio);

    if (folio !== undefined && folio !== null && folio !== '') {
      payload.folio = Number(folio);
    }

    return payload;
  }

  const rutEmisor = firstDefined(
    data.emisor?.rut,
    data.rut_emisor,
    process.env.LIOREN_RUT_EMISOR
  );

  if (!rutEmisor) {
    throw new LiorenError('LIOREN_RUT_EMISOR no está configurado', {
      status: 500,
      code: 'LIOREN_RUT_EMISOR_MISSING'
    });
  }

  /**
   * Caso 1:
   * El frontend ya manda formato Lioren directo:
   * emisor + receptor + detalles + expects
   */
  if (
    data.emisor &&
    data.receptor &&
    Array.isArray(data.detalles) &&
    data.detalles.length > 0
  ) {
    const detallesDirectos = data.detalles.map((item, index) => {
      const cantidad = toNumber(
        firstDefined(item.cantidad, item.qty, item.QtyItem, item.quantity),
        1
      );

      const precio = round(
        firstDefined(
          item.precio,
          item.precio_unitario,
          item.PrcItem,
          item.price,
          item.monto_unitario,
          0
        )
      );

      const descuento = round(
        firstDefined(item.descuento, item.descuento_monto, item.discount, 0)
      );

      const monto = round(
        firstDefined(item.monto, item.total, cantidad * precio - descuento)
      );

      return {
        codigo: normalizeItemCode(item, index),
        nombre: firstDefined(
          item.nombre,
          item.descripcion,
          item.NmbItem,
          item.name,
          item.sku,
          `Item ${index + 1}`
        ),
        cantidad,
        precio,
        exento: Boolean(firstDefined(item.exento, exentoDocumento)),
        monto
      };
    });

    return {
      emisor: {
        rut: cleanRut(rutEmisor),
        tipodoc: String(tipoDte || data.emisor.tipodoc || data.emisor.tipo),
        fecha
      },
      receptor: {
        rut: cleanRut(
          firstDefined(
            data.receptor.rut,
            data.receptor.RUTRecep,
            tipoDte === 39 ? '66666666-6' : ''
          )
        ),
        rs: firstDefined(
          data.receptor.rs,
          data.receptor.razon_social,
          data.receptor.razonSocial,
          data.receptor.nombre,
          tipoDte === 39 ? 'Consumidor final' : ''
        ),
        giro: firstDefined(
          data.receptor.giro,
          data.receptor.GiroRecep,
          tipoDte === 39 ? 'Particular' : 'Sin giro informado'
        ),
        comuna: Number(
          firstDefined(
            data.receptor.comuna,
            data.receptor.comuna_id,
            process.env.LIOREN_DEFAULT_COMUNA_ID,
            95
          )
        ),
        ciudad: Number(
          firstDefined(
            data.receptor.ciudad,
            data.receptor.ciudad_id,
            process.env.LIOREN_DEFAULT_CIUDAD_ID,
            76
          )
        ),
        direccion: firstDefined(
          data.receptor.direccion,
          data.receptor.DirRecep,
          tipoDte === 39 ? 'Sin dirección' : 'Sin dirección informada'
        )
      },
      detalles: detallesDirectos,
      expects: normalizeExpects(
        firstDefined(
          data.expects,
          data.formato_documento,
          data.formatoDocumento,
          process.env.LIOREN_EXPECTS,
          'pdf'
        )
      )
    };
  }

  /**
   * Caso 2:
   * Formato CRM: cliente + productos
   */
  const cliente = data.cliente || data.receptor || {};
  const productos = normalizeItems(data);

  if (!productos.length) {
    throw new LiorenError('Debe incluir al menos un producto', {
      status: 400,
      code: 'NO_ITEMS',
      details: {
        body_keys: data && typeof data === 'object' ? Object.keys(data) : [],
        accepted_item_keys: [
          'productos',
          'items',
          'detalle',
          'detalles',
          'lineas',
          'documento.detalle',
          'data.productos'
        ]
      }
    });
  }

  const comuna = Number(
    firstDefined(
      cliente.comuna,
      cliente.comuna_id,
      cliente.comunaId,
      cliente.CmnaRecep,
      process.env.LIOREN_DEFAULT_COMUNA_ID,
      95
    )
  );

  const ciudad = Number(
    firstDefined(
      cliente.ciudad,
      cliente.ciudad_id,
      cliente.ciudadId,
      cliente.CiudadRecep,
      process.env.LIOREN_DEFAULT_CIUDAD_ID,
      76
    )
  );

  const razonSocial = firstDefined(
    cliente.rs,
    cliente.razon_social,
    cliente.razonSocial,
    cliente.nombre,
    cliente.RznSocRecep,
    tipoDte === 39 ? 'Consumidor final' : ''
  );

  const detalles = productos.map((item, index) => {
    const cantidad = toNumber(
      firstDefined(item.cantidad, item.qty, item.QtyItem, item.quantity),
      1
    );

    const precio = round(
      firstDefined(
        item.precio,
        item.precio_unitario,
        item.PrcItem,
        item.price,
        item.monto_unitario,
        0
      )
    );

    const descuento = round(
      firstDefined(item.descuento, item.descuento_monto, item.discount, 0)
    );

    const monto = round(
      firstDefined(item.monto, item.total, cantidad * precio - descuento)
    );

    const nombre = firstDefined(
      item.nombre,
      item.descripcion,
      item.NmbItem,
      item.name,
      item.sku,
      `Item ${index + 1}`
    );

    return {
      codigo: normalizeItemCode(item, index),
      nombre,
      cantidad,
      precio,
      exento: Boolean(firstDefined(item.exento, exentoDocumento)),
      monto
    };
  });

  const payload = {
    emisor: {
      rut: cleanRut(rutEmisor),
      tipodoc: String(tipoDte),
      fecha
    },
    receptor: {
      rut: cleanRut(
        firstDefined(
          cliente.rut,
          cliente.RUTRecep,
          tipoDte === 39 ? '66666666-6' : ''
        )
      ),
      rs: razonSocial,
      giro: firstDefined(
        cliente.giro,
        cliente.GiroRecep,
        tipoDte === 39 ? 'Particular' : 'Sin giro informado'
      ),
      comuna,
      ciudad,
      direccion: firstDefined(
        cliente.direccion,
        cliente.DirRecep,
        tipoDte === 39 ? 'Sin dirección' : 'Sin dirección informada'
      )
    },
    detalles,
    expects: normalizeExpects(
      firstDefined(
        data.expects,
        data.formato_documento,
        data.formatoDocumento,
        process.env.LIOREN_EXPECTS,
        'pdf'
      )
    )
  };

  const folio = firstDefined(data.folio, data.emisor?.folio);

  if (folio !== undefined && folio !== null && folio !== '') {
    payload.folio = Number(folio);
  }

  return payload;
}

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
      status: error.status
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
