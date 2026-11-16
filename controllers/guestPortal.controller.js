// backend/controllers/guestPortal.controller.js — mounted at /api/guest-portal
// Self-service for guests with the IP profile (their "Inicio" page in Baby Cloud):
//   GET /me  → their account + their registration data (Sort_IPS → Alta IP) and
//              their deposit trip ("Datos del viaje de depósito")
//   PUT /me  → they fill in / update that data.
//
// Where each field is saved
//   Guests (account)          Sort_IPS → Alta IP
//   username            ↔     nombre_completo      (Nombre completo)
//   mail (login)        ↔     email
//   phone               ↔     telefono             (Teléfono 1)
//   pasaporte           ↔     pasaporte            (the key that links both)
//                             telefono_2, nacionalidad, pais, idioma,
//                             fecha_nacimiento, pareja_nombre, direccion, barrio, cp
//                             viajes[primer viaje]  ← deposit trip
//                             pareja_link, unity_adhesion, unity_categoria, consentimiento_imagen
//   Sort_IPS → Crio embrio:   programa_tipo, captura_tipo, seleccion_donante,
//                             categoria_donante, preferencia_embarazo, lavado_semen
//                             ("Proyecto parental") + egg_donors with ip_opcion 1-3
//                             (the IP's donor options: Código · Agencia · Catálogo)
//   Sort_IPS → Check list (Primer viaje): the 6 "Documentos iniciales" — PDF
//   (section docs, uploaded with /doc-signature + /doc) and date (<key>_fecha).
//
// The IP can NOT change their password here (it is managed by staff in
// Guests / Sort_IPS). Changing the email (their login) needs the current password.
//
// Without a Sort_IPS register yet, saving with a passport registers them:
// the register with that passport (if it has no account) is linked, otherwise
// a new register is created and linked (services/ipGuestLink.js).
//
// Only the logged-in guest's own data is ever read or written (id from the
// session, never from the request).

import pool from '../db.js';
import cloudinary from '../config/cloudinary.js';
import { ipDocFolder, ipDocPublicId, readDocs, writeDoc } from '../services/ipDocs.js';
import { pipeStoredPdf } from '../services/seguroComprobantes.js';
import { guestCloudView } from '../services/ipCloudView.js';
import {
  normalizeGuestPasaporte, GUEST_PASAPORTE_REGEX, findGuestByPasaporte, findIpByPasaporte,
} from '../services/ipGuestLink.js';
import { logUpdate, logCreate } from '../services/activityLogger.js';
import { findPareja, mirrorParejaLink } from '../services/ipPareja.js';

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_REGEX = /^[0-9+\-\s()]{6,20}$/;
const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const TIME_REGEX = /^\d{2}:\d{2}$/;
const clean = (v) => String(v ?? '').trim();
const cut = (v, n) => clean(v).slice(0, n);

// Alta IP fields the IP fills in (plain text) and their max length
const ALTA_FIELDS = {
  telefono_2: 30, nacionalidad: 80, pais: 80, idioma: 40, fecha_nacimiento: 10,
  pareja_nombre: 200, direccion: 200, barrio: 120, cp: 12,
};

// Value = allowed options (array) or max length (number)
const SI_NO = ['Sí', 'No'];
// Same lists as frontend config/sortIpSections.js
const CRIO_AGENCIAS = ['Fenotipo', 'FF', 'OD'];
const CRIO_CATALOGOS = ['Regular', 'VIP', 'Premium', 'Royal', 'Diamante', 'Elite'];
const MAX_EGG_DONORS = 10;

// Pareja / Ayudas & membresías / Consentimiento → Alta IP
const ALTA_EXTRA_FIELDS = {
  pareja_link: 200,
  unity_adhesion: SI_NO,
  unity_categoria: ['1', '2', '3', '4'],
  consentimiento_imagen: SI_NO,
};
// "Proyecto parental" → Crio embrio (categoria_donante is checked apart)
const CRIO_PROYECTO_FIELDS = {
  programa_tipo: ['Single', 'Double'],
  captura_tipo: ['Full', 'Split'],
  seleccion_donante: ['Fenotipo', 'Catálogo'],
  categoria_donante: null,
  preferencia_embarazo: ['Único', 'Gemelar'],
  lavado_semen: SI_NO,
};
// Answers saved in Alta IP by the first version of this form → read as fallback
const LEGACY_ALTA_KEYS = [
  'programa_tipo', 'desea_split', 'donante_tipo',
  'donante_op1_categoria', 'donante_op1_codigo', 'donante_op2_categoria', 'donante_op2_codigo',
  'donante_op3_categoria', 'donante_op3_codigo',
];
const legacyProyecto = (alta) => ({
  programa_tipo: alta.programa_tipo === 'Simple' ? 'Single' : (alta.programa_tipo || ''),
  captura_tipo: alta.desea_split === 'Sí' ? 'Split' : alta.desea_split === 'No' ? 'Full' : '',
  seleccion_donante: alta.donante_tipo || '',
});
const NO_PAREJA_MESSAGE = 'No existe un IP registrado con ese número de pasaporte / Il n\'existe aucun IP enregistré avec ce numéro de passeport';
const rid = (p) => `${p}${Date.now()}${Math.floor(Math.random() * 1000)}`;

/** The IP's 3 donor options, from the crio egg donors they created (ip_opcion) */
const donorOptions = (crio, alta) => [1, 2, 3].map(n => {
  const d = (crio.egg_donors || []).find(x => Number(x?.ip_opcion) === n);
  if (d) return { codigo: d.codigo || '', agencia: d.agencia || '', catalogo: d.catalogo || '' };
  return { codigo: alta[`donante_op${n}_codigo`] || '', agencia: '', catalogo: alta[`donante_op${n}_categoria`] || '' };
});

// "Documentos iniciales" = Check list → Primer viaje items (same keys as
// frontend config CHECKLIST_COLUMNS). PDF key: checklist_<key>; date: <key>_fecha
const PORTAL_DOCS = ['pasaportes', 'serologias', 'espermograma', 'fragmentacion_adn', 'tipo_sangre', 'analisis_sangre'];
const portalDocKey = (key) => `checklist_${key}`;
const parseDocParam = (v) => {
  const key = String(v || '').replace(/^checklist_/, '');
  return PORTAL_DOCS.includes(key) ? key : null;
};

// Deposit trip fields the IP fills in (same keys as Sort_IPS → Registro de viajes)
const TRIP_TEXT = {
  llegada_fecha: 10, llegada_hora: 5, llegada_vuelo: 30,
  salida_fecha: 10, salida_hora: 5, salida_vuelo: 30,
  hospedaje_calle_no: 200, hospedaje_numero: 20, hospedaje_cp: 12, hospedaje_colonia: 120,
  hospedaje_complemento: 200, hospedaje_hotel: 150, hospedaje_room: 20,
};
const HOSPEDAJE_TIPOS = ['hotel', 'airbnb', 'otro'];

// Same shape as frontend config/sortIpSections.js → newViaje(true)
const newDepositTrip = () => ({
  id: `v${Date.now()}${Math.floor(Math.random() * 1000)}`,
  primer_viaje: true, segundo_viaje: false, con_material_genetico: false,
  llegada_fecha: '', llegada_hora: '', llegada_vuelo: '',
  salida_fecha: '', salida_hora: '', salida_vuelo: '',
  vuelo_confirmado: false, vuelo_confirmado_en: '',
  itinerario_enviado: false, itinerario_enviado_en: '',
  hospedaje_tipo: '',
  hospedaje_calle_no: '', hospedaje_numero: '', hospedaje_cp: '', hospedaje_colonia: '',
  hospedaje_complemento: '', hospedaje_hotel: '', hospedaje_room: '',
});

const parseData = (v) => {
  if (!v) return {};
  if (typeof v === 'object') return v;
  try { return JSON.parse(v) || {}; } catch { return {}; }
};

/** The deposit trip = the one marked "Primer viaje" (index or -1) */
const depositTripIndex = (alta) => (Array.isArray(alta.viajes) ? alta.viajes.findIndex(v => v?.primer_viaje) : -1);

/** The logged-in guest's current row, only if it is an enabled IP profile. */
const currentIpGuest = async (req, res) => {
  const sessionGuest = req.session?.guest;
  if (!sessionGuest) { res.status(401).json({ message: 'Unauthorized' }); return null; }
  const [rows] = await pool.query(
    'SELECT id, username, mail, password, phone, pasaporte, profile, enabled FROM guests WHERE id = ?',
    [sessionGuest.id]
  );
  const g = rows[0];
  if (!g || Number(g.enabled) === 0) { res.status(401).json({ message: 'Unauthorized' }); return null; }
  if (g.profile !== 'ip') { res.status(403).json({ message: 'Disponible solo para cuentas con perfil IP / Disponible uniquement pour les comptes avec profil IP' }); return null; }
  return g;
};

/** Sort_IPS register of the guest + its Alta IP data */
const linkedIp = async (guestId) => {
  const [rows] = await pool.query(
    `SELECT c.id, c.nombre_completo, c.pasaporte, c.foto_url, s.data
       FROM sort_ip_candidates c
       LEFT JOIN sort_ip_sections s ON s.candidate_id = c.id AND s.section = 'alta'
      WHERE c.guest_id = ?`,
    [guestId]
  );
  return rows[0] ? { ...rows[0], alta: parseData(rows[0].data) } : null;
};

const fullShape = async (g) => {
  const ip = await linkedIp(g.id);
  const alta = ip?.alta || {};
  const idx = depositTripIndex(alta);
  const trip = idx >= 0 ? alta.viajes[idx] : null;
  const datos = {
    nombre_completo: g.username || '',
    pasaporte: ip?.pasaporte || g.pasaporte || '',
    telefono: g.phone || '',
  };
  Object.keys(ALTA_FIELDS).forEach(k => { datos[k] = alta[k] ?? ''; });
  const viaje = { sin_viaje_deposito: !!trip?.con_material_genetico, hospedaje_tipo: trip?.hospedaje_tipo || '' };
  Object.keys(TRIP_TEXT).forEach(k => { viaje[k] = trip?.[k] ?? ''; });
  let crio = {};
  if (ip) {
    const [cr] = await pool.query("SELECT data FROM sort_ip_sections WHERE candidate_id = ? AND section = 'crio'", [ip.id]);
    crio = parseData(cr[0]?.data);
  }
  const legacy = legacyProyecto(alta);
  const proyecto = {};
  Object.keys(ALTA_EXTRA_FIELDS).forEach(k => { proyecto[k] = alta[k] ?? ''; });
  Object.keys(CRIO_PROYECTO_FIELDS).forEach(k => { proyecto[k] = crio[k] || legacy[k] || ''; });
  const donantes = donorOptions(crio, alta);
  // Linked partner ("Linkar pareja")
  let pareja = null;
  if (Number(alta.pareja_ip_id)) {
    const [pr] = await pool.query('SELECT id, nombre_completo, pasaporte FROM sort_ip_candidates WHERE id = ?', [Number(alta.pareja_ip_id)]);
    if (pr[0]) pareja = { nombre_completo: pr[0].nombre_completo, pasaporte: pr[0].pasaporte };
  }
  proyecto.pareja_link = pareja ? pareja.pasaporte : '';
  let documentos = {};
  if (ip) {
    const [chk] = await pool.query("SELECT data FROM sort_ip_sections WHERE candidate_id = ? AND section = 'checklist'", [ip.id]);
    const checklist = parseData(chk[0]?.data);
    const docs = await readDocs(ip.id);
    documentos = Object.fromEntries(PORTAL_DOCS.map(k => [k, {
      fecha: checklist[`${k}_fecha`] ? String(checklist[`${k}_fecha`]).slice(0, 10) : '',
      subido: !!docs[portalDocKey(k)]?.url,
      subido_en: docs[portalDocKey(k)]?.uploaded_at || null,
    }]));
  }
  return {
    id: g.id,
    username: g.username,
    mail: g.mail,
    phone: g.phone || '',
    profile: g.profile,
    sort_ip: ip ? { id: ip.id, nombre_completo: ip.nombre_completo, foto_url: ip.foto_url || null } : null,
    cloud_view_enabled: (await guestCloudView(g.id)).enabled,
    datos,
    viaje,
    proyecto,
    pareja,       // { nombre_completo, pasaporte } of the linked partner, or null
    donantes,
    documentos,   // {} until they have a Sort_IPS register (documents need it)
  };
};

export const getMe = async (req, res) => {
  try {
    const g = await currentIpGuest(req, res);
    if (!g) return;
    res.json(await fullShape(g));
  } catch (err) {
    console.error('GUEST PORTAL GET ERROR:', err);
    res.status(500).json({ message: 'Error del servidor / Erreur du serveur' });
  }
};

/** Validates the request; returns { error } or the cleaned data. */
const readBody = (body) => {
  const d = body?.datos || {};
  const v = body?.viaje || {};

  const nombre = cut(d.nombre_completo, 200);
  const mail = clean(body?.mail).toLowerCase();
  const telefono = clean(d.telefono);
  const pasaporte = normalizeGuestPasaporte(d.pasaporte);

  if (!nombre) return { error: 'El nombre completo es obligatorio / Le nom complet est obligatoire' };
  if (!EMAIL_REGEX.test(mail)) return { error: 'Correo electrónico inválido / Adresse e-mail invalide' };
  if (!pasaporte) return { error: 'El pasaporte es obligatorio / Le passeport est obligatoire' };
  if (!GUEST_PASAPORTE_REGEX.test(pasaporte)) return { error: 'El pasaporte debe tener entre 5 y 20 letras o números / Le passeport doit contenir entre 5 et 20 lettres ou chiffres' };
  if (telefono && !PHONE_REGEX.test(telefono)) return { error: 'Teléfono 1 inválido / Téléphone 1 invalide' };

  const alta = {};
  for (const [k, max] of Object.entries(ALTA_FIELDS)) alta[k] = cut(d[k], max);
  if (alta.telefono_2 && !PHONE_REGEX.test(alta.telefono_2)) return { error: 'Teléfono 2 inválido / Téléphone 2 invalide' };
  if (alta.fecha_nacimiento && !DATE_REGEX.test(alta.fecha_nacimiento)) return { error: 'Fecha de nacimiento inválida / Date de naissance invalide' };

  const trip = { con_material_genetico: !!v.sin_viaje_deposito };
  for (const [k, max] of Object.entries(TRIP_TEXT)) trip[k] = cut(v[k], max);
  trip.hospedaje_tipo = HOSPEDAJE_TIPOS.includes(v.hospedaje_tipo) ? v.hospedaje_tipo : '';
  for (const k of ['llegada_fecha', 'salida_fecha']) {
    if (trip[k] && !DATE_REGEX.test(trip[k])) return { error: 'Fecha del vuelo inválida / Date du vol invalide' };
  }
  for (const k of ['llegada_hora', 'salida_hora']) {
    if (trip[k] && !TIME_REGEX.test(trip[k])) return { error: 'Hora del vuelo inválida / Heure du vol invalide' };
  }
  if (trip.llegada_fecha && trip.salida_fecha && trip.salida_fecha < trip.llegada_fecha) {
    return { error: 'La fecha de salida no puede ser anterior a la de llegada / La date de départ ne peut pas être antérieure à la date d\'arrivée' };
  }
  // "Sin viaje de depósito": no flight nor lodging data
  if (trip.con_material_genetico) {
    Object.keys(TRIP_TEXT).forEach(k => { trip[k] = ''; });
    trip.hospedaje_tipo = '';
  }

  const p = body?.proyecto || {};
  const pick = (fields) => {
    const out = {};
    for (const [k, rule] of Object.entries(fields)) {
      const val = clean(p[k]);
      if (Array.isArray(rule) && val && !rule.includes(val)) return null;
      out[k] = typeof rule === 'number' ? val.slice(0, rule) : val;
    }
    return out;
  };
  const altaExtra = pick(ALTA_EXTRA_FIELDS);
  const crioProyecto = pick(CRIO_PROYECTO_FIELDS);
  if (!altaExtra || !crioProyecto) return { error: 'Revisa las opciones elegidas del proyecto parental / Vérifiez les options choisies du projet parental' };
  if (altaExtra.unity_adhesion !== 'Sí') altaExtra.unity_categoria = '';
  altaExtra.pareja_link = normalizeGuestPasaporte(altaExtra.pareja_link);   // partner's passport ('' = no link)
  // Donor options (Código · Agencia · Catálogo)
  const donantes = [];
  const dIn = Array.isArray(body?.donantes) ? body.donantes : [];
  for (let i = 0; i < 3; i += 1) {
    const d = dIn[i] || {};
    const opt = { codigo: cut(d.codigo, 40).toUpperCase(), agencia: clean(d.agencia), catalogo: clean(d.catalogo) };
    if (opt.agencia && !CRIO_AGENCIAS.includes(opt.agencia)) return { error: 'Agencia de donante no válida / Agence de donneuse invalide' };
    if (opt.agencia === 'Fenotipo') opt.catalogo = '';   // Fenotipo agency → no catálogo
    if (opt.catalogo && !CRIO_CATALOGOS.includes(opt.catalogo)) return { error: 'Catálogo de donante no válido / Catalogue de donneuse invalide' };
    donantes.push(opt);
  }

  // Categoría donante (Sort_IPS → Crio embrio → Proyecto parental) comes from
  // the options: Fenotipo → "Fenotipo" (options without catálogo);
  // Catálogo → the catálogo of the first option that has one
  if (crioProyecto.seleccion_donante === 'Fenotipo') {
    crioProyecto.categoria_donante = 'Fenotipo';
    // Fenotipo → every option's Agencia is Fenotipo, with no catálogo
    donantes.forEach(d => { d.catalogo = ''; d.agencia = d.codigo ? 'Fenotipo' : ''; });
  } else if (crioProyecto.seleccion_donante === 'Catálogo') {
    crioProyecto.categoria_donante = donantes.find(d => d.catalogo)?.catalogo || '';
  } else {
    crioProyecto.categoria_donante = '';
  }

  // Dates of the initial documents (expiry for the passport, test date for the rest)
  const fechas = {};
  const docIn = body?.documentos || {};
  for (const k of PORTAL_DOCS) {
    const val = clean(docIn[k]?.fecha);
    if (val && !DATE_REGEX.test(val)) return { error: 'Revisa las fechas de los documentos / Vérifiez les dates des documents' };
    if (docIn[k] !== undefined) fechas[`${k}_fecha`] = val;
  }
  const tripHasData = trip.con_material_genetico || trip.hospedaje_tipo || Object.keys(TRIP_TEXT).some(k => trip[k]);

  return {
    nombre, mail, telefono, pasaporte, alta, trip, tripHasData, altaExtra, crioProyecto, donantes, fechas,
    currentPassword: String(body?.current_password ?? ''),
  };
};

export const updateMe = async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const g = await currentIpGuest(req, res);
    if (!g) return;
    if (req.body?.new_password) {
      return res.status(403).json({ message: 'La contraseña no se puede cambiar desde aquí. Pide el cambio a tu coordinador. / Le mot de passe ne peut pas être modifié ici. Demandez-le à votre coordinateur.' });
    }
    const b = readBody(req.body);
    if (b.error) return res.status(400).json({ message: b.error });

    // ── Account (Guests) ──
    const changes = {};
    if (b.nombre !== g.username) changes.username = b.nombre;
    if (b.mail !== String(g.mail || '').toLowerCase()) changes.mail = b.mail;
    if (b.telefono !== (g.phone || '')) changes.phone = b.telefono || null;
    if (b.pasaporte !== (g.pasaporte || '')) changes.pasaporte = b.pasaporte;

    // Their login (email) needs the current password
    if (changes.mail && b.currentPassword !== g.password) {
      return res.status(403).json({ code: 'PASSWORD_REQUIRED', message: 'Para cambiar tu correo escribe tu contraseña actual correcta / Pour changer votre e-mail, saisissez votre mot de passe actuel' });
    }
    if (changes.username) {
      const [dup] = await pool.query('SELECT id FROM guests WHERE username = ? AND id <> ?', [changes.username, g.id]);
      if (dup.length) return res.status(409).json({ message: 'Ese nombre ya lo usa otra cuenta / Ce nom est déjà utilisé par un autre compte' });
    }
    if (changes.mail) {
      const [dup] = await pool.query('SELECT id FROM guests WHERE LOWER(mail) = ? AND id <> ?', [changes.mail, g.id]);
      if (dup.length) return res.status(409).json({ message: 'Ese correo ya lo usa otra cuenta / Cet e-mail est déjà utilisé par un autre compte' });
    }

    // ── Passport: the link with Sort_IPS ──
    const ip = await linkedIp(g.id);
    const otherGuest = await findGuestByPasaporte(b.pasaporte);
    if (otherGuest && Number(otherGuest.id) !== Number(g.id)) {
      return res.status(409).json({ message: 'Ese pasaporte ya está registrado en otra cuenta. Contacta a tu coordinador. / Ce passeport est déjà enregistré sur un autre compte. Contactez votre coordinateur.' });
    }
    const ipWithPassport = await findIpByPasaporte(b.pasaporte);
    let ipId = ip?.id || null;
    let linkExisting = false;

    // "Linkar pareja": the partner must be another registered IP (by passport)
    let pareja = null;
    if (b.altaExtra.pareja_link) {
      if (b.altaExtra.pareja_link === b.pasaporte) {
        return res.status(400).json({ message: 'Ese es tu propio pasaporte / C\'est votre propre passeport' });
      }
      pareja = await findPareja(b.altaExtra.pareja_link, ip?.id || ipWithPassport?.id || null);
      if (!pareja) return res.status(400).json({ message: NO_PAREJA_MESSAGE });
    }
    if (ip) {
      if (ipWithPassport && Number(ipWithPassport.id) !== Number(ip.id)) {
        return res.status(409).json({ message: 'Ese pasaporte ya está registrado. Contacta a tu coordinador. / Ce passeport est déjà enregistré. Contactez votre coordinateur.' });
      }
    } else if (ipWithPassport) {
      if (ipWithPassport.guest_id && Number(ipWithPassport.guest_id) !== Number(g.id)) {
        return res.status(409).json({ message: 'Ese pasaporte ya está registrado con otra cuenta. Contacta a tu coordinador. / Ce passeport est déjà enregistré avec un autre compte. Contactez votre coordinateur.' });
      }
      ipId = ipWithPassport.id;     // their register already exists → link it
      linkExisting = true;
    }

    await conn.beginTransaction();

    if (Object.keys(changes).length) {
      const cols = Object.keys(changes);
      await conn.query(
        `UPDATE guests SET ${cols.map(c => `${c} = ?`).join(', ')} WHERE id = ?`,
        [...cols.map(c => changes[c]), g.id]
      );
    }

    // ── Sort_IPS register ──
    let created = false;
    if (!ipId) {
      const [ins] = await conn.query(
        'INSERT INTO sort_ip_candidates (nombre_completo, pasaporte, guest_id, created_by) VALUES (?, ?, ?, NULL)',
        [b.nombre, b.pasaporte, g.id]
      );
      ipId = ins.insertId;
      created = true;
    } else if (linkExisting) {
      await conn.query('UPDATE sort_ip_candidates SET guest_id = ? WHERE id = ?', [g.id, ipId]);
    }
    await conn.query(
      'UPDATE sort_ip_candidates SET nombre_completo = ?, pasaporte = ? WHERE id = ?',
      [b.nombre, b.pasaporte, ipId]
    );

    const [secRows] = await conn.query(
      "SELECT data FROM sort_ip_sections WHERE candidate_id = ? AND section = 'alta' FOR UPDATE", [ipId]
    );
    const alta = parseData(secRows[0]?.data);
    const prevPareja = Number(alta.pareja_ip_id) || null;
    Object.assign(alta, b.alta, b.altaExtra, {
      pareja_ip_id: pareja ? pareja.id : '', pareja_link: pareja ? pareja.pasaporte : '',
      pareja_ip_nombre: pareja ? pareja.nombre_completo : '',
      nombre_completo: b.nombre, pasaporte: b.pasaporte, email: b.mail, telefono: b.telefono,
    });
    LEGACY_ALTA_KEYS.forEach(k => { delete alta[k]; });   // now in Crio embrio
    // Deposit trip: only the fields the IP fills in (staff fields are kept)
    const viajes = Array.isArray(alta.viajes) ? [...alta.viajes] : [];
    const idx = depositTripIndex(alta);
    if (idx >= 0) viajes[idx] = { ...viajes[idx], ...b.trip };
    else if (b.tripHasData) viajes.unshift({ ...newDepositTrip(), ...b.trip });
    alta.viajes = viajes;

    await conn.query(
      `INSERT INTO sort_ip_sections (candidate_id, section, data, updated_by)
       VALUES (?, 'alta', ?, NULL)
       ON DUPLICATE KEY UPDATE data = VALUES(data), updated_by = NULL`,
      [ipId, JSON.stringify(alta)]
    );
    // Crio embrio: "Proyecto parental" + the IP's donor options as egg donors
    const [crioRows] = await conn.query(
      "SELECT data FROM sort_ip_sections WHERE candidate_id = ? AND section = 'crio' FOR UPDATE", [ipId]
    );
    const crio = { ...parseData(crioRows[0]?.data), ...b.crioProyecto };
    let eggDonors = Array.isArray(crio.egg_donors) ? [...crio.egg_donors] : [];
    b.donantes.forEach((opt, i) => {
      const n = i + 1;
      const at = eggDonors.findIndex(d => Number(d?.ip_opcion) === n);
      const empty = !opt.codigo && !opt.agencia && !opt.catalogo;
      if (empty) { if (at >= 0) eggDonors = eggDonors.filter((_, j) => j !== at); return; }
      if (at >= 0) eggDonors[at] = { ...eggDonors[at], ...opt };
      else if (eggDonors.length < MAX_EGG_DONORS) eggDonors.push({ id: rid('d'), ...opt, ip_opcion: n });
    });
    crio.egg_donors = eggDonors;
    await conn.query(
      `INSERT INTO sort_ip_sections (candidate_id, section, data, updated_by)
       VALUES (?, 'crio', ?, NULL)
       ON DUPLICATE KEY UPDATE data = VALUES(data), updated_by = NULL`,
      [ipId, JSON.stringify(crio)]
    );

    // Check list dates of the initial documents
    if (Object.keys(b.fechas).length) {
      const [chkRows] = await conn.query(
        "SELECT data FROM sort_ip_sections WHERE candidate_id = ? AND section = 'checklist' FOR UPDATE", [ipId]
      );
      const checklist = { ...parseData(chkRows[0]?.data), ...b.fechas };
      await conn.query(
        `INSERT INTO sort_ip_sections (candidate_id, section, data, updated_by)
         VALUES (?, 'checklist', ?, NULL)
         ON DUPLICATE KEY UPDATE data = VALUES(data), updated_by = NULL`,
        [ipId, JSON.stringify(checklist)]
      );
    }
    await conn.query('UPDATE sort_ip_candidates SET updated_at = CURRENT_TIMESTAMP WHERE id = ?', [ipId]);
    await conn.commit();

    // The partner's register points back to this one (and an old partner is freed)
    await mirrorParejaLink(ipId, pareja ? pareja.id : null, prevPareja);

    const who = `${b.nombre} (cuenta Baby Cloud #${g.id})`;
    if (created) await logCreate(null, 'babysite', `${who} se registró desde Baby Cloud: Sort_IPS #${ipId}`, new Date(), `${ipId}`);
    else await logUpdate(null, 'babysite', `${who} actualizó sus datos desde Baby Cloud (Sort_IPS #${ipId})`, new Date(), `${ipId}`);

    // Keep the session in step (name shown in the app, login email)
    req.session.guest = { ...req.session.guest, username: b.nombre, email: b.mail };

    const [rows] = await pool.query(
      'SELECT id, username, mail, password, phone, pasaporte, profile, enabled FROM guests WHERE id = ?', [g.id]
    );
    res.json(await fullShape(rows[0]));
  } catch (err) {
    await conn.rollback().catch(() => {});
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ message: 'Ese pasaporte o correo ya está registrado. Contacta a tu coordinador. / Ce passeport ou cet e-mail est déjà enregistré. Contactez votre coordinateur.' });
    }
    console.error('GUEST PORTAL UPDATE ERROR:', err);
    res.status(500).json({ message: 'Error del servidor / Erreur du serveur' });
  } finally {
    conn.release();
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// "Documentos iniciales": the IP uploads their own PDFs (only the 6 Primer
// viaje items, only to their own register). Same storage as staff uploads
// (Sort_IPS → Check list), so staff see them right away.
// ─────────────────────────────────────────────────────────────────────────────
const ownIpId = async (req, res) => {
  const g = await currentIpGuest(req, res);
  if (!g) return null;
  const ip = await linkedIp(g.id);
  if (!ip) { res.status(409).json({ message: 'Guarda primero tus datos (con tu pasaporte) para poder subir documentos / Enregistrez d\'abord vos données (avec votre passeport) pour pouvoir envoyer des documents' }); return null; }
  return { g, ipId: ip.id };
};

// GET /api/guest-portal/doc-signature?docKey=pasaportes
export const getDocSignature = async (req, res) => {
  try {
    const key = parseDocParam(req.query.docKey);
    if (!key) return res.status(400).json({ message: 'Documento no válido / Document invalide' });
    const own = await ownIpId(req, res);
    if (!own) return;
    const docKey = portalDocKey(key);
    const timestamp = Math.round(Date.now() / 1000);
    const folder = ipDocFolder(own.ipId);
    const publicId = ipDocPublicId(own.ipId, docKey);
    const signature = cloudinary.utils.api_sign_request(
      { timestamp, public_id: publicId, asset_folder: folder, overwrite: true },
      process.env.CLOUDINARY_API_SECRET
    );
    res.json({
      timestamp, signature, publicId, assetFolder: folder,
      cloudName: process.env.CLOUDINARY_CLOUD_NAME, apiKey: process.env.CLOUDINARY_API_KEY,
    });
  } catch (err) {
    console.error('GUEST PORTAL DOC SIGNATURE ERROR:', err);
    res.status(500).json({ message: 'Error del servidor / Erreur du serveur' });
  }
};

// PUT /api/guest-portal/doc  { docKey, url } — registers the uploaded PDF
export const saveDoc = async (req, res) => {
  try {
    const key = parseDocParam(req.body?.docKey);
    const url = String(req.body?.url || '');
    if (!key) return res.status(400).json({ message: 'Documento no válido / Document invalide' });
    const own = await ownIpId(req, res);
    if (!own) return;
    // Only a file uploaded with the signature above (their own public id)
    const expected = `/${ipDocPublicId(own.ipId, portalDocKey(key))}`;
    if (!url.startsWith(`https://res.cloudinary.com/${process.env.CLOUDINARY_CLOUD_NAME}/`) || !url.includes(expected)) {
      return res.status(400).json({ message: 'URL de documento inválida / URL du document invalide' });
    }
    await writeDoc(own.ipId, portalDocKey(key), { url, uploaded_at: new Date().toISOString(), by_ip: true }, null);
    await logUpdate(null, 'babysite', `${own.g.username} subió desde Baby Cloud el documento "${key}" (Sort_IPS #${own.ipId})`, new Date(), `${own.ipId}`);
    const [rows] = await pool.query(
      'SELECT id, username, mail, password, phone, pasaporte, profile, enabled FROM guests WHERE id = ?', [own.g.id]
    );
    res.json(await fullShape(rows[0]));
  } catch (err) {
    console.error('GUEST PORTAL SAVE DOC ERROR:', err);
    res.status(500).json({ message: 'Error al guardar el documento / Erreur lors de l\'enregistrement du document' });
  }
};

// GET /api/guest-portal/doc-stream?docKey=pasaportes — their own PDF
export const streamDoc = async (req, res) => {
  try {
    const key = parseDocParam(req.query.docKey);
    if (!key) return res.status(400).json({ message: 'Documento no válido / Document invalide' });
    const own = await ownIpId(req, res);
    if (!own) return;
    const doc = (await readDocs(own.ipId))[portalDocKey(key)];
    if (!doc?.url) return res.status(404).json({ message: 'Este documento no se ha subido / Ce document n\'a pas été envoyé' });
    await pipeStoredPdf(res, doc.url, ipDocPublicId(own.ipId, portalDocKey(key)));
  } catch (err) {
    console.error('GUEST PORTAL STREAM DOC ERROR:', err);
    if (!res.headersSent) res.status(500).json({ message: 'Error al abrir el documento / Erreur lors de l\'ouverture du document' });
  }
};

// GET /api/guest-portal/pareja?pasaporte=XX — "Linkar pareja": is there another
// IP registered with this passport? → { found, nombre_completo, pasaporte }
export const findParejaByPasaporte = async (req, res) => {
  try {
    const g = await currentIpGuest(req, res);
    if (!g) return;
    const p = normalizeGuestPasaporte(req.query.pasaporte);
    if (!GUEST_PASAPORTE_REGEX.test(p)) {
      return res.status(400).json({ message: 'El pasaporte debe tener entre 5 y 20 letras o números / Le passeport doit contenir entre 5 et 20 lettres ou chiffres' });
    }
    const ip = await linkedIp(g.id);
    if (p === normalizeGuestPasaporte(ip?.pasaporte || g.pasaporte)) {
      return res.status(400).json({ message: 'Ese es tu propio pasaporte / C\'est votre propre passeport' });
    }
    const pareja = await findPareja(p, ip?.id || null);
    if (!pareja) return res.json({ found: false, message: NO_PAREJA_MESSAGE });
    res.json({ found: true, nombre_completo: pareja.nombre_completo, pasaporte: pareja.pasaporte });
  } catch (err) {
    console.error('GUEST PORTAL PAREJA ERROR:', err);
    res.status(500).json({ message: 'Error del servidor / Erreur du serveur' });
  }
};