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
import { findConflicts, conflictResponse } from '../services/concurrency.js';
import { guestUpdatesFromAlta, guestUniqueError, applyGuestUpdates } from '../services/ipGuestSync.js';
import { readDocs, destroyIpDoc } from '../services/ipDocs.js';

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
    // Uploaded PDFs (Check list, Crio embrio results) — read-only here, written by
    // the upload endpoints (services/ipDocs.js)
    sections.docs = byId[r.id]?.docs || {};
    const gid = sections.programa.gestante_id ? Number(sections.programa.gestante_id) : null;
    return {
      ...r,
      sections,
      gestante_id: gid,
      gestante_nombre: gid ? (gestanteNames[gid] || `Candidato #${gid}`) : null,
    };
  });
}

// ── Passport: unique id of each IP ──────────────────────────────────────────
// Stored uppercase, without spaces or dashes, so "ab 123-456" and "AB123456"
// count as the same passport. Letters and digits only, 5–20 characters.
export const normalizePasaporte = (v) =>
  typeof v === 'string' || typeof v === 'number'
    ? String(v).replace(/[\s-]+/g, '').toUpperCase()
    : '';
const PASAPORTE_REGEX = /^[A-Z0-9]{5,20}$/;
const PASAPORTE_FORMAT_MESSAGE = 'El pasaporte debe tener entre 5 y 20 letras o números';

/** The IP (id, nombre) that already uses this passport, if any */
async function findByPasaporte(db, pasaporte, exceptId = null) {
  const params = [pasaporte];
  let sql = 'SELECT id, nombre_completo FROM sort_ip_candidates WHERE pasaporte = ?';
  if (exceptId) { sql += ' AND id <> ?'; params.push(exceptId); }
  const [rows] = await db.query(`${sql} LIMIT 1`, params);
  return rows[0] || null;
}

const duplicatePasaporte = (res, ip) =>
  res.status(409).json({
    code: 'DUPLICATE_PASAPORTE',
    message: `Ya existe un registro IP con este pasaporte: ${ip.nombre_completo} (#${ip.id})`,
    existingId: ip.id,
  });

const SELECT_IPS = `
  SELECT c.id, c.nombre_completo, c.pasaporte, c.foto_url, c.guest_id, c.status, c.created_at, c.updated_at,
         g.username AS guest_username, g.mail AS guest_mail
    FROM sort_ip_candidates c
    LEFT JOIN guests g ON g.id = c.guest_id`;

/** 409 if the guest account doesn't exist or is already linked to another IP */
async function guestLinkError(guestId, exceptIpId = null) {
  if (!guestId) return null;
  const [g] = await pool.query('SELECT id, profile FROM guests WHERE id = ?', [guestId]);
  if (!g.length) return { status: 400, message: 'La cuenta Cloud IPS seleccionada no existe' };
  // Only Guests with the IP profile can be linked (an older link to another
  // profile is kept as long as it isn't changed)
  if (g[0].profile !== 'ip') {
    let keepsCurrent = false;
    if (exceptIpId) {
      const [cur] = await pool.query('SELECT guest_id FROM sort_ip_candidates WHERE id = ?', [exceptIpId]);
      keepsCurrent = Number(cur[0]?.guest_id) === Number(guestId);
    }
    if (!keepsCurrent) return { status: 400, message: 'Solo se pueden vincular cuentas de Guests con perfil IP' };
  }
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
    const ip = (await withSections(rows))[0];
    // "Contraseña (Guests)" in Alta IP is the linked account's password (only in
    // the single-register response, never in the list)
    ip.guest_password = null;
    if (ip.guest_id) {
      const [[g]] = await pool.query('SELECT password FROM guests WHERE id = ?', [ip.guest_id]);
      ip.guest_password = g?.password ?? null;
    }
    res.json(ip);
  } catch (err) { serverError(res, err, 'getIp'); }
};

// Same password rule as Guests (frontend Guests.js → validatePassword)
export const guestPasswordError = (password) => {
  const p = String(password ?? '');
  if (!p.trim()) return 'La contraseña es obligatoria';
  if (p.length < 6) return 'La contraseña debe tener al menos 6 caracteres';
  if (!/(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/.test(p)) return 'La contraseña debe contener una mayúscula, una minúscula y un número';
  return '';
};

// PUT /api/sort-ip/:id/guest-password  { password }
// Alta IP → "Contraseña (Guests)": changes the password of the linked Guests
// account (the IP's Cloud IPS login). Nothing is stored in Sort_IPS itself.
export const updateGuestPassword = async (req, res) => {
  if (!requireSession(req, res)) return;
  const { id } = req.params;
  const password = String(req.body?.password ?? '');
  const invalid = guestPasswordError(password);
  if (invalid) return res.status(400).json({ message: invalid });
  try {
    const [[ip]] = await pool.query('SELECT guest_id, nombre_completo FROM sort_ip_candidates WHERE id = ?', [id]);
    if (!ip) return res.status(404).json({ message: 'Registro IP no encontrado' });
    if (!ip.guest_id) return res.status(400).json({ message: 'Este registro no tiene una cuenta de Guests vinculada' });
    await pool.query('UPDATE guests SET password = ? WHERE id = ?', [password, ip.guest_id]);
    await logUpdate(req.session.user.id, 'babysite', `Cambió la contraseña de Guests del IP #${id} (${ip.nombre_completo})`, new Date(), `${id}`);
    res.json({ success: true });
  } catch (err) { serverError(res, err, 'updateGuestPassword'); }
};

// PUT /api/sort-ip/:id/foto  { fotoUrl } — profile photo (uploaded to Cloudinary by the browser)
export const updateIpFoto = async (req, res) => {
  if (!requireSession(req, res)) return;
  const { id } = req.params;
  const fotoUrl = req.body?.fotoUrl ? String(req.body.fotoUrl) : null;
  // Only images of this Cloudinary account (or null to remove)
  if (fotoUrl && !fotoUrl.startsWith(`https://res.cloudinary.com/${process.env.CLOUDINARY_CLOUD_NAME}/`)) {
    return res.status(400).json({ message: 'URL de foto inválida' });
  }
  try {
    const [result] = await pool.query('UPDATE sort_ip_candidates SET foto_url = ? WHERE id = ?', [fotoUrl, id]);
    if (!result.affectedRows) return res.status(404).json({ message: 'Registro IP no encontrado' });
    await logUpdate(req.session.user.id, 'progestor', `Actualizó foto del IP #${id}`, new Date(), `${id}`);
    res.json({ success: true, foto_url: fotoUrl });
  } catch (err) { serverError(res, err, 'updateIpFoto'); }
};

// GET /api/sort-ip/guests-available?except=:ipId — guest accounts not linked to another IP
export const getAvailableGuests = async (req, res) => {
  if (!requireSession(req, res)) return;
  try {
    // Guests with the IP profile that aren't linked to another Sort_IPS register
    // (plus, when editing, the account this register already has)
    const except = req.query.except ? Number(req.query.except) : null;
    const [rows] = await pool.query(
      `SELECT g.id, g.username, g.mail, g.phone, g.profile, g.enabled
         FROM guests g
        WHERE (g.profile = 'ip' ${except ? 'OR g.id = (SELECT guest_id FROM sort_ip_candidates WHERE id = ?)' : ''})
          AND NOT EXISTS (
            SELECT 1 FROM sort_ip_candidates c
             WHERE c.guest_id = g.id ${except ? 'AND c.id <> ?' : ''}
          )
        ORDER BY g.username ASC`,
      except ? [except, except] : []
    );
    res.json(rows);
  } catch (err) { serverError(res, err, 'getAvailableGuests'); }
};

// GET /api/sort-ip/pasaporte/:pasaporte?except=:id — is this passport already registered?
export const lookupPasaporte = async (req, res) => {
  if (!requireSession(req, res)) return;
  try {
    const pasaporte = normalizePasaporte(req.params.pasaporte);
    if (!PASAPORTE_REGEX.test(pasaporte)) return res.json({ pasaporte, valid: false, ip: null });
    const except = req.query.except ? Number(req.query.except) : null;
    res.json({ pasaporte, valid: true, ip: await findByPasaporte(pool, pasaporte, except) });
  } catch (err) { serverError(res, err, 'lookupPasaporte'); }
};

// POST /api/sort-ip  { nombre_completo, pasaporte, guest_id?, alta?: {...} }
export const createIp = async (req, res) => {
  if (!requireSession(req, res)) return;
  const nombre = String(req.body.nombre_completo || '').trim();
  const pasaporte = normalizePasaporte(req.body.pasaporte ?? req.body.alta?.pasaporte);
  const guestId = req.body.guest_id ? Number(req.body.guest_id) : null;
  if (!nombre) return res.status(400).json({ message: 'El nombre del IP es obligatorio' });
  if (!pasaporte) return res.status(400).json({ message: 'El pasaporte es obligatorio' });
  if (!PASAPORTE_REGEX.test(pasaporte)) return res.status(400).json({ message: PASAPORTE_FORMAT_MESSAGE });

  const conn = await pool.getConnection();
  try {
    const dup = await findByPasaporte(pool, pasaporte);
    if (dup) return duplicatePasaporte(res, dup);

    const linkErr = await guestLinkError(guestId);
    if (linkErr) return res.status(linkErr.status).json({ message: linkErr.message });

    // Linked Guests account gets the register's name/email/phone (two-way sync)
    const guestUpdates = guestId
      ? guestUpdatesFromAlta({ ...(req.body.alta || {}), nombre_completo: nombre }, ['nombre_completo', 'email', 'telefono'])
      : {};
    const guestErr = guestId ? await guestUniqueError(guestId, guestUpdates) : null;
    if (guestErr) return res.status(409).json(guestErr);

    await conn.beginTransaction();
    const [result] = await conn.query(
      'INSERT INTO sort_ip_candidates (nombre_completo, pasaporte, guest_id, created_by) VALUES (?, ?, ?, ?)',
      [nombre, pasaporte, guestId, req.session.user.id]
    );
    const newId = result.insertId;
    const alta = { ...(req.body.alta || {}), nombre_completo: nombre, pasaporte };
    await conn.query(
      'INSERT INTO sort_ip_sections (candidate_id, section, data, updated_by) VALUES (?, ?, ?, ?)',
      [newId, 'alta', JSON.stringify(alta), req.session.user.id]
    );
    await conn.commit();
    await applyGuestUpdates(guestId, guestUpdates);

    await logCreate(req.session.user.id, 'babysite', `Creó registro Sort_IPS #${newId} (${nombre})`, new Date(), `${newId}`);
    res.status(201).json({ id: newId });
  } catch (err) {
    await conn.rollback().catch(() => {});
    // Same passport registered by someone else at the same moment → unique index
    if (err.code === 'ER_DUP_ENTRY') {
      const dup = await findByPasaporte(pool, pasaporte).catch(() => null);
      if (dup) return duplicatePasaporte(res, dup);
    }
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

    // Name change → linked Guests account's username (two-way sync)
    let syncGuestId = null, guestUpdates = {};
    if ('nombre_completo' in req.body) {
      const [[cur]] = await pool.query('SELECT guest_id FROM sort_ip_candidates WHERE id = ?', [id]);
      syncGuestId = 'guest_id' in req.body ? (req.body.guest_id ? Number(req.body.guest_id) : null) : cur?.guest_id;
      guestUpdates = guestUpdatesFromAlta({ nombre_completo: req.body.nombre_completo }, ['nombre_completo']);
      const guestErr = syncGuestId ? await guestUniqueError(syncGuestId, guestUpdates) : null;
      if (guestErr) return res.status(409).json(guestErr);
    }

    await pool.query(`UPDATE sort_ip_candidates SET ${sets.join(', ')} WHERE id = ?`, [...params, id]);
    if (syncGuestId) await applyGuestUpdates(syncGuestId, guestUpdates);
    await logUpdate(req.session.user.id, 'babysite', `Actualizó registro Sort_IPS #${id}`, new Date(), `${id}`);
    const [rows] = await pool.query(`${SELECT_IPS} WHERE c.id = ?`, [id]);
    res.json((await withSections(rows))[0]);
  } catch (err) { serverError(res, err, 'updateIp'); }
};

// PUT /api/sort-ip/:id/sections/:section
//   { changes: {...}, _original: {...} }  → only those fields are merged into the
//                                           stored tab; refused (409) if another
//                                           user changed one of them meanwhile
//   { data: {...} }                        → legacy: replaces the whole tab
export const saveSection = async (req, res) => {
  if (!requireSession(req, res)) return;
  const { id, section } = req.params;
  if (!SECTION_KEYS.includes(section)) return res.status(400).json({ message: 'Sección inválida' });
  const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
  const changes = req.body?.changes;
  if (!isObj(changes) && !isObj(req.body?.data)) {
    return res.status(400).json({ message: 'Datos inválidos' });
  }
  try {
    const [exists] = await pool.query('SELECT id FROM sort_ip_candidates WHERE id = ?', [id]);
    if (!exists.length) return res.status(404).json({ message: 'Registro IP no encontrado' });

    let data;
    if (isObj(changes)) {
      const [rows] = await pool.query(
        'SELECT data FROM sort_ip_sections WHERE candidate_id = ? AND section = ?', [id, section]
      );
      const current = parseData(rows[0]?.data);
      if (isObj(req.body._original)) {
        const conflicts = findConflicts(current, req.body._original, changes);
        if (conflicts.length) return conflictResponse(res, conflicts, current);
      }
      data = { ...current, ...changes };
    } else {
      data = req.body.data;
    }

    // Linked Guests account to keep in sync (Alta IP only, see services/ipGuestSync.js)
    let syncGuestId = null;
    let guestUpdates = {};

    // Alta IP holds the IP's name and passport → keep the register's columns in sync
    if (section === 'alta') {
      const nombre = String(data.nombre_completo || '').trim();
      if (!nombre) return res.status(400).json({ message: 'El nombre del IP es obligatorio' });
      data.nombre_completo = nombre;

      const [[cur]] = await pool.query('SELECT pasaporte FROM sort_ip_candidates WHERE id = ?', [id]);
      // Alta data saved without the key (out of sync with the column) → keep the column's value
      if (data.pasaporte === undefined && cur?.pasaporte) data.pasaporte = cur.pasaporte;
      const pasaporte = normalizePasaporte(data.pasaporte);
      if (!pasaporte) {
        // Required: once set it can be changed but not removed
        if (cur?.pasaporte) return res.status(400).json({ message: 'El pasaporte es obligatorio y no puede quedar vacío' });
      } else {
        if (!PASAPORTE_REGEX.test(pasaporte)) return res.status(400).json({ message: PASAPORTE_FORMAT_MESSAGE });
        const dup = await findByPasaporte(pool, pasaporte, id);
        if (dup) return duplicatePasaporte(res, dup);
      }
      data.pasaporte = pasaporte || '';

      // Two-way sync: changed name/email/phone also go to the linked Guests account.
      // Checked here, before anything is written, so both sides never disagree.
      const [[link]] = await pool.query('SELECT guest_id FROM sort_ip_candidates WHERE id = ?', [id]);
      syncGuestId = link?.guest_id || null;
      guestUpdates = syncGuestId
        ? guestUpdatesFromAlta(data, isObj(changes) ? Object.keys(changes) : ['nombre_completo', 'email', 'telefono'])
        : {};
      if (syncGuestId) {
        const guestErr = await guestUniqueError(syncGuestId, guestUpdates);
        if (guestErr) return res.status(409).json(guestErr);
      }

      try {
        await pool.query(
          'UPDATE sort_ip_candidates SET nombre_completo = ?, pasaporte = ? WHERE id = ?',
          [nombre, pasaporte || null, id]
        );
      } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') {
          const dup = await findByPasaporte(pool, pasaporte, id).catch(() => null);
          if (dup) return duplicatePasaporte(res, dup);
        }
        throw err;
      }
    }

    await pool.query(
      `INSERT INTO sort_ip_sections (candidate_id, section, data, updated_by)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE data = VALUES(data), updated_by = VALUES(updated_by)`,
      [id, section, JSON.stringify(data), req.session.user.id]
    );
    await pool.query('UPDATE sort_ip_candidates SET updated_at = CURRENT_TIMESTAMP WHERE id = ?', [id]);
    if (section === 'alta' && syncGuestId) await applyGuestUpdates(syncGuestId, guestUpdates);
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
    // Its PDFs are removed from Cloudinary once the delete succeeds
    const docs = await readDocs(id).catch(() => ({}));
    await conn.beginTransaction();
    await conn.query('DELETE FROM sort_ip_sections WHERE candidate_id = ?', [id]);
    const [r] = await conn.query('DELETE FROM sort_ip_candidates WHERE id = ?', [id]);
    await conn.commit();
    if (!r.affectedRows) return res.status(404).json({ message: 'Registro IP no encontrado' });
    for (const [docKey, doc] of Object.entries(docs)) await destroyIpDoc(id, docKey, doc?.url);
    await logDelete(req.session.user.id, 'babysite', `Eliminó registro Sort_IPS #${id}`, new Date(), `${id}`);
    res.json({ success: true });
  } catch (err) {
    await conn.rollback().catch(() => {});
    serverError(res, err, 'deleteIp');
  } finally {
    conn.release();
  }
};