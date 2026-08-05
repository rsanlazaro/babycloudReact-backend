// controllers/sortGes.controller.js
import pool from '../db.js';
import {
  logCreate,
  logUpdate,
  logDelete,
} from '../services/activityLogger.js';

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
      `SELECT c.id, c.status, c.ip_responsable, c.foto_url, c.created_at,
              a.nombre_completo, a.curp, a.fecha_nacimiento,
              a.tel_1 AS telefono, a.email,
              a.tipo_sangre, a.peso, a.altura, a.imc,
              a.metodo_aco, a.embarazos, a.cesareas, a.partos, a.abortos, a.hijos
       FROM sort_ges_candidates c
       LEFT JOIN sort_ges_alta_gesca a ON a.candidate_id = c.id
       ORDER BY c.created_at DESC`
    );
    res.json(rows);
  } catch (err) { serverError(res, err, 'getAllCandidates'); }
};

export const getCandidate = async (req, res) => {
  if (!requireSession(req, res)) return;
  const { id } = req.params;
  try {
    const [rows] = await pool.query(
      `SELECT c.id, c.status, c.ip_responsable, c.foto_url, c.created_at,
              a.nombre_completo, a.curp, a.fecha_nacimiento,
              a.tel_1 AS telefono, a.email,
              a.direccion, a.numero, a.postal,
              a.alcaldia_municipio AS ciudad, a.estado,
              a.tipo_sangre, a.peso, a.altura, a.imc,
              a.metodo_aco, a.embarazos, a.cesareas, a.partos, a.abortos, a.hijos,
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
  const { status = 'iniciales', ip_responsable, foto_url } = req.body;
  const today = new Date();
  try {
    const [result] = await pool.query(
      'INSERT INTO sort_ges_candidates (status, ip_responsable, foto_url) VALUES (?, ?, ?)',
      [status, ip_responsable || null, foto_url || null]
    );
    const newId = result.insertId;

    // Seed the 7 fixed psico_inicial rows
    const etapas = [
      'Entrevista admisión', 'Psicométrico', 'Estudios Socio Económicos',
      'HIM 1', 'HIM 2', 'HIM 3', 'HIM 4',
    ];
    const psicoValues = etapas.map((etapa, i) => [newId, etapa, i + 1]);
    await pool.query(
      'INSERT INTO sort_ges_psico_inicial (candidate_id, etapa, etapa_orden) VALUES ?',
      [psicoValues]
    );

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
  const { status, ip_responsable, foto_url } = req.body;
  const today = new Date();
  try {
    await pool.query(
      'UPDATE sort_ges_candidates SET status = ?, ip_responsable = ?, foto_url = ? WHERE id = ?',
      [status, ip_responsable || null, foto_url || null, id]
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
  const {
    nombre_completo, curp, rfc, esquema_ofrecido, tel_1, tel_2, email,
    estado_civil, rni, fecha_nacimiento, banco, clabe_interbancaria,
    direccion, numero, postal, alcaldia_municipio, estado, ocupacion,
    tipo_sangre, peso, altura, imc, imc_clasificacion,
    fumador, fumador_desde, metodo_aco, tiempo_metodo_aco,
    embarazos, cesareas, partos, abortos, hijos,
    fecha_ultima_menstruacion, ultima_cesarea, locked_fields,
  } = req.body;

  // Required fields
  if (!nombre_completo || !nombre_completo.trim()) {
    return res.status(400).json({ message: 'El nombre completo es obligatorio' });
  }
  if (!fecha_nacimiento) {
    return res.status(400).json({ message: 'La fecha de nacimiento es obligatoria' });
  }
  if (!tel_1 || !tel_1.trim()) {
    return res.status(400).json({ message: 'El teléfono es obligatorio' });
  }
  if (!/^[0-9+\-\s()]+$/.test(tel_1) || tel_1.replace(/\D/g, '').length < 10) {
    return res.status(400).json({ message: 'El teléfono solo debe contener números (10 dígitos mínimo)' });
  }
  if (!email || !email.trim()) {
    return res.status(400).json({ message: 'El email es obligatorio' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ message: 'Ingresa un email válido' });
  }

  const fields = {
    nombre_completo: nombre_completo || null,
    curp: curp || null,
    rfc: rfc || null,
    esquema_ofrecido: esquema_ofrecido || null,
    tel_1: tel_1 || null,
    tel_2: tel_2 || null,
    email: email || null,
    estado_civil: estado_civil || null,
    rni: rni || null,
    fecha_nacimiento: fecha_nacimiento || null,
    banco: banco || null,
    clabe_interbancaria: clabe_interbancaria || null,
    direccion: direccion || null,
    numero: numero || null,
    postal: postal || null,
    alcaldia_municipio: alcaldia_municipio || null,
    estado: estado || null,
    ocupacion: ocupacion || null,
    tipo_sangre: tipo_sangre || null,
    peso: peso || null,
    altura: altura || null,
    imc: imc || null,
    imc_clasificacion: imc_clasificacion || null,
    fumador: fumador ? 1 : 0,
    fumador_desde: fumador_desde || null,
    metodo_aco: metodo_aco || null,
    tiempo_metodo_aco: tiempo_metodo_aco || null,
    embarazos: embarazos || 0,
    cesareas: cesareas || 0,
    partos: partos || 0,
    abortos: abortos || 0,
    hijos: hijos || 0,
    fecha_ultima_menstruacion: fecha_ultima_menstruacion || null,
    ultima_cesarea: ultima_cesarea || null,
    locked_fields: locked_fields ? JSON.stringify(locked_fields) : null,
  };

  try {
    // Prevent duplicate phone numbers across candidates (normalized to digits only)
    const normalizedPhone = tel_1.replace(/\D/g, '');
    if (normalizedPhone) {
      const [allPhones] = await pool.query(
        `SELECT candidate_id, tel_1 FROM sort_ges_alta_gesca
         WHERE candidate_id != ? AND tel_1 IS NOT NULL AND tel_1 != ''`,
        [candidateId]
      );
      const duplicate = allPhones.some(
        (row) => row.tel_1.replace(/\D/g, '') === normalizedPhone
      );
      if (duplicate) {
        return res.status(409).json({
          message: 'Ya existe un candidato registrado con este número de teléfono',
        });
      }
    }

    const [existing] = await pool.query(
      'SELECT id FROM sort_ges_alta_gesca WHERE candidate_id = ?', [candidateId]
    );

    if (existing.length === 0) {
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
    aseguradora, numero_poliza, gestor, tipo_pago, valor_cuota, total_estimado,
    fecha_solicitud, fecha_alta, fecha_liberacion, fecha_vencimiento,
    pagos = [],
  } = req.body;

  try {
    const [result] = await pool.query(
      `INSERT INTO sort_ges_seguro_mat
         (candidate_id, aseguradora, numero_poliza, gestor, tipo_pago,
          valor_cuota, total_estimado, fecha_solicitud, fecha_alta,
          fecha_liberacion, fecha_vencimiento)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        candidateId,
        aseguradora || null, numero_poliza || null, gestor || null,
        tipo_pago || null, valor_cuota || null, total_estimado || null,
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
    aseguradora, numero_poliza, gestor, tipo_pago, valor_cuota, total_estimado,
    fecha_solicitud, fecha_alta, fecha_liberacion, fecha_vencimiento,
    rebuildPagos = false, pagos = [],
  } = req.body;

  try {
    await pool.query(
      `UPDATE sort_ges_seguro_mat
       SET aseguradora = ?, numero_poliza = ?, gestor = ?, tipo_pago = ?,
           valor_cuota = ?, total_estimado = ?, fecha_solicitud = ?,
           fecha_alta = ?, fecha_liberacion = ?, fecha_vencimiento = ?
       WHERE id = ?`,
      [
        aseguradora || null, numero_poliza || null, gestor || null,
        tipo_pago || null, valor_cuota || null, total_estimado || null,
        fecha_solicitud || null, fecha_alta || null,
        fecha_liberacion || null, fecha_vencimiento || null, id,
      ]
    );

    if (rebuildPagos && pagos.length > 0) {
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
  try {
    await pool.query('DELETE FROM sort_ges_seguro_mat WHERE id = ?', [id]);
    await logDelete(
      req.session.user.id, 'progestor',
      `Eliminó Seguro Maternidad #${id}`, today, `${id}`
    );
    res.json({ success: true });
  } catch (err) { serverError(res, err, 'deleteSeguroMat'); }
};

export const updateCuotaPago = async (req, res) => {
  if (!requireSession(req, res)) return;
  const { polizaId, cuotaNum } = req.params;
  const today = new Date();
  const { monto_pago, fecha_pago, status } = req.body;

  try {
    await pool.query(
      `UPDATE sort_ges_seguro_mat_cuotas
       SET monto_pago = ?, fecha_pago = ?, status = ?
       WHERE seguro_mat_id = ? AND cuota_num = ?`,
      [monto_pago || null, fecha_pago || null, status || 'pendiente', polizaId, cuotaNum]
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
    await pool.query(
      `UPDATE sort_ges_seguro_mat_cuotas
       SET monto_pago = NULL, fecha_pago = NULL, status = 'pendiente'
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