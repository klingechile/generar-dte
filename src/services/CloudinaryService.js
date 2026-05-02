'use strict';

const crypto = require('crypto');

class CloudinaryService {
  constructor(options = {}) {
    this.cloudName = options.cloudName || process.env.CLOUDINARY_CLOUD_NAME || '';
    this.apiKey = options.apiKey || process.env.CLOUDINARY_API_KEY || '';
    this.apiSecret = options.apiSecret || process.env.CLOUDINARY_API_SECRET || '';
    this.uploadPreset = options.uploadPreset || process.env.CLOUDINARY_UPLOAD_PRESET || '';
    this.folder = options.folder || process.env.CLOUDINARY_DTE_FOLDER || 'klinge/dte';
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    this.logger = options.logger || console;
  }

  isConfigured() {
    return Boolean(
      this.cloudName &&
      this.fetchImpl &&
      ((this.apiKey && this.apiSecret) || this.uploadPreset)
    );
  }

  safeLog(level, message, meta = {}) {
    const logger = this.logger?.[level]
      ? this.logger[level].bind(this.logger)
      : this.logger?.log?.bind(this.logger);

    if (!logger) return;

    logger(message, meta);
  }

  stripBase64Prefix(pdf) {
    const value = String(pdf || '').trim();
    if (!value) return '';

    const commaIndex = value.indexOf(',');
    if (value.startsWith('data:') && commaIndex >= 0) {
      return value.slice(commaIndex + 1);
    }

    return value;
  }

  buildPublicId(metadata = {}) {
    const tipo = String(metadata.tipo_dte || metadata.tipo_documento || 'dte').replace(/[^a-zA-Z0-9_-]/g, '');
    const folio = String(metadata.folio || metadata.lioren_id || Date.now()).replace(/[^a-zA-Z0-9_-]/g, '');
    const venta = metadata.venta_id ? `-${String(metadata.venta_id).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32)}` : '';

    return `${tipo}-${folio}${venta}`;
  }

  signParams(params) {
    const payload = Object.keys(params)
      .filter((key) => params[key] !== undefined && params[key] !== null && params[key] !== '')
      .sort()
      .map((key) => `${key}=${params[key]}`)
      .join('&');

    return crypto
      .createHash('sha1')
      .update(`${payload}${this.apiSecret}`)
      .digest('hex');
  }

  async uploadPdfBase64(pdf, metadata = {}) {
    const base64 = this.stripBase64Prefix(pdf);

    if (!base64) {
      return null;
    }

    if (!this.isConfigured()) {
      this.safeLog('warn', 'Cloudinary no configurado; se devuelve PDF base64 sin subirlo', {
        has_cloud_name: Boolean(this.cloudName),
        has_api_key: Boolean(this.apiKey),
        has_api_secret: Boolean(this.apiSecret),
        has_upload_preset: Boolean(this.uploadPreset)
      });

      return {
        skipped: true,
        reason: 'CLOUDINARY_NOT_CONFIGURED'
      };
    }

    const publicId = this.buildPublicId(metadata);
    const url = `https://api.cloudinary.com/v1_1/${encodeURIComponent(this.cloudName)}/raw/upload`;
    const form = new FormData();

    form.append('file', `data:application/pdf;base64,${base64}`);
    form.append('folder', this.folder);
    form.append('public_id', publicId);
    form.append('overwrite', 'true');

    if (this.uploadPreset && !(this.apiKey && this.apiSecret)) {
      form.append('upload_preset', this.uploadPreset);
    } else {
      const timestamp = Math.floor(Date.now() / 1000);
      const signableParams = {
        folder: this.folder,
        overwrite: 'true',
        public_id: publicId,
        timestamp
      };

      form.append('api_key', this.apiKey);
      form.append('timestamp', String(timestamp));
      form.append('signature', this.signParams(signableParams));
    }

    const response = await this.fetchImpl(url, {
      method: 'POST',
      body: form
    });

    const text = await response.text();
    let body;

    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { raw: text };
    }

    if (!response.ok) {
      const message = body?.error?.message || body?.message || `Cloudinary HTTP ${response.status}`;
      const error = new Error(message);
      error.name = 'CloudinaryUploadError';
      error.status = response.status;
      error.details = body;
      throw error;
    }

    return {
      secure_url: body.secure_url,
      url: body.url,
      public_id: body.public_id,
      asset_id: body.asset_id,
      resource_type: body.resource_type,
      bytes: body.bytes,
      format: body.format,
      raw: body
    };
  }
}

module.exports = {
  CloudinaryService
};
