// controllers/invoiceHistory.controller.js
// History of the invoices generated in Progestor → Admin → Bills
// (BabyMedic, Nexa Travel, Travel Medical Care).
//
// One register per company + invoice number: generating the same invoice
// again updates its register (no duplicates). The full form is kept in
// `datos` so an invoice can be loaded again into the form and regenerated.

import pool from '../db.js';
import { logDelete } from '../services/activityLogger.js';

export const INVOICE_EMPRESAS = {
  babymedic: 'BabyMedic',
  nexatravel: 'Nexa Travel',
  travelmedicalcare: 'Travel Medical Care',
};
const MONEDAS = ['USD', 'EUR'];

const requireSession = (req, res) => {
  if (!req.session?.user) { res.status(401).json({ message: 'Unauthorized' }); return false; }
  return true;
};
const serverError = (res, err, label = '') => {
  console.error(`INVOICE_HISTORY${label ? ' [' + label + ']' : ''}:`, err);
  if (err?.code === 'ER_NO_SUCH_TABLE') {
    return res.status(500).json({ message: 'La tabla del historial de facturas no existe todavía (revisa los permisos de la base de datos y reinicia el backend).' });
  }
  return res.status(500).json({ message: 'Server error' });
};

const toDecimal = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = parseFloat(String(v).replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : null;
};
const toDate = (v) => (/^\d{4}-\d{2}-\d{2}/.test(String(v || '')) ? String(v).slice(0, 10) : null);

const parseRow = (r) => {
  let datos = null;
  try { datos = r.datos ? JSON.parse(r.datos) : null; } catch (_) { datos = null; }
  return { ...r, datos };
};

// GET /api/invoice-history?empresa=babymedic&search=...
export const getInvoices = async (req, res) => {
  if (!requireSession(req, res)) return;
  const { empresa, search } = req.query;
  if (empresa && !INVOICE_EMPRESAS[empresa]) return res.status(400).json({ message: 'Empresa no válida' });
  try {
    let where = 'WHERE 1=1';
    const params = [];
    if (empresa) { where += ' AND h.empresa = ?'; params.push(empresa); }
    if (search) {
      where += ' AND (h.numero_factura LIKE ? OR h.facturar_a LIKE ? OR h.pais LIKE ?)';
      const like = `%${search}%`;
      params.push(like, like, like);
    }
    const [rows] = await pool.query(
      `SELECT h.id, h.empresa, h.moneda, h.numero_factura, DATE_FORMAT(h.fecha, '%Y-%m-%d') AS fecha, h.saldo, h.facturar_a, h.pais,
              h.total, h.datos, h.veces_generada, h.created_at, h.updated_at,
              u.username AS generado_por
         FROM invoice_history h
         LEFT JOIN users u ON u.id = h.updated_by
         ${where}
        ORDER BY h.fecha DESC, h.updated_at DESC, h.id DESC`,
      params
    );
    res.json(rows.map(parseRow));
  } catch (err) { serverError(res, err, 'getInvoices'); }
};

// POST /api/invoice-history   (called every time a PDF is generated/downloaded)
// body: { empresa, moneda, numero_factura, fecha, saldo, facturar_a, pais, total, datos }
export const saveInvoice = async (req, res) => {
  if (!requireSession(req, res)) return;
  const userId = req.session.user.id;
  const b = req.body || {};
  const empresa = String(b.empresa || '');
  const moneda = String(b.moneda || '').toUpperCase();
  const numero = String(b.numero_factura || '').trim();
  const facturarA = String(b.facturar_a || '').trim();

  if (!INVOICE_EMPRESAS[empresa]) return res.status(400).json({ message: 'Empresa no válida' });
  if (!MONEDAS.includes(moneda)) return res.status(400).json({ message: 'Moneda no válida' });
  if (!numero) return res.status(400).json({ message: 'Falta el número de factura' });
  if (!facturarA) return res.status(400).json({ message: 'Falta "Facturar a"' });

  const datos = b.datos && typeof b.datos === 'object' ? JSON.stringify(b.datos) : null;
  try {
    await pool.query(
      `INSERT INTO invoice_history
         (empresa, moneda, numero_factura, fecha, saldo, facturar_a, pais, total, datos, veces_generada, created_by, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
       ON DUPLICATE KEY UPDATE
         moneda = VALUES(moneda), fecha = VALUES(fecha), saldo = VALUES(saldo),
         facturar_a = VALUES(facturar_a), pais = VALUES(pais), total = VALUES(total),
         datos = VALUES(datos), veces_generada = veces_generada + 1, updated_by = VALUES(updated_by)`,
      [empresa, moneda, numero.slice(0, 60), toDate(b.fecha), toDecimal(b.saldo), facturarA.slice(0, 255),
        String(b.pais || '').trim().slice(0, 120) || null, toDecimal(b.total), datos, userId, userId]
    );
    const [rows] = await pool.query(
      "SELECT *, DATE_FORMAT(fecha, '%Y-%m-%d') AS fecha FROM invoice_history WHERE empresa = ? AND numero_factura = ?", [empresa, numero.slice(0, 60)]
    );
    res.json(parseRow(rows[0]));
  } catch (err) { serverError(res, err, 'saveInvoice'); }
};

// DELETE /api/invoice-history/:id
export const deleteInvoice = async (req, res) => {
  if (!requireSession(req, res)) return;
  const { id } = req.params;
  try {
    const [rows] = await pool.query('SELECT empresa, numero_factura FROM invoice_history WHERE id = ?', [id]);
    if (!rows.length) return res.status(404).json({ message: 'Registro no encontrado' });
    await pool.query('DELETE FROM invoice_history WHERE id = ?', [id]);
    try {
      await logDelete(
        req.session.user.id, 'progestor',
        `Eliminó del historial: Factura ${INVOICE_EMPRESAS[rows[0].empresa]} - ${rows[0].numero_factura}`,
        new Date(), { invoiceHistoryId: Number(id) },
      );
    } catch (_) { /* logging never blocks */ }
    res.json({ ok: true });
  } catch (err) { serverError(res, err, 'deleteInvoice'); }
};