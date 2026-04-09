import pool from '../db.js';

// Table map — mirrors PHP's $table = "ipregister_" . $stage
const TABLES = {
  1: 'ipregister_1',
  2: 'ipregister_2',
  3: 'ipregister_3',
  4: 'ipregister_4',
  5: 'ipregister_5',
  6: 'ipregister_6',
};

const isValidId    = (id)    => Number.isInteger(Number(id)) && Number(id) > 0;
const isValidStage = (stage) => TABLES[stage] !== undefined;

// Ensure stage_data and phase_counts columns exist (runs once per table)
const ensureColumns = async (tableName) => {
  try {
    await pool.query(`ALTER TABLE \`${tableName}\` ADD COLUMN IF NOT EXISTS \`stage_data\` JSON`);
  } catch { /* already exists */ }
};

const ensureCountsColumn = async () => {
  try {
    await pool.query(`ALTER TABLE \`ipregister_1\` ADD COLUMN IF NOT EXISTS \`phase_counts\` JSON`);
  } catch { /* already exists */ }
};

// ─── GET /api/babycloud/ips-register/:guestId ────────────────────────────────
// Returns { fields: { [stageId]: {...} }, counts: { count_1, count_2, count_3 } }

export const getRegister = async (req, res) => {
  if (!req.session?.user) return res.status(401).json({ message: 'Unauthorized' });

  const { guestId } = req.params;
  if (!isValidId(guestId)) return res.status(400).json({ message: 'ID inválido' });

  try {
    await ensureCountsColumn();
    const fields = {};

    for (const [stageKey, tableName] of Object.entries(TABLES)) {
      await ensureColumns(tableName);
      const [rows] = await pool.query(
        `SELECT stage_data FROM \`${tableName}\` WHERE id = ? LIMIT 1`,
        [guestId]
      );
      if (rows.length > 0 && rows[0].stage_data) {
        fields[stageKey] = typeof rows[0].stage_data === 'string'
          ? JSON.parse(rows[0].stage_data)
          : rows[0].stage_data;
      } else {
        fields[stageKey] = null;
      }
    }

    // Phase counts live in ipregister_1
    const [countRows] = await pool.query(
      `SELECT phase_counts FROM ipregister_1 WHERE id = ? LIMIT 1`,
      [guestId]
    );
    const counts = countRows.length > 0 && countRows[0].phase_counts
      ? (typeof countRows[0].phase_counts === 'string'
          ? JSON.parse(countRows[0].phase_counts)
          : countRows[0].phase_counts)
      : { count_1: 1, count_2: 1, count_3: 1 };

    res.json({ fields, counts });
  } catch (err) {
    console.error('GET REGISTER ERROR:', err.message, err.code);
    res.status(500).json({ message: err.message });
  }
};

// ─── POST /api/babycloud/ips-register/:guestId ──────────────────────────────
// Autosave: { stageId, componentId, phaseIndex, field, value }

export const updateRegister = async (req, res) => {
  if (!req.session?.user) return res.status(401).json({ message: 'Unauthorized' });

  const { guestId } = req.params;
  const { stageId, componentId, phaseIndex, field, value } = req.body;

  if (!isValidId(guestId))    return res.status(400).json({ message: 'ID inválido' });
  if (!isValidStage(stageId)) return res.status(400).json({ message: 'Stage inválido' });
  if (!field || typeof field !== 'string') return res.status(400).json({ message: 'Field inválido' });

  const tableName = TABLES[stageId];

  try {
    await ensureColumns(tableName);

    const [rows] = await pool.query(
      `SELECT stage_data FROM \`${tableName}\` WHERE id = ? LIMIT 1`,
      [guestId]
    );

    let stageData = {};
    if (rows.length > 0 && rows[0].stage_data) {
      stageData = typeof rows[0].stage_data === 'string'
        ? JSON.parse(rows[0].stage_data)
        : rows[0].stage_data;
    }

    // Deep merge: stageData[componentId][phaseIndex][field] = value
    if (!stageData[componentId]) stageData[componentId] = {};
    if (!stageData[componentId][phaseIndex]) stageData[componentId][phaseIndex] = {};
    stageData[componentId][phaseIndex][field] = value;

    if (rows.length === 0) {
      await pool.query(
        `INSERT INTO \`${tableName}\` (id, stage_data) VALUES (?, ?)`,
        [guestId, JSON.stringify(stageData)]
      );
    } else {
      await pool.query(
        `UPDATE \`${tableName}\` SET stage_data = ? WHERE id = ?`,
        [JSON.stringify(stageData), guestId]
      );
    }

    res.json({ success: true });
  } catch (err) {
    console.error('UPDATE REGISTER ERROR:', err.message, err.code);
    res.status(500).json({ message: err.message });
  }
};

// ─── POST /api/babycloud/ips-register/:guestId/phase ─────────────────────────
// Add or remove a phase: { action: 'add'|'remove', phaseKey: 'count_1'|'count_2'|'count_3' }
// Mirrors PHP: UPDATE ipregister_1 SET stage_count_N = N WHERE id = ?

export const updatePhase = async (req, res) => {
  if (!req.session?.user) return res.status(401).json({ message: 'Unauthorized' });

  const { guestId } = req.params;
  const { action, phaseKey } = req.body;

  if (!isValidId(guestId)) return res.status(400).json({ message: 'ID inválido' });
  if (!['add', 'remove'].includes(action)) return res.status(400).json({ message: 'Acción inválida' });
  if (!['count_1', 'count_2', 'count_3'].includes(phaseKey)) return res.status(400).json({ message: 'Phase key inválida' });

  try {
    await ensureCountsColumn();

    const [rows] = await pool.query(
      `SELECT phase_counts FROM ipregister_1 WHERE id = ? LIMIT 1`,
      [guestId]
    );

    let counts = { count_1: 1, count_2: 1, count_3: 1 };
    if (rows.length > 0 && rows[0].phase_counts) {
      counts = typeof rows[0].phase_counts === 'string'
        ? JSON.parse(rows[0].phase_counts)
        : rows[0].phase_counts;
    }

    const current = counts[phaseKey] ?? 1;
    counts[phaseKey] = action === 'add'
      ? Math.min(current + 1, 6)
      : Math.max(current - 1, 1);

    if (rows.length === 0) {
      await pool.query(
        `INSERT INTO ipregister_1 (id, phase_counts) VALUES (?, ?)
         ON DUPLICATE KEY UPDATE phase_counts = VALUES(phase_counts)`,
        [guestId, JSON.stringify(counts)]
      );
    } else {
      await pool.query(
        `UPDATE ipregister_1 SET phase_counts = ? WHERE id = ?`,
        [JSON.stringify(counts), guestId]
      );
    }

    res.json({ success: true, counts });
  } catch (err) {
    console.error('UPDATE PHASE ERROR:', err.message, err.code);
    res.status(500).json({ message: err.message });
  }
};

// ─── POST /api/babycloud/ips-register/:guestId/init ─────────────────────────

export const initRegister = async (req, res) => {
  if (!req.session?.user) return res.status(401).json({ message: 'Unauthorized' });

  const { guestId } = req.params;
  if (!isValidId(guestId)) return res.status(400).json({ message: 'ID inválido' });

  try {
    await ensureCountsColumn();
    for (const tableName of Object.values(TABLES)) {
      await ensureColumns(tableName);
      await pool.query(
        `INSERT IGNORE INTO \`${tableName}\` (id, stage_data) VALUES (?, ?)`,
        [guestId, JSON.stringify({})]
      );
    }
    // Init phase counts in ipregister_1
    await pool.query(
      `UPDATE ipregister_1 SET phase_counts = ? WHERE id = ?`,
      [JSON.stringify({ count_1: 1, count_2: 1, count_3: 1 }), guestId]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('INIT REGISTER ERROR:', err.message, err.code);
    res.status(500).json({ message: err.message });
  }
};