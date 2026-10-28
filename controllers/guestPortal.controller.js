// backend/controllers/guestPortal.controller.js — mounted at /api/guest-portal
// Self-service for guests with the IP profile (their "Inicio" page in Baby Cloud):
//   GET /me  → their Guests data + the Sort_IPS register linked to them
//   PUT /me  → they update their own data. Same fields as Guests → IP
//              (usuario, correo, teléfono, contraseña). Name/email/phone are
//              also copied to their Sort_IPS register (services/ipGuestSync.js).
//
// Only the logged-in guest's own row is ever read or written (id from the
// session, never from the request). Changing the email (their login) or the
// password requires the current password.

import pool from '../db.js';
import { pushGuestToIp } from '../services/ipGuestSync.js';
import { guestPasswordError } from './sortIp.controller.js';

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const clean = (v) => String(v ?? '').trim();

/** The logged-in guest's current row, only if it is an enabled IP profile. */
const currentIpGuest = async (req, res) => {
  const sessionGuest = req.session?.guest;
  if (!sessionGuest) { res.status(401).json({ message: 'Unauthorized' }); return null; }
  const [rows] = await pool.query(
    'SELECT id, username, mail, password, phone, profile, enabled FROM guests WHERE id = ?',
    [sessionGuest.id]
  );
  const g = rows[0];
  if (!g || Number(g.enabled) === 0) { res.status(401).json({ message: 'Unauthorized' }); return null; }
  if (g.profile !== 'ip') { res.status(403).json({ message: 'Disponible solo para cuentas con perfil IP' }); return null; }
  return g;
};

const linkedIp = async (guestId) => {
  const [rows] = await pool.query(
    'SELECT id, nombre_completo, pasaporte, foto_url FROM sort_ip_candidates WHERE guest_id = ?', [guestId]
  );
  return rows[0] || null;
};

const publicShape = (g, ip) => ({
  id: g.id,
  username: g.username,
  mail: g.mail,
  phone: g.phone || '',
  profile: g.profile,
  sort_ip: ip ? { id: ip.id, nombre_completo: ip.nombre_completo, foto_url: ip.foto_url || null } : null,
});

export const getMe = async (req, res) => {
  try {
    const g = await currentIpGuest(req, res);
    if (!g) return;
    res.json(publicShape(g, await linkedIp(g.id)));
  } catch (err) {
    console.error('GUEST PORTAL GET ERROR:', err);
    res.status(500).json({ message: 'Error del servidor' });
  }
};

export const updateMe = async (req, res) => {
  try {
    const g = await currentIpGuest(req, res);
    if (!g) return;

    const username = clean(req.body?.username);
    const mail = clean(req.body?.mail).toLowerCase();
    const phone = clean(req.body?.phone);
    const newPassword = String(req.body?.new_password ?? '');
    const currentPassword = String(req.body?.current_password ?? '');

    if (!username) return res.status(400).json({ message: 'El nombre es obligatorio' });
    if (!EMAIL_REGEX.test(mail)) return res.status(400).json({ message: 'Correo electrónico inválido' });
    if (phone && !/^[0-9+\-\s()]{6,20}$/.test(phone)) return res.status(400).json({ message: 'Teléfono inválido' });
    if (newPassword && guestPasswordError(newPassword)) {
      return res.status(400).json({ message: guestPasswordError(newPassword) });
    }

    // Only what actually changed
    const changes = {};
    if (username !== g.username) changes.username = username;
    if (mail !== String(g.mail || '').toLowerCase()) changes.mail = mail;
    if (phone !== (g.phone || '')) changes.phone = phone || null;
    if (newPassword) changes.password = newPassword;
    if (!Object.keys(changes).length) return res.json({ ...publicShape(g, await linkedIp(g.id)), unchanged: true });

    // The login (email) and the password need the current password
    if ((changes.mail || changes.password) && currentPassword !== g.password) {
      return res.status(403).json({ code: 'PASSWORD_REQUIRED', message: 'Para cambiar el correo o la contraseña, escribe tu contraseña actual correcta' });
    }

    // Same uniqueness rules as Guests
    if (changes.username) {
      const [dup] = await pool.query('SELECT id FROM guests WHERE username = ? AND id <> ?', [changes.username, g.id]);
      if (dup.length) return res.status(409).json({ message: 'Ese nombre ya lo usa otra cuenta' });
    }
    if (changes.mail) {
      const [dup] = await pool.query('SELECT id FROM guests WHERE LOWER(mail) = ? AND id <> ?', [changes.mail, g.id]);
      if (dup.length) return res.status(409).json({ message: 'Ese correo ya lo usa otra cuenta' });
    }

    const cols = Object.keys(changes);
    await pool.query(
      `UPDATE guests SET ${cols.map(c => `${c} = ?`).join(', ')} WHERE id = ?`,
      [...cols.map(c => changes[c]), g.id]
    );

    // Same data on the IP's Sort_IPS register (name / email / phone)
    try {
      await pushGuestToIp(g.id, { username: changes.username, mail: changes.mail, phone: 'phone' in changes ? (changes.phone || '') : undefined }, null);
    } catch (syncErr) {
      console.error('GUEST PORTAL → SORT_IPS SYNC ERROR:', syncErr);
    }

    // Keep the session in step (name shown in the app, login email)
    req.session.guest = { ...req.session.guest, username: changes.username || g.username, email: changes.mail || g.mail };

    const [rows] = await pool.query('SELECT id, username, mail, phone, profile FROM guests WHERE id = ?', [g.id]);
    res.json(publicShape(rows[0], await linkedIp(g.id)));
  } catch (err) {
    console.error('GUEST PORTAL UPDATE ERROR:', err);
    res.status(500).json({ message: 'Error del servidor' });
  }
};