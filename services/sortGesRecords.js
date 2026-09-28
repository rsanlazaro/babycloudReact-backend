// backend/services/sortGesRecords.js
// Shared building blocks for SORT_GES registers, used by:
//  - sortGes.controller.js      (SORT_GES screens)
//  - paymentsGest.controller.js (a scheme created in Listado de pagos also
//                                creates its SORT_GES register, linked by CURP)
// Kept here (not in a controller) so neither controller imports the other.

import pool from '../db.js';
import { logCreate } from './activityLogger.js';
import { normalizeCurp, isValidCurp } from './curp.js';

// The 7 fixed Psico Inicial rows every candidate starts with
export const PSICO_ETAPAS = [
  'Entrevista admisión', 'Psicométrico', 'Estudios Socio Económicos',
  'HIM 1', 'HIM 2', 'HIM 3', 'HIM 4',
];

/** Insert the candidate master row + its Psico Inicial rows. Returns the new id. */
export const insertCandidate = async (db, { status = 'iniciales', ip_responsable, programa, foto_url, vinculo } = {}) => {
  const [result] = await db.query(
    'INSERT INTO sort_ges_candidates (status, ip_responsable, programa, foto_url, vinculo) VALUES (?, ?, ?, ?, ?)',
    [status, ip_responsable || null, programa || null, foto_url || null, vinculo || null]
  );
  const newId = result.insertId;
  const psicoValues = PSICO_ETAPAS.map((etapa, i) => [newId, etapa, i + 1]);
  await db.query(
    'INSERT INTO sort_ges_psico_inicial (candidate_id, etapa, etapa_orden) VALUES ?',
    [psicoValues]
  );
  return newId;
};

/** Column → value map for sort_ges_alta_gesca from a request-like body. */
export const buildAltaGescaFields = (body = {}) => {
  const {
    nombre_completo, curp, rfc, esquema_ofrecido, tel_1, tel_2, email,
    estado_civil, rni, fecha_nacimiento, banco, clabe_interbancaria,
    direccion, numero, postal, alcaldia_municipio, estado, ocupacion,
    tipo_sangre, peso, altura, imc, imc_clasificacion,
    fumador, fumador_desde, metodo_aco, tiempo_metodo_aco,
    embarazos, cesareas, partos, abortos, hijos,
    fecha_ultima_menstruacion, ultima_cesarea, locked_fields,
  } = body;

  const fields = {
    nombre_completo: nombre_completo || null,
    curp: normalizeCurp(curp) || null, // stored normalized so it links with payments_gest
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
  return fields;
};

/** 450000 → "$450,000.00" (the format of "Esquema ofrecido" in SORT_GES) */
export const formatEsquema = (value) => {
  const n = Math.round(parseFloat(value));
  return Number.isFinite(n) && n > 0
    ? `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : null;
};

/**
 * Make sure a SORT_GES register exists for a payment scheme (linked by CURP).
 *  - A candidate with that CURP already exists → nothing is created.
 *  - Otherwise → candidate (status "iniciales", programa "1", like the
 *    "Nuevo candidato" button) + Psico Inicial rows + Alta Gesca filled
 *    with the scheme's data. All in one transaction: all or nothing.
 * Returns { id, created }.
 */
export const ensureCandidateForPayment = async (payment, userId) => {
  const curp = normalizeCurp(payment.curp);
  if (!isValidCurp(curp)) throw new Error('CURP inválida para crear el registro en SORT_GES');

  const [found] = await pool.query(
    'SELECT candidate_id AS id FROM sort_ges_alta_gesca WHERE curp = ? ORDER BY candidate_id ASC LIMIT 1',
    [curp]
  );
  if (found.length) return { id: found[0].id, created: false };

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const candidateId = await insertCandidate(conn, {
      status: 'iniciales',
      ip_responsable: payment.ip,
      programa: '1',
    });

    const fields = buildAltaGescaFields({
      nombre_completo:           payment.gesca,
      curp,
      esquema_ofrecido:          formatEsquema(payment.scheme_value),
      banco:                     payment.banco,
      clabe_interbancaria:       payment.clabe,
      fecha_ultima_menstruacion: payment.fum,
    });
    const cols = ['candidate_id', ...Object.keys(fields)];
    await conn.query(
      `INSERT INTO sort_ges_alta_gesca (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
      [candidateId, ...Object.values(fields)]
    );

    await conn.commit();

    if (userId) {
      await logCreate(
        userId, 'progestor',
        `Creó gestante #${candidateId} (${payment.gesca}) desde Listado de pagos`,
        new Date(), `${candidateId}`
      );
    }
    return { id: candidateId, created: true };
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
};