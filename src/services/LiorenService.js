'use strict';

const DEFAULT_BASE_URL = 'https://www.lioren.cl';
const DEFAULT_DTE_PATH = '/api/dtes';
const DEFAULT_BOLETA_PATH = '/api/boletas';
const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_MAX_RETRIES = 2;

const RETRY_STATUS_CODES = new Set([500, 502, 503, 504]);
const NON_RETRY_STATUS_CODES = new Set([400, 401, 403, 404, 422]);

class LiorenError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'LiorenError';
    this.status = options.status || 500;
    this.code = options.code || 'LIOREN_ERROR';
    this.details = options.details || null;
    this.retryable = Boolean(options.retryable);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function round(value) {
  return Math.round(toNumber(value));
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '');
}

function cleanRut(rut) {
  return String(rut || '').replace(/\./g, '').trim();
}

function normalizeItemCode(item, index) {
  const rawCode = firstDefined(item.codigo, item.sku, item.code, '');
  const code = String(rawCode || '').trim();

  if (code.length >= 3) {
    return code.slice(0, 80);
  }

  return `ITEM-${String(index + 1).padStart(3, '0')}`;
}

function normalizeExpects(value) {
  const expects = String(value || '').toLowerCase().trim();

  if (['xml', 'pdf', 'all'].includes(expects)) {
    return expects;
  }

  return 'pdf';
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

function getByPath(obj, path) {
  return String(path)
    .split('.')
    .reduce((acc, key) => (acc && acc[key] !== undefined ? acc[key] : undefined), obj);
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

function normalizeItems(input) {
  const paths = [
    'productos',
    'items',
    'detalle',
    'detalles',
    'lineas',
    'lines',
    'products',
    'documento.detalle',
    'documento.detalles',
    'documento.items',
    'dte.detalle',
    'dte.detalles',
    'payload.productos',
    'payload.items',
    'payload.detalle',
    'data.productos',
    'data.items',
    'data.detalle'
  ];

  for (const path of paths) {
    const value = maybeParseJson(getByPath(input, path));

    if (Array.isArray(value) && value.length > 0) {
      return value;
    }

    const numericValues = objectValuesIfNumericObject(value);
    if (Array.isArray(numericValues) && numericValues.length > 0) {
      return numericValues;
    }

    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return [value];
    }
  }

  const singleProduct = maybeParseJson(input?.producto || input?.item);

  if (Array.isArray(singleProduct) && singleProduct.length > 0) {
    return singleProduct;
  }

  if (singleProduct && typeof singleProduct === 'object') {
    return [singleProduct];
  }

  return [];
}

function sanitizeForLog(payload) {
  if (!payload || typeof payload !== 'object') return payload;

  const clone = JSON.parse(JSON.stringify(payload));
  const redactKeys = new Set([
    'authorization',
    'token',
    'bearer',
    'password',
    'secret',
    'api_key',
    'apikey'
  ]);

  function walk(obj) {
    if (!obj || typeof obj !== 'object') return;

    Object.keys(obj).forEach((key) => {
      if (redactKeys.has(String(key).toLowerCase())) {
        obj[key] = '[REDACTED]';
      } else {
        walk(obj[key]);
      }
    });
  }

  walk(clone);
  return clone;
}

function normalizeLiorenResponse(response) {
  const data = response?.data || response?.dte || response?.documento || response || {};

  return {
    estado: firstDefined(
      data.estado,
      data.status,
      data.sii_status,
      data.estado_sii,
      response?.estado,
      'emitido'
    ),
    lioren_id: firstDefined(data.id, response?.id),
    folio: firstDefined(
      data.folio,
      data.numero_folio,
      data.Folio,
      response?.folio
    ),
    track_id: firstDefined(
      data.track_id,
      data.trackId,
      data.trackid,
      data.sii_track_id,
      response?.track_id
    ),
    pdf: firstDefined(
      data.pdf,
      data.pdf_url,
      data.url_pdf,
      data.documento_pdf,
      response?.pdf
    ),
    xml: firstDefined(
      data.xml,
      data.xml_url,
      data.url_xml,
      data.documento_xml,
      response?.xml
    ),
    tipo_dte: firstDefined(
      data.tipo_dte,
      data.tipoDocumento,
      data.tipo_documento,
      data.tipodoc
    ),
    raw: response
  };
}

class LiorenService {
  constructor(options = {}) {
    this.baseUrl = options.baseUrl || process.env.LIOREN_BASE_URL || DEFAULT_BASE_URL;
    this.dtePath = options.dtePath || process.env.LIOREN_DTE_PATH || DEFAULT_DTE_PATH;
    this.boletaPath = options.boletaPath || process.env.LIOREN_BOLETA_PATH || DEFAULT_BOLETA_PATH;
    this.timeoutMs = Number(options.timeoutMs || process.env.LIOREN_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
    this.maxRetries = Number(options.maxRetries ?? process.env.LIOREN_MAX_RETRIES ?? DEFAULT_MAX_RETRIES);
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    this.logger = options.logger || console;

    if (!this.fetchImpl) {
      throw new LiorenError('fetch no está disponible. Usa Node 18+ o inyecta fetchImpl.', {
        status: 500,
        code: 'FETCH_NOT_AVAILABLE'
      });
    }
  }

  get token() {
    const token = process.env.LIOREN_BEARER_TOKEN;

    if (!token) {
      throw new LiorenError('LIOREN_BEARER_TOKEN no está configurado', {
        status: 500,
        code: 'LIOREN_TOKEN_MISSING'
      });
    }

    return token.replace(/^Bearer\s+/i, '').trim();
  }

  buildUrl(path) {
    return `${this.baseUrl.replace(/\/$/, '')}/${String(path || '').replace(/^\//, '')}`;
  }

  safeLog(level, message, meta = {}) {
    const logger = this.logger?.[level]
      ? this.logger[level].bind(this.logger)
      : this.logger?.log?.bind(this.logger);

    if (!logger) return;

    logger(message, sanitizeForLog(meta));
  }

  validatePayload(payload) {
    const errors = [];

    if (!payload || typeof payload !== 'object') {
      errors.push('payload debe ser objeto JSON');
    }

    if (!payload?.emisor || typeof payload.emisor !== 'object') {
      errors.push('emisor es obligatorio');
    }

    if (!payload?.emisor?.rut) {
      errors.push('emisor.rut es obligatorio');
    }

    if (!payload?.emisor?.tipodoc) {
      errors.push('emisor.tipodoc es obligatorio');
    }

    if (!payload?.emisor?.fecha) {
      errors.push('emisor.fecha es obligatorio');
    }

    if (!payload?.receptor || typeof payload.receptor !== 'object') {
      errors.push('receptor es obligatorio');
    }

    if (!payload?.receptor?.rut) {
      errors.push('receptor.rut es obligatorio');
    }

    if (!payload?.receptor?.rs) {
      errors.push('receptor.rs es obligatorio');
    }

    if (!payload?.receptor?.giro) {
      errors.push('receptor.giro es obligatorio');
    }

    if (!Number.isInteger(Number(payload?.receptor?.comuna))) {
      errors.push('receptor.comuna debe ser entero');
    }

    if (!Number.isInteger(Number(payload?.receptor?.ciudad))) {
      errors.push('receptor.ciudad debe ser entero');
    }

    if (!payload?.receptor?.direccion) {
      errors.push('receptor.direccion es obligatorio');
    }

    if (!Array.isArray(payload?.detalles) || payload.detalles.length === 0) {
      errors.push('detalles debe contener al menos un ítem');
    }

    if (Array.isArray(payload?.detalles)) {
      payload.detalles.forEach((item, index) => {
        if (!item.codigo) errors.push(`detalles[${index}].codigo es obligatorio`);
        if (String(item.codigo).length < 3) errors.push(`detalles[${index}].codigo debe tener al menos 3 caracteres`);
        if (!item.nombre) errors.push(`detalles[${index}].nombre es obligatorio`);
        if (toNumber(item.cantidad, 0) <= 0) errors.push(`detalles[${index}].cantidad debe ser mayor a 0`);
        if (toNumber(item.precio, -1) < 0) errors.push(`detalles[${index}].precio debe ser mayor o igual a 0`);
        if (item.exento === undefined) errors.push(`detalles[${index}].exento es obligatorio`);
        if (item.monto === undefined) errors.push(`detalles[${index}].monto es obligatorio`);
      });
    }

    if (!payload?.expects) {
      errors.push('expects es obligatorio');
    }

    if (payload?.expects && !['xml', 'pdf', 'all'].includes(String(payload.expects).toLowerCase())) {
      errors.push('expects debe ser xml, pdf o all');
    }

    if (errors.length) {
      throw new LiorenError('Payload Lioren incompleto', {
        status: 400,
        code: 'LIOREN_PAYLOAD_VALIDATION_ERROR',
        details: errors
      });
    }
  }

  getErrorMessage(status, body) {
    const message = firstDefined(
      body?.message,
      body?.mensaje,
      body?.error?.message,
      typeof body?.error === 'string' ? body.error : undefined
    );

    switch (status) {
      case 400:
        return message || 'Solicitud inválida enviada a Lioren';
      case 401:
        return message || 'Token Lioren inválido o no autorizado';
      case 403:
        return message || 'Token Lioren sin permisos para emitir DTE';
      case 404:
        return message || 'Endpoint o recurso Lioren no encontrado';
      case 422:
        return message || 'Lioren rechazó el DTE por validación de negocio';
      case 500:
        return message || 'Error interno de Lioren';
      default:
        return message || `Error HTTP ${status} desde Lioren`;
    }
  }

  async requestWithRetry(url, options, attempt = 0) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(url, {
        ...options,
        signal: controller.signal
      });

      const rawText = await response.text();
      let body = null;

      try {
        body = rawText ? JSON.parse(rawText) : null;
      } catch {
        body = { raw: rawText };
      }

      if (!response.ok) {
        const retryable = RETRY_STATUS_CODES.has(response.status);

        const error = new LiorenError(this.getErrorMessage(response.status, body), {
          status: response.status,
          code: `LIOREN_HTTP_${response.status}`,
          details: sanitizeForLog(body),
          retryable
        });

        if (retryable && attempt < this.maxRetries) {
          this.safeLog('warn', 'Lioren request retry', {
            status: response.status,
            attempt: attempt + 1
          });

          await sleep(350 * 2 ** attempt);
          return this.requestWithRetry(url, options, attempt + 1);
        }

        throw error;
      }

      return body;
    } catch (error) {
      const isTimeout = error?.name === 'AbortError';
      const retryable = isTimeout || error?.retryable;

      if (retryable && attempt < this.maxRetries && !NON_RETRY_STATUS_CODES.has(error.status)) {
        this.safeLog('warn', 'Lioren request retry', {
          status: error.status || 'timeout',
          attempt: attempt + 1
        });

        await sleep(350 * 2 ** attempt);
        return this.requestWithRetry(url, options, attempt + 1);
      }

      if (error instanceof LiorenError) throw error;

      throw new LiorenError(
        isTimeout ? 'Timeout al conectar con Lioren' : 'Error al conectar con Lioren',
        {
          status: isTimeout ? 504 : 502,
          code: isTimeout ? 'LIOREN_TIMEOUT' : 'LIOREN_NETWORK_ERROR',
          details: { message: error.message },
          retryable
        }
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  async emitirDTE(payload, options = {}) {
    this.validatePayload(payload);

    const path = options.path || this.dtePath;
    const url = this.buildUrl(path);

    this.safeLog('info', 'Emitiendo DTE en Lioren', {
      endpoint: path,
      tipodoc: payload.emisor?.tipodoc,
      expects: payload.expects,
      receptor: payload.receptor?.rut || '[sin rut]',
      items: payload.detalles?.length || 0
    });

    if (process.env.LIOREN_DEBUG_PAYLOAD === 'true') {
      this.safeLog('info', 'Payload enviado a Lioren', payload);
    }

    const response = await this.requestWithRetry(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: JSON.stringify(payload)
    });

    return normalizeLiorenResponse(response);
  }

  emitirFactura(data) {
    const payload = this.buildPayload(data, 33, false);

    return this.emitirDTE(payload, {
      path: this.dtePath
    });
  }

  emitirFacturaExenta(data) {
    const payload = this.buildPayload(data, 34, true);

    return this.emitirDTE(payload, {
      path: this.dtePath
    });
  }

  emitirBoleta(data) {
    const payload = this.buildPayload(data, 39, false);

    return this.emitirDTE(payload, {
      path: this.boletaPath
    });
  }

  async consultarDTE(id) {
    if (!id) {
      throw new LiorenError('id es requerido para consultar DTE', {
        status: 400,
        code: 'DTE_ID_REQUIRED'
      });
    }

    const response = await this.requestWithRetry(
      this.buildUrl(`${this.dtePath.replace(/\/$/, '')}/${encodeURIComponent(id)}`),
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: 'application/json'
        }
      }
    );

    return normalizeLiorenResponse(response);
  }

  buildPayload(data, tipoDte, exentoDocumento) {
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

    const fecha = firstDefined(
      data.emisor?.fecha,
      data.fecha,
      data.fecha_emision,
      new Date().toISOString().slice(0, 10)
    );

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
}

module.exports = {
  LiorenService,
  LiorenError
};
