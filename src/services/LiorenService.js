'use strict';

/**
 * LiorenService
 *
 * Integra emisión de DTEs contra Lioren sin exponer el Bearer Token al frontend.
 * Token requerido: process.env.LIOREN_BEARER_TOKEN
 */

const DEFAULT_BASE_URL = 'https://www.lioren.cl';
const DEFAULT_DTE_PATH = '/api/dtes';
const DEFAULT_TIMEOUT_MS = 20_000;
const RETRY_STATUS_CODES = new Set([500, 502, 503, 504]);
const NON_RETRY_STATUS_CODES = new Set([400, 401, 403, 404, 422]);

class LiorenError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'LiorenError';
    this.status = options.status || 500;
    this.code = options.code || 'LIOREN_ERROR';
    this.details = options.details;
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

function cleanRut(rut) {
  return String(rut || '').replace(/\./g, '').trim();
}

function firstDefined(...values) {
  return values.find((v) => v !== undefined && v !== null && v !== '');
}

function pickDeep(obj, paths) {
  for (const path of paths) {
    const value = path.split('.').reduce((acc, key) => (acc && acc[key] !== undefined ? acc[key] : undefined), obj);
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

function sanitizeForLog(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  const clone = JSON.parse(JSON.stringify(payload));
  const redactKeys = new Set(['authorization', 'token', 'bearer', 'password', 'secret', 'api_key', 'apiKey']);
  const walk = (obj) => {
    if (!obj || typeof obj !== 'object') return;
    Object.keys(obj).forEach((key) => {
      if (redactKeys.has(String(key).toLowerCase())) obj[key] = '[REDACTED]';
      else walk(obj[key]);
    });
  };
  walk(clone);
  return clone;
}

class LiorenService {
  constructor(options = {}) {
    this.baseUrl = options.baseUrl || process.env.LIOREN_BASE_URL || DEFAULT_BASE_URL;
    this.dtePath = options.dtePath || process.env.LIOREN_DTE_PATH || DEFAULT_DTE_PATH;
    this.consultaDtePath = options.consultaDtePath || process.env.LIOREN_CONSULTA_DTE_PATH || DEFAULT_DTE_PATH;
    this.timeoutMs = Number(options.timeoutMs || process.env.LIOREN_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
    this.maxRetries = Number(options.maxRetries ?? process.env.LIOREN_MAX_RETRIES ?? 2);
    this.logger = options.logger || console;
    this.fetchImpl = options.fetchImpl || globalThis.fetch;

    if (!this.fetchImpl) {
      throw new LiorenError('fetch no está disponible. Usa Node 18+ o inyecta fetchImpl.', {
        status: 500,
        code: 'FETCH_NOT_AVAILABLE',
      });
    }
  }

  get token() {
    const token = process.env.LIOREN_BEARER_TOKEN;
    if (!token) {
      throw new LiorenError('LIOREN_BEARER_TOKEN no está configurado', {
        status: 500,
        code: 'LIOREN_TOKEN_MISSING',
      });
    }
    return token;
  }

  buildUrl(path) {
    return `${this.baseUrl.replace(/\/$/, '')}/${String(path || '').replace(/^\//, '')}`;
  }

  validatePayload(payload) {
    if (!payload || typeof payload !== 'object') {
      throw new LiorenError('Payload inválido: debe ser un objeto JSON', { status: 400, code: 'INVALID_PAYLOAD' });
    }

    const receptor = payload.receptor;
    const tipo = firstDefined(payload.tipo_dte, payload.tipoDocumento, payload.tipo_documento, payload.documento?.tipo_dte);
    const detalle = payload.detalle;
    const totales = payload.totales;

    const errors = [];
    if (!receptor || typeof receptor !== 'object') errors.push('receptor es requerido');
    if (!tipo) errors.push('tipo de documento es requerido');
    if (!Array.isArray(detalle) || detalle.length === 0) errors.push('detalle debe contener al menos un ítem');
    if (!totales || typeof totales !== 'object') errors.push('totales es requerido');
    if (totales && totales.iva === undefined) errors.push('IVA es requerido en totales, incluso si es 0');

    if (Array.isArray(detalle)) {
      detalle.forEach((item, index) => {
        if (!firstDefined(item.nombre, item.descripcion, item.NmbItem)) errors.push(`detalle[${index}].nombre/descripcion es requerido`);
        if (toNumber(firstDefined(item.cantidad, item.qty, item.QtyItem), 0) <= 0) errors.push(`detalle[${index}].cantidad debe ser mayor a 0`);
        if (toNumber(firstDefined(item.precio_unitario, item.precio, item.PrcItem), -1) < 0) errors.push(`detalle[${index}].precio_unitario debe ser mayor o igual a 0`);
      });
    }

    if (errors.length) {
      throw new LiorenError('Payload DTE incompleto', { status: 400, code: 'DTE_VALIDATION_ERROR', details: errors });
    }
  }

  async requestWithRetry(url, options, attempt = 0) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(url, { ...options, signal: controller.signal });
      const rawText = await response.text();
      let body = null;

      try {
        body = rawText ? JSON.parse(rawText) : null;
      } catch {
        body = { raw: rawText };
      }

      if (!response.ok) {
        const retryable = RETRY_STATUS_CODES.has(response.status);
        const message = this.getErrorMessage(response.status, body);
        const error = new LiorenError(message, {
          status: response.status,
          code: `LIOREN_HTTP_${response.status}`,
          details: sanitizeForLog(body),
          retryable,
        });

        if (retryable && attempt < this.maxRetries) {
          this.safeLog('warn', 'Lioren emitDTE retry', { status: response.status, attempt: attempt + 1 });
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
          attempt: attempt + 1,
        });
        await sleep(350 * 2 ** attempt);
        return this.requestWithRetry(url, options, attempt + 1);
      }

      if (error instanceof LiorenError) throw error;

      throw new LiorenError(isTimeout ? 'Timeout al conectar con Lioren' : 'Error al conectar con Lioren', {
        status: isTimeout ? 504 : 502,
        code: isTimeout ? 'LIOREN_TIMEOUT' : 'LIOREN_NETWORK_ERROR',
        details: { message: error.message },
        retryable,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  getErrorMessage(status, body) {
    const message = pickDeep(body || {}, ['message', 'mensaje', 'error.message', 'error', 'errors.0.message']);
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

  normalizeResponse(response) {
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
      folio: firstDefined(data.folio, data.numero_folio, data.Folio, response?.folio),
      track_id: firstDefined(data.track_id, data.trackId, data.trackid, data.sii_track_id, response?.track_id),
      pdf: firstDefined(data.pdf, data.pdf_url, data.url_pdf, data.documento_pdf, response?.pdf),
      xml: firstDefined(data.xml, data.xml_url, data.url_xml, data.documento_xml, response?.xml),
      tipo_dte: firstDefined(data.tipo_dte, data.tipoDocumento, data.tipo_documento),
      raw: response,
    };
  }

  safeLog(level, message, meta = {}) {
    const logger = this.logger?.[level] ? this.logger[level].bind(this.logger) : this.logger?.log?.bind(this.logger);
    if (!logger) return;
    logger(message, sanitizeForLog(meta));
  }

  async emitirDTE(payload) {
    this.validatePayload(payload);

    const url = this.buildUrl(this.dtePath);
    this.safeLog('info', 'Emitiendo DTE en Lioren', {
      tipo_dte: firstDefined(payload.tipo_dte, payload.documento?.tipo_dte),
      receptor: payload.receptor?.rut || payload.receptor?.RUTRecep || '[sin rut]',
      items: payload.detalle?.length || 0,
    });

    const response = await this.requestWithRetry(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(payload),
    });

    return this.normalizeResponse(response);
  }

  emitirFactura(data) {
    const payload = this.buildPayload(data, 33, true);
    return this.emitirDTE(payload);
  }

  emitirFacturaExenta(data) {
    const payload = this.buildPayload(data, 34, false);
    return this.emitirDTE(payload);
  }

  emitirBoleta(data) {
    const payload = this.buildPayload(data, 39, true);
    return this.emitirDTE(payload);
  }

  async consultarDTE(id) {
    if (!id) {
      throw new LiorenError('id es requerido para consultar DTE', { status: 400, code: 'DTE_ID_REQUIRED' });
    }

    const url = this.buildUrl(`${this.consultaDtePath.replace(/\/$/, '')}/${encodeURIComponent(id)}`);

    const response = await this.requestWithRetry(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/json',
      },
    });

    return this.normalizeResponse(response);
  }

  buildPayload(data, tipoDte, afecto) {
    const cliente = data.cliente || data.receptor || {};
    const productos = Array.isArray(data.productos) ? data.productos : Array.isArray(data.detalle) ? data.detalle : [];

    if (!productos.length) {
      throw new LiorenError('Debe incluir al menos un producto', { status: 400, code: 'NO_ITEMS' });
    }

    const detalle = productos.map((item, index) => {
      const cantidad = toNumber(firstDefined(item.cantidad, item.qty), 1);
      const precioUnitario = toNumber(firstDefined(item.precio_unitario, item.precio, item.monto_unitario), 0);
      const descuento = toNumber(firstDefined(item.descuento, item.descuento_monto), 0);
      const subtotal = round(cantidad * precioUnitario - descuento);

      return {
        linea: index + 1,
        nombre: firstDefined(item.nombre, item.descripcion, item.sku, `Item ${index + 1}`),
        descripcion: firstDefined(item.descripcion, item.nombre, item.sku, `Item ${index + 1}`),
        cantidad,
        precio_unitario: round(precioUnitario),
        descuento: round(descuento),
        afecto,
        monto: subtotal,
      };
    });

    const subtotal = detalle.reduce((sum, item) => sum + item.monto, 0);
    const descuentoGlobal = round(data.descuento_global || data.descuento || 0);
    const neto = afecto ? Math.max(0, subtotal - descuentoGlobal) : 0;
    const exento = afecto ? 0 : Math.max(0, subtotal - descuentoGlobal);
    const iva = afecto ? round(neto * 0.19) : 0;
    const total = neto + exento + iva;

    return {
      documento: {
        tipo_dte: tipoDte,
        fecha_emision: data.fecha_emision || new Date().toISOString().slice(0, 10),
        referencias: data.referencias || [],
      },
      tipo_dte: tipoDte,
      receptor: {
        rut: cleanRut(firstDefined(cliente.rut, cliente.RUTRecep)),
        razon_social: firstDefined(cliente.razon_social, cliente.nombre, cliente.RznSocRecep),
        giro: firstDefined(cliente.giro, cliente.GiroRecep, 'Sin giro informado'),
        direccion: firstDefined(cliente.direccion, cliente.DirRecep, 'Sin dirección informada'),
        comuna: firstDefined(cliente.comuna, cliente.CmnaRecep, 'Santiago'),
        ciudad: firstDefined(cliente.ciudad, cliente.CiudadRecep, cliente.comuna, 'Santiago'),
        email: firstDefined(cliente.email, cliente.correo),
        telefono: firstDefined(cliente.telefono, cliente.phone),
      },
      detalle,
      totales: {
        neto,
        exento,
        iva,
        tasa_iva: 19,
        total,
      },
      metadata: {
        venta_id: data.venta_id,
        origen: data.origen || 'klinge-crm',
      },
    };
  }
}

module.exports = {
  LiorenService,
  LiorenError,
};
