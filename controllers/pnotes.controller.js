// controllers/pnotes.controller.js
import pool from '../db.js';
import { logCreate, logUpdate, logDelete } from '../services/activityLogger.js';

const requireSession = (req, res) => {
  if (!req.session?.user) { res.status(401).json({ message: 'Unauthorized' }); return false; }
  return true;
};
const serverError = (res, err, label = '') => {
  console.error(`PNOTES${label ? ' [' + label + ']' : ''}:`, err);
  return res.status(500).json({ message: 'Server error' });
};
const nextRefCode = async () => {
  const [rows] = await pool.query('SELECT COUNT(*) AS cnt FROM pnotes');
  return `P-Note ${String((rows[0].cnt || 0) + 1).padStart(4, '0')}`;
};

// GET /api/pnotes
export const getNotes = async (req, res) => {
  if (!requireSession(req, res)) return;
  const userId = req.session.user.id;
  const { status, caracter, context_type, context_id, search } = req.query;
  try {
    let where = 'WHERE (n.author_id = ? OR n.notify_user_id = ?)';
    const params = [userId, userId];
    if (status)       { where += ' AND n.status = ?';       params.push(status); }
    if (caracter)     { where += ' AND n.caracter = ?';     params.push(caracter); }
    if (context_type) { where += ' AND n.context_type = ?'; params.push(context_type); }
    if (context_id)   { where += ' AND n.context_id = ?';   params.push(context_id); }
    if (search) {
      where += ' AND (n.asunto LIKE ? OR n.contenido LIKE ? OR n.gesca LIKE ? OR n.ref_code LIKE ?)';
      const like = `%${search}%`;
      params.push(like, like, like, like);
    }
    const [rows] = await pool.query(
      `SELECT n.*, r.read_at
       FROM pnotes n
       LEFT JOIN pnotes_readers r ON r.pnote_id = n.id AND r.user_id = ?
       ${where}
       ORDER BY n.created_at DESC`,
      [userId, ...params]
    );
    res.json(rows);
  } catch (err) { serverError(res, err, 'getNotes'); }
};

// GET /api/pnotes/unread-count
export const getUnreadCount = async (req, res) => {
  if (!requireSession(req, res)) return;
  const userId = req.session.user.id;
  try {
    const [rows] = await pool.query(
      `SELECT COUNT(*) AS cnt FROM pnotes n
       LEFT JOIN pnotes_readers r ON r.pnote_id = n.id AND r.user_id = ?
       WHERE n.notify_user_id = ? AND n.status = 'pendiente' AND r.id IS NULL`,
      [userId, userId]
    );
    res.json({ unread: rows[0].cnt || 0 });
  } catch (err) { serverError(res, err, 'getUnreadCount'); }
};

// GET /api/pnotes/:id
export const getNote = async (req, res) => {
  if (!requireSession(req, res)) return;
  const { id } = req.params;
  const userId = req.session.user.id;
  try {
    const [rows] = await pool.query('SELECT * FROM pnotes WHERE id = ?', [id]);
    if (!rows.length) return res.status(404).json({ message: 'Not found' });
    await pool.query('INSERT IGNORE INTO pnotes_readers (pnote_id, user_id) VALUES (?, ?)', [id, userId]);
    res.json(rows[0]);
  } catch (err) { serverError(res, err, 'getNote'); }
};

// POST /api/pnotes
export const createNote = async (req, res) => {
  if (!requireSession(req, res)) return;
  const today = new Date();
  const userId   = req.session.user.id;
  const username = req.session.user.username;
  const {
    notify_user_id, notify_user_name, notify_team,
    asunto, tema, gesca, ip_asignada, caracter,
    contenido, fecha_creacion, fecha_limite,
    context_type, context_id, archivo_url,
  } = req.body;
  try {
    const ref_code = await nextRefCode();
    const [result] = await pool.query(
      `INSERT INTO pnotes
         (ref_code, author_id, author_name,
          notify_user_id, notify_user_name, notify_team,
          asunto, tema, gesca, ip_asignada, caracter,
          contenido, fecha_creacion, fecha_limite,
          context_type, context_id, archivo_url, status)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pendiente')`,
      [
        ref_code, userId, username,
        notify_user_id || null, notify_user_name || null, notify_team || null,
        asunto || null, tema || null, gesca || null,
        ip_asignada || null, caracter || null, contenido || null,
        fecha_creacion || today.toISOString().split('T')[0], fecha_limite || null,
        context_type || null, context_id || null, archivo_url || null,
      ]
    );
    await logCreate(userId, 'progestor', `Creó P-Note ${ref_code}`, today, ref_code);
    const [rows] = await pool.query('SELECT * FROM pnotes WHERE id = ?', [result.insertId]);
    res.status(201).json(rows[0]);
  } catch (err) { serverError(res, err, 'createNote'); }
};

// PUT /api/pnotes/:id
export const updateNote = async (req, res) => {
  if (!requireSession(req, res)) return;
  const { id } = req.params;
  const today = new Date();
  const userId = req.session.user.id;
  const {
    notify_user_id, notify_user_name, notify_team,
    asunto, tema, gesca, ip_asignada, caracter,
    contenido, fecha_creacion, fecha_limite, archivo_url, status,
  } = req.body;
  try {
    await pool.query(
      `UPDATE pnotes SET
         notify_user_id=?, notify_user_name=?, notify_team=?,
         asunto=?, tema=?, gesca=?, ip_asignada=?, caracter=?,
         contenido=?, fecha_creacion=?, fecha_limite=?,
         archivo_url=?, status=?
       WHERE id=? AND author_id=?`,
      [
        notify_user_id || null, notify_user_name || null, notify_team || null,
        asunto || null, tema || null, gesca || null,
        ip_asignada || null, caracter || null, contenido || null,
        fecha_creacion || null, fecha_limite || null,
        archivo_url || null, status || 'pendiente',
        id, userId,
      ]
    );
    await logUpdate(userId, 'progestor', `Actualizó P-Note #${id}`, today, `${id}`);
    const [rows] = await pool.query('SELECT * FROM pnotes WHERE id = ?', [id]);
    res.json(rows[0]);
  } catch (err) { serverError(res, err, 'updateNote'); }
};

// PATCH /api/pnotes/:id/status
export const updateNoteStatus = async (req, res) => {
  if (!requireSession(req, res)) return;
  const { id } = req.params;
  const { status } = req.body;
  const userId = req.session.user.id;
  const today = new Date();
  try {
    await pool.query(
      'UPDATE pnotes SET status=? WHERE id=? AND (author_id=? OR notify_user_id=?)',
      [status, id, userId, userId]
    );
    await logUpdate(userId, 'progestor', `Status P-Note #${id} → ${status}`, today, `${id}`);
    res.json({ success: true });
  } catch (err) { serverError(res, err, 'updateNoteStatus'); }
};

// DELETE /api/pnotes/:id
export const deleteNote = async (req, res) => {
  if (!requireSession(req, res)) return;
  const { id } = req.params;
  const userId = req.session.user.id;
  const today = new Date();
  try {
    await pool.query('DELETE FROM pnotes WHERE id=? AND author_id=?', [id, userId]);
    await logDelete(userId, 'progestor', `Eliminó P-Note #${id}`, today, `${id}`);
    res.json({ success: true });
  } catch (err) { serverError(res, err, 'deleteNote'); }
};

// POST /api/pnotes/:id/read
export const markRead = async (req, res) => {
  if (!requireSession(req, res)) return;
  const { id } = req.params;
  const userId = req.session.user.id;
  try {
    await pool.query('INSERT IGNORE INTO pnotes_readers (pnote_id, user_id) VALUES (?,?)', [id, userId]);
    res.json({ success: true });
  } catch (err) { serverError(res, err, 'markRead'); }
};