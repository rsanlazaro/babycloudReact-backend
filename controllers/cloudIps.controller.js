import pool from '../db.js';

// ─── Table map ────────────────────────────────────────────────────────────────
const TABLES = {
  1: 'ipregister_1',
  2: 'ipregister_2',       // stage 2 columns 1-157
  '2_2': 'ipregister_2_2', // stage 2 columns 158-312
  3: 'ipregister_3',
  4: 'ipregister_4',
  5: 'ipregister_5',
  6: 'ipregister_6',
};

// max_S_components in PHP — how many phase slots each component has per stage
const MAX_PHASES = { 1: 3, 2: 6, 3: 3, 4: 1, 5: 1, 6: 1 };

// Field → column offset within a single phase block (0-indexed)
// Each phase block = 13 column slots: 1 counter-advance + 12 reads + 1 final advance
// Reads: info_general(+1), status(+2), date(+3), info_1(+4), info_2(+5),
//        uploading_1(+6), enable_1(+7), uploading_2(+8), enable_2(+9),
//        uploading_3(+10), enable_3(+11), enableView(+12)
const FIELD_OFFSET = {
  info_general: 0,
  status:       1,
  date:         2,
  info_1:       3,
  info_2:       4,
  uploading_1:  5,
  enable_1:     6,
  uploading_2:  7,
  enable_2:     8,
  uploading_3:  9,
  enable_3:     10,
  enableView:   11,
};

// Explicit column block index per (stage, componentId).
// Stage 2 note: PHP resets $counter_enable after component 3 (Reporte Transfer)
// so component 4 (Prueba Beta) shares the same column block as component 3.
// Component 3 is never rendered (skipped in tableStage), so components 4 and 5
// effectively occupy block indices 2 and 3.
const COMPONENT_COL_IDX = {
  1: { 1: 0, 2: 1 },
  2: { 1: 0, 2: 1, 4: 2, 5: 3 },   // comp 3 skipped; comp 4 reuses block 2
  3: { 1: 0, 2: 1, 3: 2 },
  4: { 1: 0, 2: 1, 3: 2, 4: 3 },
  5: { 1: 0, 2: 1, 3: 2, 4: 3, 5: 4, 6: 5, 7: 6, 8: 7 },
  6: { 1: 0 },
};

// ─── Column number formula ────────────────────────────────────────────────────
// Mirrors PHP $counter_enable logic exactly:
//   counter starts at 1 for each stage
//   for each phase slot: counter++ (gap/advance), then 12 reads with counter++
//   → base = 1 + colIdx * maxPhases * 13 + phaseIndex * 13
//   → column = base + 1 + fieldOffset
function colNum(stageId, componentId, phaseIndex, field) {
  const maxPhases  = MAX_PHASES[stageId];
  const colIdx     = COMPONENT_COL_IDX[stageId]?.[componentId];
  const fieldOff   = FIELD_OFFSET[field];

  if (colIdx  === undefined) throw new Error(`Unknown component ${componentId} for stage ${stageId}`);
  if (fieldOff === undefined) throw new Error(`Unknown field "${field}"`);

  return 1 + colIdx * maxPhases * 13 + phaseIndex * 13 + 1 + fieldOff;
}

// ─── Table router for stage 2 ─────────────────────────────────────────────────
// PHP: ipregister_2 holds stage_1..stage_157, ipregister_2_2 holds stage_158..stage_312
function tableForCol(stageId, col) {
  if (stageId !== 2) return TABLES[stageId];
  return col <= 157 ? 'ipregister_2' : 'ipregister_2_2';
}

const isValidId    = (id)  => Number.isInteger(Number(id)) && Number(id) > 0;
const isValidStage = (s)   => [1, 2, 3, 4, 5, 6].includes(Number(s));

// ─── GET /api/babycloud/ips-register/:guestId ────────────────────────────────
// Returns { fields: { stageId: { componentId: { phaseIndex: { field: val } } } },
//           counts: { count_1, count_2, count_3 } }

export const getRegister = async (req, res) => {
  if (!req.session?.user) return res.status(401).json({ message: 'Unauthorized' });

  const { guestId } = req.params;
  if (!isValidId(guestId)) return res.status(400).json({ message: 'ID inválido' });

  try {
    const fields = {};

    for (const [stageKey, tableName] of Object.entries(TABLES)) {
      if (stageKey === '2_2') continue; // handled together with stage 2

      const stageId = Number(stageKey);
      const [rows]  = await pool.query(
        `SELECT * FROM \`${tableName}\` WHERE id = ? LIMIT 1`, [guestId]
      );
      let row = rows[0] || {};

      // Stage 2 needs both tables merged
      if (stageId === 2) {
        const [rows2] = await pool.query(
          `SELECT * FROM ipregister_2_2 WHERE id = ? LIMIT 1`, [guestId]
        );
        row = { ...row, ...(rows2[0] || {}) };
      }

      fields[stageId] = {};
      const colIdx = COMPONENT_COL_IDX[stageId];

      for (const [compIdStr] of Object.entries(colIdx)) {
        const componentId = Number(compIdStr);
        fields[stageId][componentId] = {};

        for (let phaseIndex = 0; phaseIndex < MAX_PHASES[stageId]; phaseIndex++) {
          fields[stageId][componentId][phaseIndex] = {};

          for (const fieldName of Object.keys(FIELD_OFFSET)) {
            const col = colNum(stageId, componentId, phaseIndex, fieldName);
            const colName = `stage_${col}`;
            fields[stageId][componentId][phaseIndex][fieldName] = row[colName] ?? null;
          }
        }
      }
    }

    // Phase counts live in ipregister_1 as stage_count_1/2/3
    const [cntRows] = await pool.query(
      `SELECT stage_count_1, stage_count_2, stage_count_3 FROM ipregister_1 WHERE id = ? LIMIT 1`,
      [guestId]
    );
    const counts = cntRows[0]
      ? { count_1: cntRows[0].stage_count_1 || 1,
          count_2: cntRows[0].stage_count_2 || 1,
          count_3: cntRows[0].stage_count_3 || 1 }
      : { count_1: 1, count_2: 1, count_3: 1 };

    res.json({ fields, counts });
  } catch (err) {
    console.error('GET REGISTER ERROR:', err.message, err.code);
    res.status(500).json({ message: err.message });
  }
};

// ─── POST /api/babycloud/ips-register/:guestId ──────────────────────────────
// Autosave a single field.
// Body: { stageId, componentId, phaseIndex, field, value }

export const updateRegister = async (req, res) => {
  if (!req.session?.user) return res.status(401).json({ message: 'Unauthorized' });

  const { guestId } = req.params;
  const { stageId, componentId, phaseIndex, field, value } = req.body;

  if (!isValidId(guestId))    return res.status(400).json({ message: 'ID inválido' });
  if (!isValidStage(stageId)) return res.status(400).json({ message: 'Stage inválido' });
  if (!field)                  return res.status(400).json({ message: 'Field requerido' });

  try {
    const col     = colNum(Number(stageId), Number(componentId), Number(phaseIndex), field);
    const table   = tableForCol(Number(stageId), col);
    const colName = `stage_${col}`;
    const safeVal = String(value ?? '').substring(0, 1000);

    const [upd] = await pool.query(
      `UPDATE \`${table}\` SET \`${colName}\` = ? WHERE id = ?`,
      [safeVal, guestId]
    );

    if (upd.affectedRows === 0) {
      // Row doesn't exist — insert (mirrors PHP's INSERT INTO $table (id) VALUES (?))
      await pool.query(
        `INSERT INTO \`${table}\` (id, \`${colName}\`) VALUES (?, ?)
         ON DUPLICATE KEY UPDATE \`${colName}\` = VALUES(\`${colName}\`)`,
        [guestId, safeVal]
      );
    }

    res.json({ success: true, table, column: colName, value: safeVal });
  } catch (err) {
    console.error('UPDATE REGISTER ERROR:', err.message, err.code);
    res.status(500).json({ message: err.message });
  }
};

// ─── POST /api/babycloud/ips-register/:guestId/phase ─────────────────────────
// Add or remove a phase repetition.
// Body: { action: 'add'|'remove', phaseKey: 'count_1'|'count_2'|'count_3' }
// Mirrors PHP: UPDATE ipregister_1 SET stage_count_N = N WHERE id = ?

const PHASE_LIMITS = { count_1: 3, count_2: 6, count_3: 3 };

export const updatePhase = async (req, res) => {
  if (!req.session?.user) return res.status(401).json({ message: 'Unauthorized' });

  const { guestId } = req.params;
  const { action, phaseKey } = req.body;

  if (!isValidId(guestId))  return res.status(400).json({ message: 'ID inválido' });
  if (!['add', 'remove'].includes(action)) return res.status(400).json({ message: 'Acción inválida' });
  if (!PHASE_LIMITS[phaseKey])             return res.status(400).json({ message: 'Phase key inválida' });

  // phase key 'count_1' maps to DB column 'stage_count_1'
  const dbCol = `stage_${phaseKey}`;

  try {
    const [rows] = await pool.query(
      `SELECT \`${dbCol}\` FROM ipregister_1 WHERE id = ? LIMIT 1`, [guestId]
    );

    const current = rows[0]?.[dbCol] ?? 1;
    const next    = action === 'add'
      ? Math.min(current + 1, PHASE_LIMITS[phaseKey])
      : Math.max(current - 1, 1);

    const [upd] = await pool.query(
      `UPDATE ipregister_1 SET \`${dbCol}\` = ? WHERE id = ?`, [next, guestId]
    );

    if (upd.affectedRows === 0) {
      await pool.query(
        `INSERT INTO ipregister_1 (id, \`${dbCol}\`) VALUES (?, ?)
         ON DUPLICATE KEY UPDATE \`${dbCol}\` = VALUES(\`${dbCol}\`)`,
        [guestId, next]
      );
    }

    res.json({ success: true, [phaseKey]: next });
  } catch (err) {
    console.error('UPDATE PHASE ERROR:', err.message, err.code);
    res.status(500).json({ message: err.message });
  }
};

// ─── POST /api/babycloud/ips-register/:guestId/init ─────────────────────────
// Ensures a row exists in every table for this guest (mirrors PHP's INSERT INTO $table (id))

export const initRegister = async (req, res) => {
  if (!req.session?.user) return res.status(401).json({ message: 'Unauthorized' });

  const { guestId } = req.params;
  if (!isValidId(guestId)) return res.status(400).json({ message: 'ID inválido' });

  try {
    const tablesToInit = [
      'ipregister_1', 'ipregister_2', 'ipregister_2_2',
      'ipregister_3', 'ipregister_4', 'ipregister_5', 'ipregister_6',
    ];

    for (const t of tablesToInit) {
      await pool.query(
        `INSERT IGNORE INTO \`${t}\` (id) VALUES (?)`, [guestId]
      );
    }

    res.json({ success: true });
  } catch (err) {
    console.error('INIT REGISTER ERROR:', err.message, err.code);
    res.status(500).json({ message: err.message });
  }
};