// controllers/paymentsGest.controller.js
// CRUD for payments_gest — gestante payment schemes

import pool from '../db.js';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** JSON fields that come in as objects/arrays and must be serialised for MySQL */
const JSON_FIELDS = [
  'transferencias',
  'row_states',
  'puerperio_states',
  'bono_states',
  'bg_conditions',
  'parc_completed',
  'extrato_gastos',
  'ayuda_state',
];

/**
 * Scalar fields that map directly to columns.
 * scheme_value is handled separately (numeric coercion).
 */
const SCALAR_FIELDS = [
  'gesca', 'ip', 'banco', 'clabe', 'country',
  'insurance', 'policy', 'manager', 'fum', 'giro_semana',
  'scheme_value', 'status',
  'bono_vih', 'bono_gemelar',
  'parc_count',
  'ayuda_maternidad', 'ayuda_amount',
];

/**
 * Build the column-value map for INSERT / UPDATE from a request body.
 * JSON fields are stringified; scalar fields are passed through.
 */
function buildColumnMap(body) {
  const cols = {};

  SCALAR_FIELDS.forEach(f => {
    if (f in body) cols[f] = body[f];
  });

  JSON_FIELDS.forEach(f => {
    if (f in body) {
      cols[f] = typeof body[f] === 'string'
        ? body[f]
        : JSON.stringify(body[f]);
    }
  });

  return cols;
}

/**
 * Parse JSON columns back to objects after a SELECT.
 */
function parseRow(row) {
  if (!row) return null;
  const parsed = { ...row };
  JSON_FIELDS.forEach(f => {
    if (parsed[f] !== null && parsed[f] !== undefined) {
      try {
        parsed[f] = typeof parsed[f] === 'string'
          ? JSON.parse(parsed[f])
          : parsed[f]; // mysql2 may already parse JSON columns
      } catch {
        // leave as-is if parse fails
      }
    }
  });
  // Convert tinyint booleans
  ['bono_vih', 'bono_gemelar', 'ayuda_maternidad'].forEach(f => {
    if (f in parsed) parsed[f] = Boolean(parsed[f]);
  });
  return parsed;
}

// ─────────────────────────────────────────────────────────────────────────────
// GET  /api/payments-gest
// Returns paginated list (id, gesca, ip, scheme_value, status, created_at)
// Query params: page, limit, status, gesca, ip
// ─────────────────────────────────────────────────────────────────────────────
export const getAll = async (req, res) => {
  try {
    const page   = Math.max(1, parseInt(req.query.page)  || 1);
    const limit  = Math.min(100, parseInt(req.query.limit) || 20);
    const offset = (page - 1) * limit;

    const where  = [];
    const params = [];

    if (req.query.status) {
      where.push('status = ?');
      params.push(req.query.status);
    }
    if (req.query.gesca) {
      where.push('gesca LIKE ?');
      params.push(`%${req.query.gesca}%`);
    }
    if (req.query.ip) {
      where.push('ip LIKE ?');
      params.push(`%${req.query.ip}%`);
    }

    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const [rows] = await pool.execute(
      `SELECT id, gesca, ip, country, scheme_value, status, manager,
              ayuda_maternidad, ayuda_amount, created_at, updated_at
       FROM payments_gest
       ${whereClause}
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    const [[{ total }]] = await pool.execute(
      `SELECT COUNT(*) AS total FROM payments_gest ${whereClause}`,
      params
    );

    res.json({
      data:       rows,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    console.error('[paymentsGest] getAll error:', err);
    console.error('Error stack:', err.stack);
    res.status(500).json({ 
      message: 'Error al obtener los esquemas de pago',
      error: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET  /api/payments-gest/:id
// Returns full record with all JSON fields parsed
// ─────────────────────────────────────────────────────────────────────────────
export const getById = async (req, res) => {
  try {
    const { id } = req.params;

    const [rows] = await pool.execute(
      'SELECT * FROM payments_gest WHERE id = ?',
      [id]
    );

    if (!rows.length) {
      return res.status(404).json({ message: 'Esquema no encontrado' });
    }

    res.json(parseRow(rows[0]));
  } catch (err) {
    console.error('[paymentsGest] getById error:', err);
    console.error('Error stack:', err.stack);
    res.status(500).json({ 
      message: 'Error al obtener el esquema de pago',
      error: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/payments-gest
// Creates a new payment scheme
// ─────────────────────────────────────────────────────────────────────────────
export const create = async (req, res) => {
  try {
    const body = req.body;

    // Validate required fields
    if (!body.gesca || !body.ip) {
      return res.status(400).json({ message: 'gesca e ip son obligatorios' });
    }

    const cols = buildColumnMap(body);

    if (!Object.keys(cols).length) {
      return res.status(400).json({ message: 'No se proporcionaron datos' });
    }

    const columns      = Object.keys(cols).join(', ');
    const placeholders = Object.keys(cols).map(() => '?').join(', ');
    const values       = Object.values(cols);

    const [result] = await pool.execute(
      `INSERT INTO payments_gest (${columns}) VALUES (${placeholders})`,
      values
    );

    // Return the newly created row
    const [newRows] = await pool.execute(
      'SELECT * FROM payments_gest WHERE id = ?',
      [result.insertId]
    );

    res.status(201).json(parseRow(newRows[0]));
  } catch (err) {
    console.error('[paymentsGest] create error:', err);
    console.error('Error stack:', err.stack);
    res.status(500).json({ 
      message: 'Error al crear el esquema de pago',
      error: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// PUT  /api/payments-gest/:id
// Full update of an existing record
// ─────────────────────────────────────────────────────────────────────────────
export const update = async (req, res) => {
  try {
    const { id } = req.params;
    const body = req.body;

    // Confirm record exists
    const [existing] = await pool.execute(
      'SELECT id FROM payments_gest WHERE id = ?',
      [id]
    );
    if (!existing.length) {
      return res.status(404).json({ message: 'Esquema no encontrado' });
    }

    const cols = buildColumnMap(body);

    if (!Object.keys(cols).length) {
      return res.status(400).json({ message: 'No se proporcionaron datos para actualizar' });
    }

    const setClause = Object.keys(cols).map(c => `${c} = ?`).join(', ');
    const values    = [...Object.values(cols), id];

    await pool.execute(
      `UPDATE payments_gest SET ${setClause} WHERE id = ?`,
      values
    );

    const [updated] = await pool.execute(
      'SELECT * FROM payments_gest WHERE id = ?',
      [id]
    );

    res.json(parseRow(updated[0]));
  } catch (err) {
    console.error('[paymentsGest] update error:', err);
    console.error('Error stack:', err.stack);
    res.status(500).json({ 
      message: 'Error al actualizar el esquema de pago',
      error: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/payments-gest/:id
// Hard delete — consider soft delete (status = 'cancelled') for production
// ─────────────────────────────────────────────────────────────────────────────
export const remove = async (req, res) => {
  try {
    const { id } = req.params;

    const [existing] = await pool.execute(
      'SELECT id FROM payments_gest WHERE id = ?',
      [id]
    );
    if (!existing.length) {
      return res.status(404).json({ message: 'Esquema no encontrado' });
    }

    await pool.execute('DELETE FROM payments_gest WHERE id = ?', [id]);

    res.json({ message: 'Esquema eliminado correctamente', id: parseInt(id) });
  } catch (err) {
    console.error('[paymentsGest] remove error:', err);
    console.error('Error stack:', err.stack);
    res.status(500).json({ 
      message: 'Error al eliminar el esquema de pago',
      error: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/payments-gest/:id/status
// Quick status update without touching the full payload
// ─────────────────────────────────────────────────────────────────────────────
export const updateStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    const valid = ['active', 'completed', 'cancelled', 'pending'];
    if (!valid.includes(status)) {
      return res.status(400).json({ message: `status debe ser uno de: ${valid.join(', ')}` });
    }

    const [existing] = await pool.execute(
      'SELECT id FROM payments_gest WHERE id = ?',
      [id]
    );
    if (!existing.length) {
      return res.status(404).json({ message: 'Esquema no encontrado' });
    }

    await pool.execute(
      'UPDATE payments_gest SET status = ? WHERE id = ?',
      [status, id]
    );

    res.json({ id: parseInt(id), status });
  } catch (err) {
    console.error('[paymentsGest] updateStatus error:', err);
    console.error('Error stack:', err.stack);
    res.status(500).json({ 
      message: 'Error al actualizar el status',
      error: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
};