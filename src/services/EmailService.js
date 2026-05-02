'use strict';

class EmailService {
  constructor(options = {}) {
    this.provider = String(options.provider || process.env.EMAIL_PROVIDER || '').toLowerCase();
    this.from = options.from || process.env.EMAIL_FROM || '';
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    this.resendApiKey = options.resendApiKey || process.env.RESEND_API_KEY || '';
  }

  isConfigured() {
    return Boolean(this.fetchImpl && this.from && this.provider === 'resend' && this.resendApiKey);
  }

  cleanBase64(value) {
    const raw = String(value || '').trim();
    const commaIndex = raw.indexOf(',');
    if (raw.startsWith('data:') && commaIndex >= 0) return raw.slice(commaIndex + 1);
    return raw;
  }

  async sendDteEmail({ to, tipoDocumento, folio, pdfBase64, pdfUrl, receptorNombre }) {
    const recipient = String(to || '').trim();

    if (!recipient) return { skipped: true, reason: 'NO_RECIPIENT' };
    if (!this.isConfigured()) return { skipped: true, reason: 'EMAIL_NOT_CONFIGURED' };

    const tipo = tipoDocumento === 'boleta'
      ? 'Boleta electrónica'
      : tipoDocumento === 'factura_exenta'
        ? 'Factura exenta electrónica'
        : 'Factura electrónica';

    const html = [
      `<p>Hola${receptorNombre ? ` ${receptorNombre}` : ''},</p>`,
      `<p>Adjuntamos tu ${tipo.toLowerCase()} emitida por Klinge.</p>`,
      folio ? `<p><strong>Folio:</strong> ${folio}</p>` : '',
      pdfUrl ? `<p><a href="${pdfUrl}">Ver PDF</a></p>` : '',
      '<p>Gracias por tu compra.</p>'
    ].join('\n');

    const body = {
      from: this.from,
      to: [recipient],
      subject: `${tipo}${folio ? ` N° ${folio}` : ''} - Klinge`,
      html
    };

    const cleanPdf = this.cleanBase64(pdfBase64);
    if (cleanPdf) {
      body.attachments = [
        {
          filename: `${tipoDocumento || 'dte'}-${folio || Date.now()}.pdf`,
          content: cleanPdf
        }
      ];
    }

    const response = await this.fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.resendApiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    const text = await response.text();
    let parsed = {};
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = { raw: text };
    }

    if (!response.ok) {
      const error = new Error(parsed?.message || `Email HTTP ${response.status}`);
      error.name = 'EmailSendError';
      error.status = response.status;
      error.details = parsed;
      throw error;
    }

    return { provider: 'resend', id: parsed.id, raw: parsed };
  }
}

module.exports = { EmailService };
