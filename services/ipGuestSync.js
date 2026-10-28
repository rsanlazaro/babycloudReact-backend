// backend/services/ipGuestSync.js
// Two-way sync between a Sort_IPS register and the Guests account (profile IP)
// linked to it (sort_ip_candidates.guest_id):
//
//   Sort_IPS (Alta IP)          Guests
//   nombre_completo      ↔      username
//   email                ↔      mail
//   telefono             ↔      phone
//
// Rules
//  - Only the fields that were actually changed are copied to the other side.
//  - Guests username and mail must stay unique and can't be emptied (mail is
//    the IP's login). A Sort_IPS change that would break that is refused
//    BEFORE anything is saved (409 GUEST_DATA_IN_USE), so both sides never
//    disagree. An empty Sort_IPS email is simply not copied.

import pool from '../db.js';

const clean = (v) => String(v ?? '').trim();

/** Sort_IPS alta fields → the Guests columns they map to. */
export const IP_TO_GUEST = { nombre_completo: 'username', email: 'mail', telefono: 'phone' };

/**
 * Guests columns to update from Sort_IPS alta data, limited to `changedKeys`.
 * Empty username/mail are left out (required on Guests).
 */
export const guestUpdatesFromAlta = (alta, changedKeys) => {
  const out = {};
  for (const [ipField, guestCol] of Object.entries(IP_TO_GUEST)) {
    if (!changedKeys.includes(ipField)) continue;
    const value = clean(alta[ipField]);
    if (!value && guestCol !== 'phone') continue;
    out[guestCol] = value || null;
  }
  return out;
};

/** 409 payload if another Guests account already uses that username or mail; otherwise null. */
export const guestUniqueError = async (guestId, updates) => {
  for (const col of ['username', 'mail']) {
    if (!updates[col]) continue;
    const [rows] = await pool.query(`SELECT id, username FROM guests WHERE ${col} = ? AND id <> ?`, [updates[col], guestId]);
    if (rows.length) {
      return {
        code: 'GUEST_DATA_IN_USE',
        message: col === 'mail'
          ? `No se guardó: el correo ${updates[col]} ya lo usa otra cuenta de Guests (${rows[0].username}).`
          : `No se guardó: el nombre "${updates[col]}" ya lo usa otra cuenta de Guests.`,
      };
    }
  }
  return null;
};

/** Writes the Guests side (no-op without a linked account or without updates). */
export const applyGuestUpdates = async (guestId, updates) => {
  const cols = Object.keys(updates);
  if (!guestId || !cols.length) return false;
  await pool.query(
    `UPDATE guests SET ${cols.map(c => `${c} = ?`).join(', ')} WHERE id = ?`,
    [...cols.map(c => updates[c]), guestId]
  );
  return true;
};

/**
 * Guests → Sort_IPS: copies the changed Guests fields (username/mail/phone)
 * into the linked register's Alta IP (and its name column). Returns the
 * register id that was updated, or null when the account isn't linked.
 */
export const pushGuestToIp = async (guestId, guestChanges, userId) => {
  const altaChanges = {};
  if (guestChanges.username !== undefined && clean(guestChanges.username)) altaChanges.nombre_completo = clean(guestChanges.username);
  if (guestChanges.mail !== undefined) altaChanges.email = clean(guestChanges.mail);
  if (guestChanges.phone !== undefined) altaChanges.telefono = clean(guestChanges.phone);
  if (!Object.keys(altaChanges).length) return null;

  const [ips] = await pool.query('SELECT id FROM sort_ip_candidates WHERE guest_id = ?', [guestId]);
  if (!ips.length) return null;
  const ipId = ips[0].id;

  const [rows] = await pool.query(
    "SELECT data FROM sort_ip_sections WHERE candidate_id = ? AND section = 'alta'", [ipId]
  );
  let alta = {};
  try { alta = rows[0]?.data ? JSON.parse(rows[0].data) || {} : {}; } catch { alta = {}; }
  const data = { ...alta, ...altaChanges };

  await pool.query(
    `INSERT INTO sort_ip_sections (candidate_id, section, data, updated_by)
     VALUES (?, 'alta', ?, ?)
     ON DUPLICATE KEY UPDATE data = VALUES(data), updated_by = VALUES(updated_by)`,
    [ipId, JSON.stringify(data), userId || null]
  );
  if (altaChanges.nombre_completo) {
    await pool.query('UPDATE sort_ip_candidates SET nombre_completo = ? WHERE id = ?', [altaChanges.nombre_completo, ipId]);
  }
  await pool.query('UPDATE sort_ip_candidates SET updated_at = CURRENT_TIMESTAMP WHERE id = ?', [ipId]);
  return ipId;
};