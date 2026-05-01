# Integración Lioren DTE — Klinge CRM

Este módulo agrega un servicio backend para emitir documentos tributarios electrónicos desde el CRM sin exponer el token de Lioren al frontend.

## Endpoints implementados

### POST `/api/facturas`

Acepta:

- `tipo_documento: "factura"` → Factura electrónica afecta, tipo DTE 33.
- `tipo_documento: "factura_exenta"` → Factura exenta, tipo DTE 34.
- `tipo_documento: "boleta"` → Boleta electrónica, tipo DTE 39.

El frontend debe llamar solo a `/api/facturas`. El Bearer Token vive exclusivamente en el backend mediante `process.env.LIOREN_BEARER_TOKEN`.

## Seguridad

- No hardcodear `LIOREN_BEARER_TOKEN`.
- No imprimir el token.
- No devolver el token al frontend.
- El servicio registra solo metadata no sensible.

## Instalación

```bash
npm install
cp .env.example .env
# editar .env y agregar LIOREN_BEARER_TOKEN real
npm run check
npm start
```

## Ejemplo de uso

```bash
curl -X POST http://localhost:3000/api/facturas \
  -H "Content-Type: application/json" \
  -d @examples/factura.payload.json
```

## Notas sobre consultarDTE

`consultarDTE(id)` queda preparado usando `LIOREN_CONSULTA_DTE_PATH`. Si Lioren documenta una ruta exacta distinta para consulta DTE, cámbiala en `.env` sin tocar el código.
