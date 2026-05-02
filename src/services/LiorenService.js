buildPayload(data, tipoDte, afecto) {
  const cliente = data.cliente || data.receptor || data.Receptor || {};
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
    data.rut_emisor,
    data.emisor?.rut,
    data.emisor?.rut_emisor,
    process.env.LIOREN_RUT_EMISOR
  );

  if (!rutEmisor) {
    throw new LiorenError('LIOREN_RUT_EMISOR no está configurado', {
      status: 500,
      code: 'LIOREN_RUT_EMISOR_MISSING'
    });
  }

  const fecha = firstDefined(
    data.fecha,
    data.fecha_emision,
    data.emisor?.fecha,
    new Date().toISOString().slice(0, 10)
  );

  const tipo = String(tipoDte);

  const folio = firstDefined(
    data.folio,
    data.documento?.folio,
    data.emisor?.folio
  );

  const detalles = productos.map((item, index) => {
    const cantidad = toNumber(
      firstDefined(item.cantidad, item.qty, item.QtyItem, item.quantity),
      1
    );

    const precioUnitario = toNumber(
      firstDefined(
        item.precio_unitario,
        item.precio,
        item.PrcItem,
        item.price,
        item.monto_unitario
      ),
      0
    );

    const descuento = toNumber(
      firstDefined(item.descuento, item.descuento_monto, item.discount),
      0
    );

    const subtotal = round(cantidad * precioUnitario - descuento);

    const nombre = firstDefined(
      item.nombre,
      item.descripcion,
      item.NmbItem,
      item.name,
      item.sku,
      `Item ${index + 1}`
    );

    return {
      nombre,
      descripcion: firstDefined(
        item.descripcion,
        item.nombre,
        item.NmbItem,
        item.name,
        item.sku,
        `Item ${index + 1}`
      ),
      cantidad,
      precio: round(precioUnitario),
      precio_unitario: round(precioUnitario),
      descuento: round(descuento),
      total: subtotal,
      monto: subtotal
    };
  });

  const subtotal = detalles.reduce((sum, item) => sum + item.total, 0);
  const descuentoGlobal = round(data.descuento_global || data.descuento || 0);

  const neto = afecto ? Math.max(0, subtotal - descuentoGlobal) : 0;
  const exento = afecto ? 0 : Math.max(0, subtotal - descuentoGlobal);
  const iva = afecto ? round(neto * 0.19) : 0;
  const total = neto + exento + iva;

  const comunaId = Number(
    firstDefined(
      cliente.comuna_id,
      cliente.comunaId,
      cliente.CmnaRecep,
      process.env.LIOREN_DEFAULT_COMUNA_ID,
      1
    )
  );

  const ciudadId = Number(
    firstDefined(
      cliente.ciudad_id,
      cliente.ciudadId,
      cliente.CiudadRecep,
      process.env.LIOREN_DEFAULT_CIUDAD_ID,
      comunaId,
      1
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

  const payload = {
    // Formato top-level según ejemplo Lioren
    tipo,
    fecha,
    rut_emisor: cleanRut(rutEmisor),

    // También mantenemos emisor porque el error 422 pidió emisor.tipodoc y emisor.fecha
    emisor: {
      tipodoc: tipoDte,
      tipo,
      fecha,
      rut: cleanRut(rutEmisor),
      rut_emisor: cleanRut(rutEmisor)
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
      razon_social: razonSocial,
      giro: firstDefined(
        cliente.giro,
        cliente.GiroRecep,
        tipoDte === 39 ? 'Particular' : 'Sin giro informado'
      ),
      direccion: firstDefined(
        cliente.direccion,
        cliente.DirRecep,
        tipoDte === 39 ? 'Sin dirección' : 'Sin dirección informada'
      ),
      comuna: comunaId,
      ciudad: ciudadId,
      email: firstDefined(cliente.email, cliente.correo),
      telefono: firstDefined(cliente.telefono, cliente.phone)
    },

    // Lioren pidió "detalles", plural
    detalles,

    // Alias por compatibilidad interna
    detalle: detalles,

    totales: {
      neto,
      exento,
      iva,
      tasa_iva: 19,
      total
    },

    metadata: {
      venta_id: data.venta_id,
      origen: data.origen || 'klinge-crm'
    }
  };

  // Solo incluir folio si viene explícitamente.
  // No usar folio fijo 1 en producción.
  if (folio !== undefined && folio !== null && folio !== '') {
    payload.folio = Number(folio);
    payload.emisor.folio = Number(folio);
  }

  return payload;
}
