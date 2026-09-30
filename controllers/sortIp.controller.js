// backend/controllers/sortIp.controller.js
// Sort_IPS (Baby site) — registers of IPs (intended parents).
//
// Data model (tables created by migrations/ensureSchema.js):
//   sort_ip_candidates  one row per IP: name, optional link to its guest
//                       account (Cloud IPS login), status, timestamps
//   sort_ip_sections    one row per IP × tab (alta, checklist, crio,
//                       preparacion, programa); `data` = JSON with that tab's
//                       fields. Fields are defined in the frontend
//                       (src/config/sortIpSections.js), so adding or renaming
//                       fields needs no database change.

import pool from '../db.js';
import { logCreate, logUpdate, logDelete } from '../services/activityLogger.js';

export const SECTION_KEYS = ['alta', 'checklist', 'crio', 'preparacion', 'programa'];

const requireSession = (req, res) => {
  if (!req.session?.user) { res.status(401).json({ message: 'Unauthorized' }); return false; }
  return true;
};
const serverError = (res, err, where) => {
  console.error(`SORT IP ERROR [${where}]:`, err);
  res.status(500).json({ message: 'Error del servidor' });
};
const parseData = (v) => {
  if (!v) return {};
  if (typeof v === 'object') return v;
  try { return JSON.parse(v) || {}; } catch { return {}; }
};

/** Attach { sections: { alta: {...}, ... }, gestante_nombre } to IP rows. */
async function withSections(rows) {
  if (!rows.length) return rows;
  const ids = rows.map(r => r.id);
  const [secs] = await pool.query(
    'SELECT candidate_id, section, data, updated_at FROM sort_ip_sections WHERE candidate_id IN (?)',
    [ids]
  );
  const byId = {};
  secs.forEach(s => {
    (byId[s.candidate_id] ||= {})[s.section] = parseData(s.data);
  });

  // Gestante assigned in "Programa" → her name from Sort_GESCA
  const gestanteIds = [...new Set(
    Object.values(byId).map(s => s.programa?.gestante_id).filter(Boolean).map(Number)
  )];
  const gestanteNames = {};
  if (gestanteIds.length) {
    const [gs] = await pool.query(
      'SELECT candidate_id, nombre_completo FROM sort_ges_alta_gesca WHERE candidate_id IN (?)',
      [gestanteIds]
    );
    gs.forEach(g => { gestanteNames[g.candidate_id] = g.nombre_completo; });
  }

  return rows.map(r => {
    const sections = {};
    SECTION_KEYS.forEach(k => { sections[k] = byId[r.id]?.[k] || {}; });
    const gid = sections.programa.gestante_id ? Number(sections.programa.gestante_id) : null;
    return {
      ...r,
      sections,
      gestante_id: gid,
      gestante_nombre: gid ? (gestanteNames[gid] || `Candidato #${gid}`) : null,
    };
  });
}

const SELECT_IPS = `
  SELECT c.id, c.nombre_completo, c.guest_id, c.status, c.created_at, c.updated_at,
         g.username AS guest_username, g.mail AS guest_mail
    FROM sort_ip_candidates c
    LEFT JOIN guests g ON g.id = c.guest_id`;

/** 409 if the guest account doesn't exist or is already linked to another IP */
async function guestLinkError(guestId, exceptIpId = null) {
  if (!guestId) return null;
  const [g] = await pool.query('SELECT id FROM guests WHERE id = ?', [guestId]);
  if (!g.length) return { status: 400, message: 'La cuenta Cloud IPS seleccionada no existe' };
  const params = [guestId];
  let sql = 'SELECT id, nombre_completo FROM sort_ip_candidates WHERE guest_id = ?';
  if (exceptIpId) { sql += ' AND id <> ?'; params.push(exceptIpId); }
  const [used] = await pool.query(sql, params);
  if (used.length) {
    return { status: 409, message: `Esa cuenta Cloud IPS ya está vinculada a ${used[0].nombre_completo}` };
  }
  return null;
}

// GET /api/sort-ip
export const getAllIps = async (req, res) => {
  if (!requireSession(req, res)) return;
  try {
    const [rows] = await pool.query(`${SELECT_IPS} ORDER BY c.created_at DESC`);
    res.json(await withSections(rows));
  } catch (err) { serverError(res, err, 'getAllIps'); }
};

// GET /api/sort-ip/:id
export const getIp = async (req, res) => {
  if (!requireSession(req, res)) return;
  try {
    const [rows] = await pool.query(`${SELECT_IPS} WHERE c.id = ?`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ message: 'Registro IP no encontrado' });
    res.json((await withSections(rows))[0]);
  } catch (err) { serverError(res, err, 'getIp'); }
};

// GET /api/sort-ip/guests-available?except=:ipId — guest accounts not linked to another IP
export const getAvailableGuests = async (req, res) => {
  if (!requireSession(req, res)) return;
  try {
    const except = req.query.except ? Number(req.query.except) : null;
    const [rows] = await pool.query(
      `SELECT g.id, g.username, g.mail
         FROM guests g
        WHERE NOT EXISTS (
          SELECT 1 FROM sort_ip_candidates c
           WHERE c.guest_id = g.id ${except ? 'AND c.id <> ?' : ''}
        )
        ORDER BY g.username ASC`,
      except ? [except] : []
    );
    res.json(rows);
  } catch (err) { serverError(res, err, 'getAvailableGuests'); }
};

// POST /api/sort-ip  { nombre_completo, guest_id?, alta?: {...} }
export const createIp = async (req, res) => {
  if (!requireSession(req, res)) return;
  const nombre = String(req.body.nombre_completo || '').trim();
  const guestId = req.body.guest_id ? Number(req.body.guest_id) : null;
  if (!nombre) return res.status(400).json({ message: 'El nombre del IP es obligatorio' });

  const conn = await pool.getConnection();
  try {
    const linkErr = await guestLinkError(guestId);
    if (linkErr) return res.status(linkErr.status).json({ message: linkErr.message });

    await conn.beginTransaction();
    const [result] = await conn.query(
      'INSERT INTO sort_ip_candidates (nombre_completo, guest_id, created_by) VALUES (?, ?, ?)',
      [nombre, guestId, req.session.user.id]
    );
    const newId = result.insertId;
    const alta = { ...(req.body.alta || {}), nombre_completo: nombre };
    await conn.query(
      'INSERT INTO sort_ip_sections (candidate_id, section, data, updated_by) VALUES (?, ?, ?, ?)',
      [newId, 'alta', JSON.stringify(alta), req.session.user.id]
    );
    await conn.commit();

    await logCreate(req.session.user.id, 'babysite', `Creó registro Sort_IPS #${newId} (${nombre})`, new Date(), `${newId}`);
    res.status(201).json({ id: newId });
  } catch (err) {
    await conn.rollback().catch(() => {});
    serverError(res, err, 'createIp');
  } finally {
    conn.release();
  }
};

// PUT /api/sort-ip/:id  { nombre_completo?, guest_id?, status? }
export const updateIp = async (req, res) => {
  if (!requireSession(req, res)) return;
  const { id } = req.params;
  try {
    const [exists] = await pool.query('SELECT id FROM sort_ip_candidates WHERE id = ?', [id]);
    if (!exists.length) return res.status(404).json({ message: 'Registro IP no encontrado' });

    const sets = [], params = [];
    if ('nombre_completo' in req.body) {
      const nombre = String(req.body.nombre_completo || '').trim();
      if (!nombre) return res.status(400).json({ message: 'El nombre del IP es obligatorio' });
      sets.push('nombre_completo = ?'); params.push(nombre);
    }
    if ('guest_id' in req.body) {
      const guestId = req.body.guest_id ? Number(req.body.guest_id) : null;
      const linkErr = await guestLinkError(guestId, id);
      if (linkErr) return res.status(linkErr.status).json({ message: linkErr.message });
      sets.push('guest_id = ?'); params.push(guestId);
    }
    if ('status' in req.body) { sets.push('status = ?'); params.push(req.body.status || 'activo'); }
    if (!sets.length) return res.status(400).json({ message: 'Sin cambios' });

    await pool.query(`UPDATE sort_ip_candidates SET ${sets.join(', ')} WHERE id = ?`, [...params, id]);
    await logUpdate(req.session.user.id, 'babysite', `Actualizó registro Sort_IPS #${id}`, new Date(), `${id}`);
    const [rows] = await pool.query(`${SELECT_IPS} WHERE c.id = ?`, [id]);
    res.json((await withSections(rows))[0]);
  } catch (err) { serverError(res, err, 'updateIp'); }
};

// PUT /api/sort-ip/:id/sections/:section  { data: {...} }
export const saveSection = async (req, res) => {
  if (!requireSession(req, res)) return;
  const { id, section } = req.params;
  if (!SECTION_KEYS.includes(section)) return res.status(400).json({ message: 'Sección inválida' });
  const data = req.body?.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return res.status(400).json({ message: 'Datos inválidos' });
  }
  try {
    const [exists] = await pool.query('SELECT id FROM sort_ip_candidates WHERE id = ?', [id]);
    if (!exists.length) return res.status(404).json({ message: 'Registro IP no encontrado' });

    // Alta IP holds the IP's name → keep the register's name in sync
    if (section === 'alta') {
      const nombre = String(data.nombre_completo || '').trim();
      if (!nombre) return res.status(400).json({ message: 'El nombre del IP es obligatorio' });
      data.nombre_completo = nombre;
      await pool.query('UPDATE sort_ip_candidates SET nombre_completo = ? WHERE id = ?', [nombre, id]);
    }

    await pool.query(
      `INSERT INTO sort_ip_sections (candidate_id, section, data, updated_by)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE data = VALUES(data), updated_by = VALUES(updated_by)`,
      [id, section, JSON.stringify(data), req.session.user.id]
    );
    await pool.query('UPDATE sort_ip_candidates SET updated_at = CURRENT_TIMESTAMP WHERE id = ?', [id]);
    await logUpdate(req.session.user.id, 'babysite', `Actualizó ${section} de Sort_IPS #${id}`, new Date(), `${id}`);
    res.json({ success: true, section, data });
  } catch (err) { serverError(res, err, 'saveSection'); }
};

// DELETE /api/sort-ip/:id — sections are removed with it (ON DELETE CASCADE)
export const deleteIp = async (req, res) => {
  if (!requireSession(req, res)) return;
  const { id } = req.params;
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('DELETE FROM sort_ip_sections WHERE candidate_id = ?', [id]);
    const [r] = await conn.query('DELETE FROM sort_ip_candidates WHERE id = ?', [id]);
    await conn.commit();
    if (!r.affectedRows) return res.status(404).json({ message: 'Registro IP no encontrado' });
    await logDelete(req.session.user.id, 'babysite', `Eliminó registro Sort_IPS #${id}`, new Date(), `${id}`);
    res.json({ success: true });
  } catch (err) {
    await conn.rollback().catch(() => {});
    serverError(res, err, 'deleteIp');
  } finally {
    conn.release();
  }
};