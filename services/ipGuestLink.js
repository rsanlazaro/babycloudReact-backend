// backend/services/ipGuestLink.js
// Link between a Sort_IPS register and its Guests account (profile IP),
// made through the PASSPORT NUMBER:
//
//   sort_ip_candidates.pasaporte  ==  guests.pasaporte   →  sort_ip_candidates.guest_id
//
//  - Creating an IP whose passport already belongs to a Guests account links
//    that account (no new one is created).
//  - Creating an IP with no Guests account for that passport can create the
//    account from the IP data (name, email, phone, passport + password).
//  - Creating / editing a Guests account (profile IP) with the passport of an
//    IP that has no account links them.
//  - Once linked, the passport is changed from Sort_IPS (it is copied to Guests,
//    see services/ipGuestSync.js).

import pool from '../db.js';
import { logCreate, logUpdate } from './activityLogger.js';

const clean = (v) => String(v ?? '').trim();
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Same rule as Sort_IPS (sortIp.controller.js)
export const normalizeGuestPasaporte = (v) => String(v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
export const GUEST_PASAPORTE_REGEX = /^[A-Z0-9]{5,20}$/;

// Same password rule as Guests (frontend Guests.js → validatePassword)
export const accountPasswordError = (password) => {
  const p = String(password ?? '');
  if (!p.trim()) return 'La contraseña es obligatoria';
  if (p.length < 6) return 'La contraseña debe tener al menos 6 caracteres';
  if (!/(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/.test(p)) return 'La contraseña debe contener una mayúscula, una minúscula y un número';
  return '';
};

const parseData = (v) => {
  if (!v) return {};
  if (typeof v === 'object') return v;
  try { return JSON.parse(v) || {}; } catch { return {}; }
};

/** Guests account that has this passport (with the IP it is linked to, if any) */
export const findGuestByPasaporte = async (pasaporte, db = pool) => {
  const p = normalizeGuestPasaporte(pasaporte);
  if (!p) return null;
  const [rows] = await db.query(
    `SELECT g.id, g.username, g.mail, g.phone, g.profile, g.enabled, c.id AS sort_ip_id
       FROM guests g
       LEFT JOIN sort_ip_candidates c ON c.guest_id = g.id
      WHERE g.pasaporte = ?
      LIMIT 1`,
    [p]
  );
  return rows[0] || null;
};

/** Sort_IPS register with this passport (and its current account) */
export const findIpByPasaporte = async (pasaporte, db = pool) => {
  const p = normalizeGuestPasaporte(pasaporte);
  if (!p) return null;
  const [rows] = await db.query(
    'SELECT id, nombre_completo, guest_id FROM sort_ip_candidates WHERE pasaporte = ? LIMIT 1', [p]
  );
  return rows[0] || null;
};

/**
 * Why this guest can't be linked to an IP with `pasaporte` (or '' if it can):
 * a different passport already on the account.
 */
export const passportMismatchError = (guest, pasaporte) => {
  const gp = normalizeGuestPasaporte(guest?.pasaporte);
  const ip = normalizeGuestPasaporte(pasaporte);
  if (gp && ip && gp !== ip) {
    return `La cuenta ${guest.username} tiene otro pasaporte (${gp}). La vinculación se hace por número de pasaporte.`;
  }
  return '';
};

/**
 * Validates the data to create a Guests account for an IP.
 * @returns '' or the error message
 */
export const newAccountError = async ({ nombre, email, pasaporte, password }, db = pool) => {
  if (!clean(nombre)) return 'El nombre del IP es obligatorio para crear su cuenta';
  if (!clean(email)) return 'Captura y guarda el correo electrónico del IP: es su usuario para entrar a Baby Cloud';
  if (!EMAIL_REGEX.test(clean(email))) return 'El correo electrónico del IP no es válido';
  const pwdErr = accountPasswordError(password);
  if (pwdErr) return pwdErr;
  const [byMail] = await db.query('SELECT username FROM guests WHERE LOWER(mail) = LOWER(?)', [clean(email)]);
  if (byMail.length) return `El correo ${clean(email)} ya lo usa la cuenta de Guests ${byMail[0].username}`;
  const [byName] = await db.query('SELECT id FROM guests WHERE username = ?', [clean(nombre)]);
  if (byName.length) return `Ya existe una cuenta de Guests con el nombre "${clean(nombre)}"`;
  const p = normalizeGuestPasaporte(pasaporte);
  if (p) {
    const g = await findGuestByPasaporte(p, db);
    if (g) return `Ya existe una cuenta de Guests con el pasaporte ${p} (${g.username})`;
  }
  return '';
};

/** Inserts the Guests account (profile IP). Returns its id. Validate first with newAccountError. */
export const insertIpAccount = async ({ nombre, email, telefono, pasaporte, password }, db = pool) => {
  const [result] = await db.query(
    `INSERT INTO guests (username, mail, password, profile, phone, pasaporte, enabled, created_on)
     VALUES (?, ?, ?, 'ip', ?, ?, 1, NOW())`,
    [clean(nombre), clean(email), String(password), clean(telefono) || null, normalizeGuestPasaporte(pasaporte) || null]
  );
  return result.insertId;
};

/**
 * Links a Guests account to an IP: sets guest_id, gives the account the IP's
 * passport and fills the IP's empty email / phone with the account's.
 */
export const linkAccount = async (ipId, guestId, userId, db = pool) => {
  const [[ip]] = await db.query('SELECT pasaporte FROM sort_ip_candidates WHERE id = ?', [ipId]);
  await db.query('UPDATE sort_ip_candidates SET guest_id = ? WHERE id = ?', [guestId, ipId]);
  if (ip?.pasaporte) await db.query('UPDATE guests SET pasaporte = ? WHERE id = ?', [ip.pasaporte, guestId]);

  const [[g]] = await db.query('SELECT mail, phone FROM guests WHERE id = ?', [guestId]);
  const [rows] = await db.query("SELECT data FROM sort_ip_sections WHERE candidate_id = ? AND section = 'alta'", [ipId]);
  const alta = parseData(rows[0]?.data);
  const fill = {};
  if (!clean(alta.email) && clean(g?.mail)) fill.email = clean(g.mail);
  if (!clean(alta.telefono) && clean(g?.phone)) fill.telefono = clean(g.phone);
  if (Object.keys(fill).length) {
    await db.query(
      `INSERT INTO sort_ip_sections (candidate_id, section, data, updated_by)
       VALUES (?, 'alta', ?, ?)
       ON DUPLICATE KEY UPDATE data = VALUES(data), updated_by = VALUES(updated_by)`,
      [ipId, JSON.stringify({ ...alta, ...fill }), userId || null]
    );
  }
};

/**
 * Guests side: after creating / editing an IP account with a passport, link it
 * to the Sort_IPS register with that passport if it has no account yet.
 * @returns { ipId, nombre_completo } when linked, otherwise null
 */
export const autoLinkGuestByPasaporte = async (guestId, userId) => {
  const [[g]] = await pool.query('SELECT id, username, profile, pasaporte FROM guests WHERE id = ?', [guestId]);
  if (!g || g.profile !== 'ip' || !g.pasaporte) return null;
  const [already] = await pool.query('SELECT id FROM sort_ip_candidates WHERE guest_id = ?', [guestId]);
  if (already.length) return null;
  const ip = await findIpByPasaporte(g.pasaporte);
  if (!ip || ip.guest_id) return null;
  await linkAccount(ip.id, guestId, userId);
  await logUpdate(userId, 'babysite', `Vinculó por pasaporte la cuenta ${g.username} con Sort_IPS #${ip.id} (${ip.nombre_completo})`, new Date(), `${ip.id}`);
  return { ipId: ip.id, nombre_completo: ip.nombre_completo };
};

/** Activity log line for an account created from Sort_IPS */
export const logAccountCreated = (userId, ipId, nombre) =>
  logCreate(userId, 'progestor', `Creó la cuenta de Guests (IP) de ${nombre} desde Sort_IPS #${ipId}`, new Date(), `${ipId}`);