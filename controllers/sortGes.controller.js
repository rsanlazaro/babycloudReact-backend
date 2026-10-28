// controllers/sortGes.controller.js
import pool from '../db.js';
import {
  logCreate,
  logUpdate,
  logDelete,
} from '../services/activityLogger.js';
import { normalizeCurp, isValidCurp, CURP_FORMAT_MESSAGE, parseSchemeAmount } from '../services/curp.js';
import { contractForScheme } from '../services/contracts.js';
import { JSON_FIELDS as PAYMENTS_JSON_FIELDS } from './paymentsGest.controller.js';
import { insertCandidate, buildAltaGescaFields } from '../services/sortGesRecords.js';
import { findConflicts, conflictResponse } from '../services/concurrency.js';
import { findCuota, destroyComprobante, destroyComprobantesOfPoliza } from '../services/seguroComprobantes.js';

const hasKey = (obj, k) => Object.prototype.hasOwnProperty.call(obj || {}, k);
const parseLocks = (v) => {
  if (!v) return {};
  if (typeof v === 'object') return { ...v };
  try { return JSON.parse(v) || {}; } catch { return {}; }
};
/** Applies { 'section.field': true|false } to a locks map (false removes the lock) */
const applyLockPatch = (locks, patch) => {
  const out = { ...locks };
  Object.entries(patch || {}).forEach(([k, v]) => { if (v) out[k] = true; else delete out[k]; });
  return out;
};
import {
  computeSolicitud, computeStatusGral, computePago, computeAnio, nextCuota, computeAltaSeguro,
} from '../services/seguroStatus.js';

/** Latest insurance register per candidate (Listado de seguros), keyed by candidate_id */
async function latestPolicies(candidateIds = null) {
  const [rows] = await pool.query(
    `SELECT s.candidate_id, s.fecha_solicitud, s.fecha_alta, s.fecha_liberacion, s.fecha_vencimiento
       FROM sort_ges_seguro_mat s
       JOIN (SELECT candidate_id, MAX(id) AS max_id FROM sort_ges_seguro_mat
              ${candidateIds ? 'WHERE candidate_id IN (?)' : ''}
              GROUP BY candidate_id) m
         ON m.max_id = s.id`,
    candidateIds ? [candidateIds] : []
  );
  const byCandidate = {};
  rows.forEach(r => { byCandidate[r.candidate_id] = r; });
  return byCandidate;
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

const unauthorized = (res) =>
  res.status(401).json({ message: 'Unauthorized' });

const notFound = (res, entity = 'Record') =>
  res.status(404).json({ message: `${entity} not found` });

const serverError = (res, err, label = '') => {
  console.error(`SORT GES ERROR${label ? ' [' + label + ']' : ''}:`, err);
  return res.status(500).json({ message: 'Server error' });
};

const requireSession = (req, res) => {
  if (!req.session?.user) { unauthorized(res); return false; }
  return true;
};

// ═════════════════════════════════════════════════════════════
// CANDIDATES (master record)
// ═════════════════════════════════════════════════════════════

export const getAllCandidates = async (req, res) => {
  if (!requireSession(req, res)) return;
  try {
    const [rows] = await pool.query(
      `SELECT c.id, c.status, c.ip_responsable, c.resp_admisiones, c.resp_att_previa, c.resp_psicologia,
              c.programa, c.vinculo, c.status_general, c.contra_status, c.foto_url, c.created_at,
              a.nombre_completo, a.curp, a.fecha_nacimiento,
              a.tipo_sangre, a.peso, a.altura, a.imc,
              a.metodo_aco, a.tiempo_metodo_aco, a.embarazos, a.cesareas, a.partos, a.abortos, a.hijos,
              a.esquema_ofrecido,
              ck.certificado_nacimiento_url, ck.curp_url,
              ck.comprobante_domicilio_url, ck.poliza_seguro_url,
              ck.consentimiento_informado, ck.consentimiento_transferencia,
              ck.aviso_privacidad, ck.informacion_personal,
              ck.regular, ck.hiv, ck.gemelar, ck.full_consent
       FROM sort_ges_candidates c
       LEFT JOIN sort_ges_alta_gesca a ON a.candidate_id = c.id
       LEFT JOIN sort_ges_checklist ck ON ck.candidate_id = c.id
       ORDER BY c.created_at DESC`
    );
    // Admisiones → "Alta seguro", derived from Listado de seguros (rules in services/seguroStatus.js)
    const policies = await latestPolicies();
    res.json(rows.map(r => ({ ...r, alta_seguro: computeAltaSeguro(policies[r.id]) })));
  } catch (err) { serverError(res, err, 'getAllCandidates'); }
};

export const getCandidate = async (req, res) => {
  if (!requireSession(req, res)) return;
  const { id } = req.params;
  try {
    const [rows] = await pool.query(
      `SELECT c.id, c.status, c.ip_responsable, c.resp_admisiones, c.resp_att_previa, c.resp_psicologia,
              c.programa, c.vinculo, c.status_general, c.contra_status, c.foto_url, c.created_at,
              a.nombre_completo, a.curp, a.fecha_nacimiento,
              a.tel_1 AS telefono, a.email,
              a.direccion, a.numero, a.postal,
              a.alcaldia_municipio AS ciudad, a.estado,
              a.tipo_sangre, a.peso, a.altura, a.imc,
              a.metodo_aco, a.tiempo_metodo_aco, a.embarazos, a.cesareas, a.partos, a.abortos, a.hijos,
              a.esquema_ofrecido
       FROM sort_ges_candidates c
       LEFT JOIN sort_ges_alta_gesca a ON a.candidate_id = c.id
       WHERE c.id = ?`,
      [id]
    );
    if (!rows.length) return notFound(res, 'Candidate');
    res.json(rows[0]);
  } catch (err) { serverError(res, err, 'getCandidate'); }
};

export const createCandidate = async (req, res) => {
  if (!requireSession(req, res)) return;
  const { status = 'iniciales', ip_responsable, programa, foto_url, vinculo } = req.body;
  const today = new Date();
  try {
    // Candidate + the 7 fixed psico_inicial rows (shared with Listado de pagos)
    const newId = await insertCandidate(pool, { status, ip_responsable, programa, foto_url, vinculo });

    await logCreate(
      req.session.user.id, 'progestor',
      `Creó gestante #${newId}`, today, `${newId}`
    );
    res.status(201).json({ id: newId });
  } catch (err) { serverError(res, err, 'createCandidate'); }
};

export const updateCandidate = async (req, res) => {
  if (!requireSession(req, res)) return;
  const { id } = req.params;
  const today = new Date();

  // Partial update — only touch fields actually sent in the request body,
  // so e.g. changing just ip_responsable from a table dropdown doesn't
  // silently null out status, programa, or foto_url.
  const ALLOWED = [
    'status', 'ip_responsable', 'resp_admisiones', 'resp_att_previa', 'resp_psicologia',
    'programa', 'foto_url', 'vinculo',
  ];
  const fields = {};
  for (const key of ALLOWED) {
    if (Object.prototype.hasOwnProperty.call(req.body, key)) {
      fields[key] = req.body[key] || null;
    }
  }

  if (Object.keys(fields).length === 0) {
    return res.status(400).json({ message: 'No valid fields to update' });
  }

  try {
    const setClause = Object.keys(fields).map(k => `${k} = ?`).join(', ');
    await pool.query(
      `UPDATE sort_ges_candidates SET ${setClause} WHERE id = ?`,
      [...Object.values(fields), id]
    );
    await logUpdate(
      req.session.user.id, 'progestor',
      `Actualizó gestante #${id}`, today, `${id}`
    );
    res.json({ success: true });
  } catch (err) { serverError(res, err, 'updateCandidate'); }
};

export const updateCandidateFoto = async (req, res) => {
  if (!requireSession(req, res)) return;
  const { id } = req.params;
  const { fotoUrl } = req.body;
  const today = new Date();
  try {
    await pool.query(
      'UPDATE sort_ges_candidates SET foto_url = ? WHERE id = ?',
      [fotoUrl || null, id]
    );
    await logUpdate(req.session.user.id, 'progestor',
      `Actualizó foto de candidata #${id}`, today, `${id}`);
    res.json({ success: true });
  } catch (err) { serverError(res, err, 'updateCandidateFoto'); }
};

export const deleteCandidate = async (req, res) => {
  if (!requireSession(req, res)) return;
  const { id } = req.params;
  const today = new Date();
  try {
    const [rows] = await pool.query(
      'SELECT id FROM sort_ges_candidates WHERE id = ?', [id]
    );
    if (!rows.length) return notFound(res, 'Candidate');
    await pool.query('DELETE FROM sort_ges_candidates WHERE id = ?', [id]);
    await logDelete(
      req.session.user.id, 'progestor',
      `Eliminó gestante #${id}`, today, `${id}`
    );
    res.json({ success: true });
  } catch (err) { serverError(res, err, 'deleteCandidate'); }
};

// Registers a status against the candidate's "Status General" / "Contra
// Status" slots. If status_general is still empty, the status is written
// there. If status_general is already occupied, it's written to
// contra_status instead — this is the "second scenario" slot. Triggered
// today only by the "Indicar posible descarte" button (status =
// 'posible_descarte'), but written generically so future status types can
// reuse the same two-slot logic without a new endpoint.
export const registerCandidateStatus = async (req, res) => {
  if (!requireSession(req, res)) return;
  const { id } = req.params;
  const { status } = req.body;
  const today = new Date();

  if (!status) {
    return res.status(400).json({ message: 'status is required' });
  }

  try {
    const [rows] = await pool.query(
      'SELECT status_general, contra_status FROM sort_ges_candidates WHERE id = ?', [id]
    );
    if (!rows.length) return notFound(res, 'Candidate');

    const { status_general, contra_status } = rows[0];
    const targetField = status_general ? 'contra_status' : 'status_general';

    await pool.query(
      `UPDATE sort_ges_candidates SET ${targetField} = ? WHERE id = ?`,
      [status, id]
    );

    await logUpdate(
      req.session.user.id, 'progestor',
      `Registró ${targetField === 'status_general' ? 'Status General' : 'Contra Status'} (${status}) para gestante #${id}`,
      today, `${id}`
    );

    res.json({ success: true, field: targetField, status });
  } catch (err) { serverError(res, err, 'registerCandidateStatus'); }
};

// ═════════════════════════════════════════════════════════════
// TAB 1 — ALTA GESCA
// ═════════════════════════════════════════════════════════════

export const getAltaGesca = async (req, res) => {
  if (!requireSession(req, res)) return;
  const { candidateId } = req.params;
  try {
    const [rows] = await pool.query(
      'SELECT * FROM sort_ges_alta_gesca WHERE candidate_id = ?', [candidateId]
    );
    res.json(rows[0] || null);
  } catch (err) { serverError(res, err, 'getAltaGesca'); }
};

export const upsertAltaGesca = async (req, res) => {
  if (!requireSession(req, res)) return;
  const { candidateId } = req.params;
  const today = new Date();
  const body = req.body || {};
  const allFields = buildAltaGescaFields(body);   // every column, missing ones as defaults
  const lockPatch = body.locked_fields_patch;      // { 'section.field': true|false }

  try {
    const [existing] = await pool.query(
      'SELECT * FROM sort_ges_alta_gesca WHERE candidate_id = ?', [candidateId]
    );

    if (existing.length === 0) {
      const fields = { ...allFields };
      if (lockPatch) fields.locked_fields = JSON.stringify(applyLockPatch({}, lockPatch));
      const cols = ['candidate_id', ...Object.keys(fields)];
      const placeholders = cols.map(() => '?').join(', ');
      await pool.query(
        `INSERT INTO sort_ges_alta_gesca (${cols.join(', ')}) VALUES (${placeholders})`,
        [candidateId, ...Object.values(fields)]
      );
      await logCreate(
        req.session.user.id, 'progestor',
        `Creó Alta GESCA para gestante #${candidateId}`, today, `${candidateId}`
      );
    } else {
      const current = existing[0];
      // Only the columns actually sent — never overwrite fields this client didn't touch
      const fields = {};
      Object.keys(allFields).forEach(k => {
        if (k !== 'locked_fields' && hasKey(body, k)) fields[k] = allFields[k];
      });

      // Someone else changed one of these fields since this client loaded it?
      if (body._original && typeof body._original === 'object') {
        const origT = buildAltaGescaFields(body._original);   // same transforms as the new values
        const original = {};
        Object.keys(body._original).forEach(k => { if (hasKey(origT, k)) original[k] = origT[k]; });
        const conflicts = findConflicts(current, original, fields, ['imc', 'imc_clasificacion', 'locked_fields']);
        if (conflicts.length) return conflictResponse(res, conflicts, current);
      }

      // Locks: merged with the stored ones (another user's locks are kept)
      if (lockPatch && typeof lockPatch === 'object') {
        fields.locked_fields = JSON.stringify(applyLockPatch(parseLocks(current.locked_fields), lockPatch));
      } else if (hasKey(body, 'locked_fields')) {
        fields.locked_fields = allFields.locked_fields;      // legacy full map
      }

      if (Object.keys(fields).length) {
        const setClause = Object.keys(fields).map(k => `${k} = ?`).join(', ');
        await pool.query(
          `UPDATE sort_ges_alta_gesca SET ${setClause} WHERE candidate_id = ?`,
          [...Object.values(fields), candidateId]
        );
        await logUpdate(
          req.session.user.id, 'progestor',
          `Actualizó Alta GESCA de gestante #${candidateId}`, today, `${candidateId}`
        );
      }
    }

    const [rows] = await pool.query(
      'SELECT * FROM sort_ges_alta_gesca WHERE candidate_id = ?', [candidateId]
    );
    res.json(rows[0]);
  } catch (err) { serverError(res, err, 'upsertAltaGesca'); }
};

// ═════════════════════════════════════════════════════════════
// TAB 2 — CHECK LIST
// ═════════════════════════════════════════════════════════════

export const getChecklist = async (req, res) => {
  if (!requireSession(req, res)) return;
  const { candidateId } = req.params;
  try {
    const [rows] = await pool.query(
      'SELECT * FROM sort_ges_checklist WHERE candidate_id = ?', [candidateId]
    );
    res.json(rows[0] || null);
  } catch (err) { serverError(res, err, 'getChecklist'); }
};

export const upsertChecklist = async (req, res) => {
  if (!requireSession(req, res)) return;
  const { candidateId } = req.params;
  const today = new Date();

  // Build update map only from fields actually sent in the request body
  // This allows partial updates (e.g. a single PDF URL) without overwriting other fields
  const ALLOWED = [
    'certificado_nacimiento_url', 'curp_url', 'comprobante_domicilio_url',
    'poliza_seguro_url', 'cita_entrega', 'cita_firma',
    'consentimiento_informado', 'consentimiento_transferencia',
    'aviso_privacidad', 'informacion_personal',
    'regular', 'hiv', 'gemelar', 'full_consent',
  ];
  const BOOL_FIELDS = [
    'consentimiento_informado', 'consentimiento_transferencia',
    'aviso_privacidad', 'informacion_personal',
    'regular', 'hiv', 'gemelar', 'full_consent',
  ];

  const fields = {};
  for (const key of ALLOWED) {
    if (Object.prototype.hasOwnProperty.call(req.body, key)) {
      fields[key] = BOOL_FIELDS.includes(key)
        ? (req.body[key] ? 1 : 0)
        : (req.body[key] || null);
    }
  }

  if (Object.keys(fields).length === 0) {
    return res.status(400).json({ message: 'No valid fields to update' });
  }

  try {
    const [existing] = await pool.query(
      'SELECT id FROM sort_ges_checklist WHERE candidate_id = ?', [candidateId]
    );

    if (existing.length === 0) {
      // First save — INSERT with whatever fields we have
      const cols         = ['candidate_id', ...Object.keys(fields)];
      const placeholders = cols.map(() => '?').join(', ');
      await pool.query(
        `INSERT INTO sort_ges_checklist (${cols.join(', ')}) VALUES (${placeholders})`,
        [candidateId, ...Object.values(fields)]
      );
      await logCreate(
        req.session.user.id, 'progestor',
        `Creó Checklist para gestante #${candidateId}`, today, `${candidateId}`
      );
    } else {
      if (req.body._original && typeof req.body._original === 'object') {
        const [[current]] = await pool.query(
          'SELECT * FROM sort_ges_checklist WHERE candidate_id = ?', [candidateId]
        );
        const original = {};
        Object.keys(req.body._original).forEach(k => {
          if (ALLOWED.includes(k)) {
            const v = req.body._original[k];
            original[k] = BOOL_FIELDS.includes(k) ? (v ? 1 : 0) : (v || null);
          }
        });
        const conflicts = findConflicts(current, original, fields);
        if (conflicts.length) return conflictResponse(res, conflicts, current);
      }
      // Partial UPDATE — only the columns in fields
      const setClause = Object.keys(fields).map(k => `${k} = ?`).join(', ');
      await pool.query(
        `UPDATE sort_ges_checklist SET ${setClause} WHERE candidate_id = ?`,
        [...Object.values(fields), candidateId]
      );
      await logUpdate(
        req.session.user.id, 'progestor',
        `Actualizó Checklist de gestante #${candidateId}`, today, `${candidateId}`
      );
    }

    const [rows] = await pool.query(
      'SELECT * FROM sort_ges_checklist WHERE candidate_id = ?', [candidateId]
    );
    res.json(rows[0]);
  } catch (err) { serverError(res, err, 'upsertChecklist'); }
};

// ═════════════════════════════════════════════════════════════
// TAB 3 — SEGURO DE VIDA
// ═════════════════════════════════════════════════════════════

export const getSeguroVidaList = async (req, res) => {
  if (!requireSession(req, res)) return;
  const { candidateId } = req.params;
  try {
    const [policies] = await pool.query(
      `SELECT v.*, p.monto AS pago_monto, p.fecha_pago
       FROM sort_ges_seguro_vida v
       LEFT JOIN sort_ges_seguro_vida_pagos p ON p.seguro_vida_id = v.id
       WHERE v.candidate_id = ?
       ORDER BY v.created_at ASC`,
      [candidateId]
    );
    res.json(policies);
  } catch (err) { serverError(res, err, 'getSeguroVidaList'); }
};

export const createSeguroVida = async (req, res) => {
  if (!requireSession(req, res)) return;
  const { candidateId } = req.params;
  const today = new Date();
  const { aseguradora, gestor, valor, fecha_alta, vencimiento } = req.body;

  try {
    const [result] = await pool.query(
      `INSERT INTO sort_ges_seguro_vida
         (candidate_id, aseguradora, gestor, cuotas, valor, fecha_alta, vencimiento)
       VALUES (?, ?, ?, 1, ?, ?, ?)`,
      [candidateId, aseguradora || null, gestor || null,
       valor || null, fecha_alta || null, vencimiento || null]
    );
    await logCreate(
      req.session.user.id, 'progestor',
      `Creó Seguro Vida para gestante #${candidateId}`, today, `${result.insertId}`
    );
    const [rows] = await pool.query(
      `SELECT v.*, p.monto AS pago_monto, p.fecha_pago
       FROM sort_ges_seguro_vida v
       LEFT JOIN sort_ges_seguro_vida_pagos p ON p.seguro_vida_id = v.id
       WHERE v.id = ?`, [result.insertId]
    );
    res.status(201).json(rows[0]);
  } catch (err) { serverError(res, err, 'createSeguroVida'); }
};

export const updateSeguroVida = async (req, res) => {
  if (!requireSession(req, res)) return;
  const { id } = req.params;
  const today = new Date();
  const { aseguradora, gestor, valor, fecha_alta, vencimiento } = req.body;

  try {
    await pool.query(
      `UPDATE sort_ges_seguro_vida
       SET aseguradora = ?, gestor = ?, valor = ?, fecha_alta = ?, vencimiento = ?
       WHERE id = ?`,
      [aseguradora || null, gestor || null, valor || null,
       fecha_alta || null, vencimiento || null, id]
    );
    await logUpdate(
      req.session.user.id, 'progestor',
      `Actualizó Seguro Vida #${id}`, today, `${id}`
    );
    res.json({ success: true });
  } catch (err) { serverError(res, err, 'updateSeguroVida'); }
};

export const deleteSeguroVida = async (req, res) => {
  if (!requireSession(req, res)) return;
  const { id } = req.params;
  const today = new Date();
  try {
    await pool.query('DELETE FROM sort_ges_seguro_vida WHERE id = ?', [id]);
    await logDelete(
      req.session.user.id, 'progestor',
      `Eliminó Seguro Vida #${id}`, today, `${id}`
    );
    res.json({ success: true });
  } catch (err) { serverError(res, err, 'deleteSeguroVida'); }
};

export const upsertSeguroVidaPago = async (req, res) => {
  if (!requireSession(req, res)) return;
  const { id } = req.params;
  const today = new Date();
  const { monto, fecha_pago } = req.body;

  try {
    const [existing] = await pool.query(
      'SELECT id FROM sort_ges_seguro_vida_pagos WHERE seguro_vida_id = ?', [id]
    );
    if (existing.length === 0) {
      await pool.query(
        'INSERT INTO sort_ges_seguro_vida_pagos (seguro_vida_id, monto, fecha_pago) VALUES (?, ?, ?)',
        [id, monto || null, fecha_pago || null]
      );
      await logCreate(
        req.session.user.id, 'progestor',
        `Registró pago de Seguro Vida #${id}`, today, `${id}`
      );
    } else {
      await pool.query(
        'UPDATE sort_ges_seguro_vida_pagos SET monto = ?, fecha_pago = ? WHERE seguro_vida_id = ?',
        [monto || null, fecha_pago || null, id]
      );
      await logUpdate(
        req.session.user.id, 'progestor',
        `Actualizó pago de Seguro Vida #${id}`, today, `${id}`
      );
    }
    const [rows] = await pool.query(
      'SELECT * FROM sort_ges_seguro_vida_pagos WHERE seguro_vida_id = ?', [id]
    );
    res.json(rows[0]);
  } catch (err) { serverError(res, err, 'upsertSeguroVidaPago'); }
};

export const deleteSeguroVidaPago = async (req, res) => {
  if (!requireSession(req, res)) return;
  const { id } = req.params;
  const today = new Date();
  try {
    await pool.query(
      'DELETE FROM sort_ges_seguro_vida_pagos WHERE seguro_vida_id = ?', [id]
    );
    await logDelete(
      req.session.user.id, 'progestor',
      `Eliminó pago de Seguro Vida #${id}`, today, `${id}`
    );
    res.json({ success: true });
  } catch (err) { serverError(res, err, 'deleteSeguroVidaPago'); }
};

// ═════════════════════════════════════════════════════════════
// TAB 3 — SEGURO DE MATERNIDAD
// ═════════════════════════════════════════════════════════════

// ═════════════════════════════════════════════════════════════
// SEND TO LISTADO DE SEGUROS (Sort_GESCA → Admisiones → "Alta seguro" send button)
// POST /api/sort-ges/:candidateId/seguro-solicitud
// Creates the gestante's insurance register with no request date yet, so it
// shows as Solicitud "Pendiente de solicitud" / Status Gral "Sin iniciar".
// One per gestante from this button: if she already has a register, that one
// is returned and nothing new is created.
// ═════════════════════════════════════════════════════════════
export const sendSeguroSolicitud = async (req, res) => {
  if (!requireSession(req, res)) return;
  const { candidateId } = req.params;
  try {
    const [cands] = await pool.query(
      `SELECT c.id, a.nombre_completo
         FROM sort_ges_candidates c
         LEFT JOIN sort_ges_alta_gesca a ON a.candidate_id = c.id
        WHERE c.id = ?`,
      [candidateId]
    );
    if (!cands.length) return notFound(res, 'Candidate');

    const [existing] = await pool.query(
      'SELECT id FROM sort_ges_seguro_mat WHERE candidate_id = ? ORDER BY id ASC LIMIT 1',
      [candidateId]
    );
    if (existing.length) {
      const latest = (await latestPolicies([Number(candidateId)]))[candidateId];
      return res.json({ id: existing[0].id, created: false, alta_seguro: computeAltaSeguro(latest) });
    }

    // Only the gestante; everything else is captured later (Listado de seguros / Seguro med).
    const row = await withRequiredDefaults('sort_ges_seguro_mat', { candidate_id: Number(candidateId) });
    const cols = Object.keys(row);
    const [result] = await pool.query(
      `INSERT INTO sort_ges_seguro_mat (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
      Object.values(row)
    );

    await logCreate(
      req.session.user.id, 'babysite',
      `Envió a Listado de seguros a gestante #${candidateId} (${cands[0].nombre_completo || 'sin nombre'})`,
      new Date(), `${result.insertId}`
    );
    res.status(201).json({ id: result.insertId, created: true, alta_seguro: computeAltaSeguro({}) });
  } catch (err) { serverError(res, err, 'sendSeguroSolicitud'); }
};

// ═════════════════════════════════════════════════════════════
// LISTADO DE SEGUROS (Baby site) — all policies of all gestantes
// GET /api/sort-ges/seguros[?candidate_id=N]
// Same data as each register's "Seguro med" tab, plus computed columns
// (rules in services/seguroStatus.js). With ?candidate_id only that gestante's
// registers are returned (used by Sort_GESCA → SEGURO MED).
// ═════════════════════════════════════════════════════════════
export const getAllSeguros = async (req, res) => {
  if (!requireSession(req, res)) return;
  const candidateId = req.query.candidate_id ? Number(req.query.candidate_id) : null;
  if (req.query.candidate_id && !Number.isInteger(candidateId)) {
    return res.status(400).json({ message: 'candidate_id inválido' });
  }
  try {
    const [policies] = await pool.query(
      `SELECT s.id, s.candidate_id, s.aseguradora, s.numero_poliza,
              s.fecha_solicitud, s.fecha_alta, s.fecha_liberacion, s.fecha_vencimiento, s.created_at,
              a.nombre_completo
         FROM sort_ges_seguro_mat s
         LEFT JOIN sort_ges_alta_gesca a ON a.candidate_id = s.candidate_id
        ${candidateId ? 'WHERE s.candidate_id = ?' : ''}
        ORDER BY s.created_at DESC`,
      candidateId ? [candidateId] : []
    );

    // All payments in one query (not one per policy)
    const byPolicy = {};
    if (policies.length) {
      const [cuotas] = await pool.query(
        `SELECT seguro_mat_id, cuota_num, total_cuotas, vencimiento, fecha_pago, status
           FROM sort_ges_seguro_mat_cuotas
          WHERE seguro_mat_id IN (?)
          ORDER BY cuota_num ASC`,
        [policies.map(p => p.id)]
      );
      cuotas.forEach(c => { (byPolicy[c.seguro_mat_id] ||= []).push(c); });
    }

    res.json(policies.map(p => {
      const cuotas = byPolicy[p.id] || [];
      const next = nextCuota(cuotas);
      const pago = computePago(cuotas);
      return {
        id: p.id,
        candidate_id: p.candidate_id,
        gestante: p.nombre_completo || `Candidato #${p.candidate_id}`,
        aseguradora: p.aseguradora,
        numero_poliza: p.numero_poliza,
        fecha_solicitud: p.fecha_solicitud,
        start_poliza: p.fecha_alta,
        fecha_vencimiento: p.fecha_vencimiento,
        solicitud: computeSolicitud(p),
        status_gral: computeStatusGral(p, cuotas),
        prox_pago: next?.vencimiento || null,
        pago: pago.texto,
        liquidado: pago.liquidado,
        anio: computeAnio(p),
        // Same state as Admisiones → "Alta seguro"; 'liberada' enables the "Asignar" button
        alta_seguro: computeAltaSeguro(p),
      };
    }));
  } catch (err) { serverError(res, err, 'getAllSeguros'); }
};

// "Valor de alta": empty → NULL, otherwise a number (0 is a valid amount)
const toMoney = (v) => {
  if (v === undefined || v === null || String(v).trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export const getSeguroMatList = async (req, res) => {
  if (!requireSession(req, res)) return;
  const { candidateId } = req.params;
  try {
    const [policies] = await pool.query(
      'SELECT * FROM sort_ges_seguro_mat WHERE candidate_id = ? ORDER BY created_at ASC',
      [candidateId]
    );
    for (const p of policies) {
      const [cuotas] = await pool.query(
        'SELECT * FROM sort_ges_seguro_mat_cuotas WHERE seguro_mat_id = ? ORDER BY cuota_num ASC',
        [p.id]
      );
      p.pagos = cuotas;
    }
    res.json(policies);
  } catch (err) { serverError(res, err, 'getSeguroMatList'); }
};

export const createSeguroMat = async (req, res) => {
  if (!requireSession(req, res)) return;
  const { candidateId } = req.params;
  const today = new Date();
  const {
    aseguradora, numero_poliza, gestor, tipo_pago, valor_cuota, total_estimado, valor_alta,
    fecha_solicitud, fecha_alta, fecha_liberacion, fecha_vencimiento,
    pagos = [],
  } = req.body;

  try {
    const [result] = await pool.query(
      `INSERT INTO sort_ges_seguro_mat
         (candidate_id, aseguradora, numero_poliza, gestor, tipo_pago,
          valor_cuota, total_estimado, valor_alta, fecha_solicitud, fecha_alta,
          fecha_liberacion, fecha_vencimiento)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        candidateId,
        aseguradora || null, numero_poliza || null, gestor || null,
        tipo_pago || null, valor_cuota || null, total_estimado || null, toMoney(valor_alta),
        fecha_solicitud || null, fecha_alta || null,
        fecha_liberacion || null, fecha_vencimiento || null,
      ]
    );
    const polizaId = result.insertId;

    if (pagos.length > 0) {
      const cuotaRows = pagos.map(c => [
        polizaId, c.cuota_num, c.total, c.vencimiento || null, 'pendiente',
      ]);
      await pool.query(
        `INSERT INTO sort_ges_seguro_mat_cuotas
           (seguro_mat_id, cuota_num, total_cuotas, vencimiento, status)
         VALUES ?`,
        [cuotaRows]
      );
    }

    await logCreate(
      req.session.user.id, 'progestor',
      `Creó Seguro Maternidad para gestante #${candidateId}`, today, `${polizaId}`
    );

    const [policies] = await pool.query(
      'SELECT * FROM sort_ges_seguro_mat WHERE id = ?', [polizaId]
    );
    const [cuotas] = await pool.query(
      'SELECT * FROM sort_ges_seguro_mat_cuotas WHERE seguro_mat_id = ? ORDER BY cuota_num ASC',
      [polizaId]
    );
    res.status(201).json({ ...policies[0], pagos: cuotas });
  } catch (err) { serverError(res, err, 'createSeguroMat'); }
};

export const updateSeguroMat = async (req, res) => {
  if (!requireSession(req, res)) return;
  const { id } = req.params;
  const today = new Date();
  const {
    aseguradora, numero_poliza, gestor, tipo_pago, valor_cuota, total_estimado, valor_alta,
    fecha_solicitud, fecha_alta, fecha_liberacion, fecha_vencimiento,
    rebuildPagos = false, pagos = [],
  } = req.body;

  try {
    await pool.query(
      `UPDATE sort_ges_seguro_mat
       SET aseguradora = ?, numero_poliza = ?, gestor = ?, tipo_pago = ?,
           valor_cuota = ?, total_estimado = ?, valor_alta = ?, fecha_solicitud = ?,
           fecha_alta = ?, fecha_liberacion = ?, fecha_vencimiento = ?
       WHERE id = ?`,
      [
        aseguradora || null, numero_poliza || null, gestor || null,
        tipo_pago || null, valor_cuota || null, total_estimado || null, toMoney(valor_alta),
        fecha_solicitud || null, fecha_alta || null,
        fecha_liberacion || null, fecha_vencimiento || null, id,
      ]
    );

    if (rebuildPagos && pagos.length > 0) {
      await destroyComprobantesOfPoliza(id);   // their payments are deleted below
      await pool.query(
        'DELETE FROM sort_ges_seguro_mat_cuotas WHERE seguro_mat_id = ?', [id]
      );
      const cuotaRows = pagos.map(c => [
        id, c.cuota_num, c.total, c.vencimiento || null, 'pendiente',
      ]);
      await pool.query(
        `INSERT INTO sort_ges_seguro_mat_cuotas
           (seguro_mat_id, cuota_num, total_cuotas, vencimiento, status)
         VALUES ?`,
        [cuotaRows]
      );
    }

    await logUpdate(
      req.session.user.id, 'progestor',
      `Actualizó Seguro Maternidad #${id}`, today, `${id}`
    );
    res.json({ success: true });
  } catch (err) { serverError(res, err, 'updateSeguroMat'); }
};

export const deleteSeguroMat = async (req, res) => {
  if (!requireSession(req, res)) return;
  const { id } = req.params;
  const today = new Date();
  const conn = await pool.getConnection();
  try {
    // Payments with a comprobante — their Cloudinary files are removed once the delete succeeds
    const [docs] = await conn.query(
      `SELECT c.cuota_num, c.comprobante_url, s.candidate_id
         FROM sort_ges_seguro_mat_cuotas c JOIN sort_ges_seguro_mat s ON s.id = c.seguro_mat_id
        WHERE c.seguro_mat_id = ? AND c.comprobante_url IS NOT NULL`,
      [id]
    );
    // Its payments go with it (same transaction: all or nothing)
    await conn.beginTransaction();
    await conn.query('DELETE FROM sort_ges_seguro_mat_cuotas WHERE seguro_mat_id = ?', [id]);
    await conn.query('DELETE FROM sort_ges_seguro_mat WHERE id = ?', [id]);
    await conn.commit();
    for (const d of docs) await destroyComprobante(d.candidate_id, id, d.cuota_num, d.comprobante_url);
    await logDelete(
      req.session.user.id, 'progestor',
      `Eliminó Seguro Gastos Médicos Mayores #${id}`, today, `${id}`
    );
    res.json({ success: true });
  } catch (err) {
    await conn.rollback().catch(() => {});
    serverError(res, err, 'deleteSeguroMat');
  } finally {
    conn.release();
  }
};

export const updateCuotaPago = async (req, res) => {
  if (!requireSession(req, res)) return;
  const { polizaId, cuotaNum } = req.params;
  const today = new Date();
  const { monto_pago, fecha_pago, status, concepto_pago } = req.body;
  const concepto = String(concepto_pago ?? '').trim().slice(0, 255) || null;

  try {
    await pool.query(
      `UPDATE sort_ges_seguro_mat_cuotas
       SET monto_pago = ?, fecha_pago = ?, status = ?, concepto_pago = ?
       WHERE seguro_mat_id = ? AND cuota_num = ?`,
      [monto_pago || null, fecha_pago || null, status || 'pendiente', concepto, polizaId, cuotaNum]
    );
    await logUpdate(
      req.session.user.id, 'progestor',
      `Actualizó cuota ${cuotaNum} de póliza #${polizaId}`, today, `${polizaId}`
    );
    const [rows] = await pool.query(
      'SELECT * FROM sort_ges_seguro_mat_cuotas WHERE seguro_mat_id = ? AND cuota_num = ?',
      [polizaId, cuotaNum]
    );
    res.json(rows[0]);
  } catch (err) { serverError(res, err, 'updateCuotaPago'); }
};

export const removeCuotaPago = async (req, res) => {
  if (!requireSession(req, res)) return;
  const { polizaId, cuotaNum } = req.params;
  const today = new Date();
  try {
    // The payment goes away → so does its comprobante (Cloudinary file + URL)
    const cuota = await findCuota(polizaId, cuotaNum);
    if (cuota?.comprobante_url) await destroyComprobante(cuota.candidate_id, polizaId, cuotaNum, cuota.comprobante_url);
    await pool.query(
      `UPDATE sort_ges_seguro_mat_cuotas
       SET monto_pago = NULL, fecha_pago = NULL, status = 'pendiente', comprobante_url = NULL, concepto_pago = NULL
       WHERE seguro_mat_id = ? AND cuota_num = ?`,
      [polizaId, cuotaNum]
    );
    await logUpdate(
      req.session.user.id, 'progestor',
      `Eliminó pago cuota ${cuotaNum} póliza #${polizaId}`, today, `${polizaId}`
    );
    res.json({ success: true });
  } catch (err) { serverError(res, err, 'removeCuotaPago'); }
};

// ═════════════════════════════════════════════════════════════
// TAB 4 — PSICO SOCIAL: Psico Inicial
// ═════════════════════════════════════════════════════════════

export const getPsicoInicial = async (req, res) => {
  if (!requireSession(req, res)) return;
  const { candidateId } = req.params;
  try {
    const [rows] = await pool.query(
      'SELECT * FROM sort_ges_psico_inicial WHERE candidate_id = ? ORDER BY etapa_orden ASC',
      [candidateId]
    );
    res.json(rows);
  } catch (err) { serverError(res, err, 'getPsicoInicial'); }
};

export const updatePsicoInicialRow = async (req, res) => {
  if (!requireSession(req, res)) return;
  const { candidateId, etapaOrden } = req.params;
  const today = new Date();
  const { fecha, estado, recomendacion } = req.body;

  try {
    await pool.query(
      `UPDATE sort_ges_psico_inicial
       SET fecha = ?, estado = ?, recomendacion = ?
       WHERE candidate_id = ? AND etapa_orden = ?`,
      [fecha || null, estado || null, recomendacion || null, candidateId, etapaOrden]
    );
    await logUpdate(
      req.session.user.id, 'progestor',
      `Actualizó Psico Inicial etapa ${etapaOrden} gestante #${candidateId}`,
      today, `${candidateId}`
    );
    const [rows] = await pool.query(
      'SELECT * FROM sort_ges_psico_inicial WHERE candidate_id = ? AND etapa_orden = ?',
      [candidateId, etapaOrden]
    );
    res.json(rows[0]);
  } catch (err) { serverError(res, err, 'updatePsicoInicialRow'); }
};

// ═════════════════════════════════════════════════════════════
// TAB 4 — PSICO SOCIAL: Seguimiento Psicológico
// ═════════════════════════════════════════════════════════════

export const getSeguimientoList = async (req, res) => {
  if (!requireSession(req, res)) return;
  const { candidateId } = req.params;
  try {
    const [rows] = await pool.query(
      'SELECT * FROM sort_ges_seguimiento WHERE candidate_id = ? ORDER BY created_at ASC',
      [candidateId]
    );
    res.json(rows);
  } catch (err) { serverError(res, err, 'getSeguimientoList'); }
};

export const createSeguimiento = async (req, res) => {
  if (!requireSession(req, res)) return;
  const { candidateId } = req.params;
  const today = new Date();
  const {
    etapa, motivo, complemento, complemento2,
    programar, asistencia, informe, incidencia, historial,
  } = req.body;

  try {
    const [result] = await pool.query(
      `INSERT INTO sort_ges_seguimiento
         (candidate_id, etapa, motivo, complemento, complemento2,
          programar, asistencia, informe, incidencia, historial)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        candidateId,
        etapa || null, motivo || null, complemento || null,
        complemento2 || null, programar || null,
        asistencia || null, informe || null,
        incidencia || null, historial || null,
      ]
    );
    await logCreate(
      req.session.user.id, 'progestor',
      `Creó Seguimiento para gestante #${candidateId}`, today, `${result.insertId}`
    );
    const [rows] = await pool.query(
      'SELECT * FROM sort_ges_seguimiento WHERE id = ?', [result.insertId]
    );
    res.status(201).json(rows[0]);
  } catch (err) { serverError(res, err, 'createSeguimiento'); }
};

export const updateSeguimiento = async (req, res) => {
  if (!requireSession(req, res)) return;
  const { id } = req.params;
  const today = new Date();
  const {
    etapa, motivo, complemento, complemento2,
    programar, asistencia, informe, incidencia, historial,
  } = req.body;

  try {
    await pool.query(
      `UPDATE sort_ges_seguimiento
       SET etapa = ?, motivo = ?, complemento = ?, complemento2 = ?,
           programar = ?, asistencia = ?, informe = ?, incidencia = ?, historial = ?
       WHERE id = ?`,
      [
        etapa || null, motivo || null, complemento || null,
        complemento2 || null, programar || null,
        asistencia || null, informe || null,
        incidencia || null, historial || null, id,
      ]
    );
    await logUpdate(
      req.session.user.id, 'progestor',
      `Actualizó Seguimiento #${id}`, today, `${id}`
    );
    res.json({ success: true });
  } catch (err) { serverError(res, err, 'updateSeguimiento'); }
};

export const deleteSeguimiento = async (req, res) => {
  if (!requireSession(req, res)) return;
  const { id } = req.params;
  const today = new Date();
  try {
    await pool.query('DELETE FROM sort_ges_seguimiento WHERE id = ?', [id]);
    await logDelete(
      req.session.user.id, 'progestor',
      `Eliminó Seguimiento #${id}`, today, `${id}`
    );
    res.json({ success: true });
  } catch (err) { serverError(res, err, 'deleteSeguimiento'); }
};

// ═════════════════════════════════════════════════════════════
// TAB 5 — CITA PREVIA
// Same shape as Seguimiento above: a flat, dynamic list of records per
// candidate. Each row also carries sub_tab (iniciales / tratamiento_previo /
// prepa_transfer / pre_natal / materno_fetal) so the frontend can group a
// single fetched list into its 5 sub-tabs without 5 separate requests.
// updateCitaPrevia follows updateSeguimiento's convention of overwriting
// every column on each save (the frontend sends the full row each time a
// field changes), not a partial update.
// ═════════════════════════════════════════════════════════════

export const getCitaPreviaList = async (req, res) => {
  if (!requireSession(req, res)) return;
  const { candidateId } = req.params;
  try {
    const [rows] = await pool.query(
      'SELECT * FROM sort_ges_cita_previa WHERE candidate_id = ? ORDER BY created_at ASC',
      [candidateId]
    );
    res.json(rows);
  } catch (err) { serverError(res, err, 'getCitaPreviaList'); }
};

// "No acudió" history: array of { fecha_cita, remarcada } stored as JSON text
const serializeNoAcudio = (v) => {
  if (!v) return null;
  const arr = Array.isArray(v) ? v : (() => { try { return JSON.parse(v); } catch { return []; } })();
  const clean = (arr || [])
    .filter(e => e && typeof e === 'object')
    .map(e => ({ fecha_cita: e.fecha_cita || null, remarcada: e.remarcada || null }));
  return clean.length ? JSON.stringify(clean) : null;
};

export const createCitaPrevia = async (req, res) => {
  if (!requireSession(req, res)) return;
  const { candidateId } = req.params;
  const today = new Date();
  const {
    sub_tab, motivo, sdg, inicio_tratamiento, final: fechaFinal, diagnostico,
    fecha_cita, dr_tratante, status, comentario_solicitud,
    entrega_resultados, reportes, status_resultados, observaciones,
    tipo, resolucion, incidencia, no_acudio,
  } = req.body;

  if (!sub_tab) {
    return res.status(400).json({ message: 'sub_tab is required' });
  }

  try {
    const [result] = await pool.query(
      `INSERT INTO sort_ges_cita_previa
         (candidate_id, sub_tab, motivo, sdg, inicio_tratamiento, \`final\`,
          diagnostico, fecha_cita, dr_tratante, status, comentario_solicitud,
          entrega_resultados, reportes, status_resultados, observaciones,
          tipo, resolucion, incidencia, no_acudio)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        candidateId, sub_tab,
        motivo || null, sdg || null,
        inicio_tratamiento || null, fechaFinal || null,
        diagnostico ? 1 : 0,
        fecha_cita || null, dr_tratante || null, status || null,
        comentario_solicitud || null, entrega_resultados || null,
        reportes || null, status_resultados || null, observaciones || null,
        tipo === 'laboratorio' ? 'laboratorio' : 'cita',
        resolucion || null, incidencia || null, serializeNoAcudio(no_acudio),
      ]
    );
    await logCreate(
      req.session.user.id, 'progestor',
      `Creó Cita Previa (${sub_tab}) para gestante #${candidateId}`, today, `${result.insertId}`
    );
    const [rows] = await pool.query(
      'SELECT * FROM sort_ges_cita_previa WHERE id = ?', [result.insertId]
    );
    res.status(201).json(rows[0]);
  } catch (err) { serverError(res, err, 'createCitaPrevia'); }
};

export const updateCitaPrevia = async (req, res) => {
  if (!requireSession(req, res)) return;
  const { id } = req.params;
  const today = new Date();
  const {
    sub_tab, motivo, sdg, inicio_tratamiento, final: fechaFinal, diagnostico,
    fecha_cita, dr_tratante, status, comentario_solicitud,
    entrega_resultados, reportes, status_resultados, observaciones,
    tipo, resolucion, incidencia, no_acudio,
  } = req.body;

  try {
    await pool.query(
      `UPDATE sort_ges_cita_previa
       SET sub_tab = ?, motivo = ?, sdg = ?, inicio_tratamiento = ?, \`final\` = ?,
           diagnostico = ?, fecha_cita = ?, dr_tratante = ?, status = ?,
           comentario_solicitud = ?, entrega_resultados = ?, reportes = ?,
           status_resultados = ?, observaciones = ?,
           tipo = ?, resolucion = ?, incidencia = ?, no_acudio = ?
       WHERE id = ?`,
      [
        sub_tab || null, motivo || null, sdg || null,
        inicio_tratamiento || null, fechaFinal || null,
        diagnostico ? 1 : 0,
        fecha_cita || null, dr_tratante || null, status || null,
        comentario_solicitud || null, entrega_resultados || null,
        reportes || null, status_resultados || null, observaciones || null,
        tipo === 'laboratorio' ? 'laboratorio' : 'cita',
        resolucion || null, incidencia || null, serializeNoAcudio(no_acudio),
        id,
      ]
    );
    await logUpdate(
      req.session.user.id, 'progestor',
      `Actualizó Cita Previa #${id}`, today, `${id}`
    );
    res.json({ success: true });
  } catch (err) { serverError(res, err, 'updateCitaPrevia'); }
};

export const deleteCitaPrevia = async (req, res) => {
  if (!requireSession(req, res)) return;
  const { id } = req.params;
  const today = new Date();
  try {
    await pool.query('DELETE FROM sort_ges_cita_previa WHERE id = ?', [id]);
    await logDelete(
      req.session.user.id, 'progestor',
      `Eliminó Cita Previa #${id}`, today, `${id}`
    );
    res.json({ success: true });
  } catch (err) { serverError(res, err, 'deleteCitaPrevia'); }
};

// ─────────────────────────────────────────────────────────────
// Fill empty values for NOT NULL columns (without a DB default):
//  - JSON columns → the JSON literal 'null'. Valid JSON, so it passes
//    MariaDB's CHECK (json_valid(...)) on JSON columns, and the payments form
//    treats it as "not set yet" and uses its own starting values, then saves
//    the real ones on the first edit. The list reads it as "no stage paid".
//  - text / dates → '' (what the payments form sends for empty fields)
//  - numbers → 0
// Candidate data is often incomplete (no IP, bank…) and those columns may
// not accept NULL.
// ─────────────────────────────────────────────────────────────
const TEXT_TYPES = ['char', 'varchar', 'tinytext', 'text', 'mediumtext', 'longtext', 'enum', 'set'];
const NUMBER_TYPES = ['tinyint', 'smallint', 'mediumint', 'int', 'integer', 'bigint', 'decimal', 'float', 'double', 'bit'];
const DATE_TYPES = ['date', 'datetime', 'timestamp'];

const withRequiredDefaults = async (table, values, jsonColumns = []) => {
  const [required] = await pool.query(
    `SELECT COLUMN_NAME AS name, DATA_TYPE AS type
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
        AND IS_NULLABLE = 'NO' AND COLUMN_DEFAULT IS NULL
        AND EXTRA NOT LIKE '%auto_increment%'`,
    [table]
  );
  const row = { ...values };
  required.forEach(({ name, type }) => {
    if (row[name] !== null && row[name] !== undefined) return;
    const t = String(type).toLowerCase();
    // MariaDB reports JSON columns as 'longtext', so check the known JSON list first
    if (jsonColumns.includes(name) || t === 'json') row[name] = 'null';
    else if (TEXT_TYPES.includes(t) || DATE_TYPES.includes(t)) row[name] = '';
    else if (NUMBER_TYPES.includes(t)) row[name] = 0;
  });
  return row;
};

// ═════════════════════════════════════════════════════════════
// PAYMENT SCHEME (link with Listado de pagos — payments_gest)
// POST /api/sort-ges/:candidateId/payment-scheme
//
// Creates the payment scheme from the candidate's SAVED Alta Gesca data.
// CURP is the link: if a scheme already exists for that CURP (created here
// or from Listado de pagos), that one is returned — never a duplicate.
// ═════════════════════════════════════════════════════════════
export const createPaymentScheme = async (req, res) => {
  if (!requireSession(req, res)) return;
  const { candidateId } = req.params;
  try {
    const [cands] = await pool.query(
      `SELECT c.id, c.ip_responsable,
              a.nombre_completo, a.curp, a.esquema_ofrecido,
              a.banco, a.clabe_interbancaria, a.fecha_ultima_menstruacion
         FROM sort_ges_candidates c
         LEFT JOIN sort_ges_alta_gesca a ON a.candidate_id = c.id
        WHERE c.id = ?`,
      [candidateId]
    );
    if (!cands.length) return notFound(res, 'Candidate');
    const cand = cands[0];

    const curp = normalizeCurp(cand.curp);
    if (!curp) {
      return res.status(400).json({ message: 'Captura y guarda la CURP antes de generar el esquema' });
    }
    if (!isValidCurp(curp)) {
      return res.status(400).json({ message: CURP_FORMAT_MESSAGE });
    }
    if (!cand.nombre_completo) {
      return res.status(400).json({ message: 'Captura el nombre completo antes de generar el esquema' });
    }
    const schemeValue = parseSchemeAmount(cand.esquema_ofrecido);
    // "Esquema ofrecido" must be a scheme of some contract (today: Babyboom)
    const contrato = contractForScheme(schemeValue);
    if (!contrato) {
      return res.status(400).json({ message: 'Selecciona un esquema ofrecido válido antes de generar el esquema' });
    }

    // Already exists for this CURP → link to it instead of creating another
    const [existing] = await pool.query(
      'SELECT id, gesca FROM payments_gest WHERE curp = ? LIMIT 1', [curp]
    );
    if (existing.length) {
      return res.json({ id: existing[0].id, gesca: existing[0].gesca, created: false });
    }

    const row = await withRequiredDefaults('payments_gest', {
      gesca:        cand.nombre_completo,
      curp,
      ip:           cand.ip_responsable || null,
      banco:        cand.banco || null,
      clabe:        cand.clabe_interbancaria || null,
      fum:          cand.fecha_ultima_menstruacion || null,
      scheme_value: schemeValue,
      contrato,
      status:       'active',
    }, PAYMENTS_JSON_FIELDS);

    let insertId;
    try {
      const cols = Object.keys(row);
      const [result] = await pool.query(
        `INSERT INTO payments_gest (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
        Object.values(row)
      );
      insertId = result.insertId;
    } catch (err) {
      // Created from Listado de pagos at the same moment → return that one
      if (err.code === 'ER_DUP_ENTRY') {
        const [dup] = await pool.query('SELECT id, gesca FROM payments_gest WHERE curp = ? LIMIT 1', [curp]);
        if (dup.length) return res.json({ id: dup[0].id, gesca: dup[0].gesca, created: false });
      }
      throw err;
    }

    await logCreate(
      req.session.user.id,
      'progestor',
      `Creó registro de pagos - ${cand.nombre_completo} (desde Sort_GESCA #${candidateId})`,
      new Date(),
      { paymentsGestId: insertId, gesca: cand.nombre_completo, sortGesCandidateId: Number(candidateId) }
    );

    res.status(201).json({ id: insertId, gesca: cand.nombre_completo, created: true });
  } catch (err) { serverError(res, err, 'createPaymentScheme'); }
};