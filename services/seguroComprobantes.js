// backend/services/seguroComprobantes.js
// PDF receipt ("comprobante") of each registered payment of a
// Seguro de Gastos Médicos Mayores register (table sort_ges_seguro_mat_cuotas,
// column comprobante_url).
//
// Cloudinary layout — one folder per gestante, one sub-folder per register:
//   sort-ges-seguros/gestante_<candidateId>/poliza_<polizaId>/
//       seguro_pago_g<candidateId>_p<polizaId>_cuota_<n>      (resource_type raw)
// Uploading again for the same payment overwrites the previous file.

import cloudinary from '../config/cloudinary.js';
import pool from '../db.js';

export const SEGUROS_ROOT_FOLDER = 'sort-ges-seguros';

export const comprobanteFolder = (candidateId, polizaId) =>
  `${SEGUROS_ROOT_FOLDER}/gestante_${candidateId}/poliza_${polizaId}`;

export const comprobantePublicId = (candidateId, polizaId, cuotaNum) =>
  `seguro_pago_g${candidateId}_p${polizaId}_cuota_${cuotaNum}`;

/** The payment row + its gestante, or null. Never trusts a candidate id sent by the browser. */
export const findCuota = async (polizaId, cuotaNum) => {
  const [rows] = await pool.query(
    `SELECT c.seguro_mat_id, c.cuota_num, c.fecha_pago, c.status, c.comprobante_url, s.candidate_id
       FROM sort_ges_seguro_mat_cuotas c
       JOIN sort_ges_seguro_mat s ON s.id = c.seguro_mat_id
      WHERE c.seguro_mat_id = ? AND c.cuota_num = ?`,
    [polizaId, cuotaNum]
  );
  return rows[0] || null;
};

/**
 * Removes the file from Cloudinary. Best-effort: a missing file is not an error.
 * storedUrl (the URL saved on the payment) gives the exact public id; without it
 * the standard name is used.
 */
export const destroyComprobante = async (candidateId, polizaId, cuotaNum, storedUrl) => {
  const parsed = parseCloudinaryUrl(storedUrl);
  try {
    await cloudinary.uploader.destroy(
      parsed?.publicId || comprobantePublicId(candidateId, polizaId, cuotaNum),
      { resource_type: parsed?.resourceType || 'raw', type: parsed?.type || 'upload', invalidate: true }
    );
  } catch (err) {
    console.warn('Cloudinary comprobante delete warning:', err?.message || err);
  }
};

/** Deletes the files of every payment of a register that has one (before its payments are deleted). */
export const destroyComprobantesOfPoliza = async (polizaId) => {
  const [rows] = await pool.query(
    `SELECT c.cuota_num, c.comprobante_url, s.candidate_id
       FROM sort_ges_seguro_mat_cuotas c
       JOIN sort_ges_seguro_mat s ON s.id = c.seguro_mat_id
      WHERE c.seguro_mat_id = ? AND c.comprobante_url IS NOT NULL`,
    [polizaId]
  );
  for (const r of rows) await destroyComprobante(r.candidate_id, polizaId, r.cuota_num, r.comprobante_url);
};

/**
 * Cloudinary delivery URL → { resourceType, type, publicId, format }.
 *   https://res.cloudinary.com/<cloud>/<raw|image>/<upload|...>/v123/<public_id>
 * The public id is taken from the URL Cloudinary returned at upload time, so it
 * is right whatever the account's folder mode (it may include the folder path).
 */
export const parseCloudinaryUrl = (url) => {
  const m = String(url || '').match(
    /^https:\/\/res\.cloudinary\.com\/[^/]+\/(image|raw|video)\/(upload|private|authenticated)\/(?:v\d+\/)?(.+?)(?:\?.*)?$/
  );
  if (!m) return null;
  const [, resourceType, type, rest] = m;
  let publicId = decodeURIComponent(rest);
  let format = '';
  // For raw files the extension is part of the public id; for images it's the format
  if (resourceType !== 'raw') {
    const dot = publicId.lastIndexOf('.');
    if (dot > publicId.lastIndexOf('/')) { format = publicId.slice(dot + 1); publicId = publicId.slice(0, dot); }
  }
  return { resourceType, type, publicId, format };
};

/**
 * Sends a stored PDF to the browser through the backend. Tries, in order:
 *   1. signed download through Cloudinary's API (not affected by the account's
 *      "PDF delivery" restriction), using the public id read from the stored URL
 *   2. the stored URL itself
 *   3. the stored URL with the API credentials
 * Every attempt's result is logged and, if all fail, included in the message.
 */
export const pipeStoredPdf = async (res, storedUrl, fallbackPublicId) => {
  const authHeader = 'Basic ' + Buffer.from(
    `${process.env.CLOUDINARY_API_KEY}:${process.env.CLOUDINARY_API_SECRET}`
  ).toString('base64');

  const parsed = parseCloudinaryUrl(storedUrl)
    || { resourceType: 'raw', type: 'upload', publicId: fallbackPublicId, format: '' };

  const attempts = [
    ['API', () => fetch(cloudinary.utils.private_download_url(parsed.publicId, parsed.format, {
      resource_type: parsed.resourceType, type: parsed.type,
    }))],
  ];
  if (storedUrl) {
    attempts.push(['URL', () => fetch(storedUrl)]);
    attempts.push(['URL+auth', () => fetch(storedUrl, { headers: { Authorization: authHeader } })]);
  }

  const statuses = [];
  let buffer = null;
  for (const [label, run] of attempts) {
    try {
      const r = await run();
      statuses.push(`${label} ${r.status}`);
      if (!r.ok) continue;
      const b = Buffer.from(await r.arrayBuffer());
      // A real PDF starts with "%PDF" — anything else is an error page
      if (b.subarray(0, 5).toString('latin1').includes('%PDF')) { buffer = b; break; }
      statuses.push(`${label}: no es PDF (${b.length} bytes)`);
    } catch (err) {
      statuses.push(`${label} error`);
      console.error(`Comprobante ${parsed.publicId}: ${label} error`, err?.message || err);
    }
  }

  if (!buffer) {
    console.error(`Comprobante ${parsed.publicId} (${parsed.resourceType}/${parsed.type}) from ${storedUrl}: ${statuses.join(' | ')}`);
    return res.status(502).json({
      message: `No se pudo descargar el comprobante de Cloudinary (${statuses.join(', ')}).`,
    });
  }

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'inline; filename="comprobante.pdf"');
  res.setHeader('Content-Length', buffer.length);
  res.setHeader('Cache-Control', 'no-store');
  res.end(buffer);
};