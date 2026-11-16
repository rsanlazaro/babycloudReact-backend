// backend/services/ipPareja.js
// "Linkar pareja": links two Sort_IPS registers (a couple), found by the
// partner's PASSPORT number. Stored in each register's Alta IP data:
//   pareja_ip_id → id of the partner's register
//   pareja_link  → the partner's passport
//   pareja_ip_nombre → the partner's name (for display)
// The link is mutual: linking A → B also sets B → A (and frees any previous
// partner of A or B); unlinking A also clears B if it pointed to A.

import pool from '../db.js';

const parseData = (v) => {
  if (!v) return {};
  if (typeof v === 'object') return v;
  try { return JSON.parse(v) || {}; } catch { return {}; }
};
const normalize = (v) => String(v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/** Another IP register with this passport → { id, nombre_completo, pasaporte } | null */
export const findPareja = async (pasaporte, selfId = null, db = pool) => {
  const p = normalize(pasaporte);
  if (!p) return null;
  const [rows] = await db.query(
    'SELECT id, nombre_completo, pasaporte FROM sort_ip_candidates WHERE pasaporte = ? AND id <> ? LIMIT 1',
    [p, selfId || 0]
  );
  return rows[0] || null;
};

const readAlta = async (db, ipId) => {
  const [rows] = await db.query("SELECT data FROM sort_ip_sections WHERE candidate_id = ? AND section = 'alta'", [ipId]);
  return parseData(rows[0]?.data);
};
const writeAlta = async (db, ipId, data) => {
  await db.query(
    `INSERT INTO sort_ip_sections (candidate_id, section, data, updated_by)
     VALUES (?, 'alta', ?, NULL)
     ON DUPLICATE KEY UPDATE data = VALUES(data)`,
    [ipId, JSON.stringify(data)]
  );
};
const setLink = async (db, ipId, partner) => {
  const alta = await readAlta(db, ipId);
  alta.pareja_ip_id = partner ? partner.id : '';
  alta.pareja_link = partner ? (partner.pasaporte || '') : '';
  alta.pareja_ip_nombre = partner ? (partner.nombre_completo || '') : '';
  await writeAlta(db, ipId, alta);
};

/**
 * Makes the PARTNER side match ipId's new link (ipId's own Alta IP data is
 * saved by the caller). Call after saving, with ipId's previous partner id.
 */
export const mirrorParejaLink = async (ipId, newPartnerId, prevPartnerId, db = pool) => {
  const id = Number(ipId);
  const next = Number(newPartnerId) || null;
  const prev = Number(prevPartnerId) || null;
  if (next === prev) return;

  // The previous partner pointed to this register → free it
  if (prev && prev !== next) {
    const prevAlta = await readAlta(db, prev);
    if (Number(prevAlta.pareja_ip_id) === id) await setLink(db, prev, null);
  }
  if (next) {
    const [[self]] = await db.query('SELECT id, pasaporte, nombre_completo FROM sort_ip_candidates WHERE id = ?', [id]);
    const nextAlta = await readAlta(db, next);
    // The new partner was linked to someone else → free that one too
    const other = Number(nextAlta.pareja_ip_id) || null;
    if (other && other !== id) {
      const otherAlta = await readAlta(db, other);
      if (Number(otherAlta.pareja_ip_id) === next) await setLink(db, other, null);
    }
    await setLink(db, next, self);
  }
};