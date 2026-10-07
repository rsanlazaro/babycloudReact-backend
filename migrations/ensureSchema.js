// backend/migrations/ensureSchema.js
// Applies the CURP-link schema changes on startup, on the SAME database the
// backend is connected to (DB_* in .env). Safe to run on every start: each
// step first checks whether it is already applied.
//
// Equivalent to migrations/2026-09-28_payments_gest_curp.sql.

const columnExists = async (pool, table, column) => {
  const [rows] = await pool.query(
    `SELECT 1 FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column]
  );
  return rows.length > 0;
};

const indexExists = async (pool, table, index) => {
  const [rows] = await pool.query(
    `SELECT 1 FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?`,
    [table, index]
  );
  return rows.length > 0;
};

export const ensureSchema = async (pool) => {
  const [[{ db }]] = await pool.query('SELECT DATABASE() AS db');
  const tag = `[schema:${db}]`;

  // 1. payments_gest.curp
  if (!(await columnExists(pool, 'payments_gest', 'curp'))) {
    await pool.query('ALTER TABLE payments_gest ADD COLUMN curp VARCHAR(18) NULL AFTER gesca');
    console.log(`${tag} added column payments_gest.curp`);
  }

  // 2. One payment scheme per CURP (NULLs allowed for older registers)
  if (!(await indexExists(pool, 'payments_gest', 'uq_payments_gest_curp'))) {
    try {
      await pool.query('ALTER TABLE payments_gest ADD UNIQUE KEY uq_payments_gest_curp (curp)');
      console.log(`${tag} added unique key payments_gest.curp`);
    } catch (err) {
      // Only possible if duplicated CURPs were already typed in by hand
      console.error(`${tag} could not add UNIQUE(curp) — duplicated CURPs in payments_gest? ` +
        'Fix them and restart. Duplicates are still blocked by the app.', err.message);
    }
  }

  // 3. SORT_GES CURPs normalized (uppercase, no spaces) so lookups match.
  //    BINARY so lowercase values are detected despite case-insensitive collations.
  if (await columnExists(pool, 'sort_ges_alta_gesca', 'curp')) {
    const [r] = await pool.query(
      `UPDATE sort_ges_alta_gesca
          SET curp = UPPER(REPLACE(curp, ' ', ''))
        WHERE curp IS NOT NULL AND curp <> ''
          AND BINARY curp <> BINARY UPPER(REPLACE(curp, ' ', ''))`
    );
    if (r.affectedRows) console.log(`${tag} normalized ${r.affectedRows} SORT_GES CURP(s)`);

    // 4. Faster CURP lookups
    if (!(await indexExists(pool, 'sort_ges_alta_gesca', 'idx_sort_ges_alta_gesca_curp'))) {
      await pool.query('CREATE INDEX idx_sort_ges_alta_gesca_curp ON sort_ges_alta_gesca (curp)');
      console.log(`${tag} added index sort_ges_alta_gesca.curp`);
    }
  }

  // 5. Contract per payment scheme (Babyboom | Nora). Existing rows → Babyboom.
  if (!(await columnExists(pool, 'payments_gest', 'contrato'))) {
    await pool.query(
      "ALTER TABLE payments_gest ADD COLUMN contrato VARCHAR(30) NOT NULL DEFAULT 'Babyboom' AFTER scheme_value"
    );
    console.log(`${tag} added column payments_gest.contrato (existing schemes set to Babyboom)`);
  }

  // 6. Cita previa redesign (Sort_GESCA → Cita previa): citas vs laboratorios,
  //    resolución, incidencia and the "No acudió" history.
  if (await columnExists(pool, 'sort_ges_cita_previa', 'sub_tab')) {
    const citaCols = [
      ['tipo',       "VARCHAR(20) NOT NULL DEFAULT 'cita'"],   // 'cita' | 'laboratorio'
      ['resolucion', 'VARCHAR(30) NULL'],                      // alerta | alerta_incidencia | no_apta
      ['incidencia', 'VARCHAR(60) NULL'],                      // key from the incidencias catalog
      ['no_acudio',  'LONGTEXT NULL'],                         // JSON [{ fecha_cita, remarcada }]
    ];
    for (const [col, def] of citaCols) {
      if (!(await columnExists(pool, 'sort_ges_cita_previa', col))) {
        await pool.query(`ALTER TABLE sort_ges_cita_previa ADD COLUMN ${col} ${def}`);
        console.log(`${tag} added column sort_ges_cita_previa.${col}`);
      }
    }
    // New motivo keys are longer than the old ones → make sure the column fits them
    const [[motivoCol]] = await pool.query(
      `SELECT DATA_TYPE AS type, CHARACTER_MAXIMUM_LENGTH AS len
         FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sort_ges_cita_previa' AND COLUMN_NAME = 'motivo'`
    );
    if (motivoCol && (motivoCol.type === 'enum' || (motivoCol.type === 'varchar' && Number(motivoCol.len) < 60))) {
      await pool.query('ALTER TABLE sort_ges_cita_previa MODIFY COLUMN motivo VARCHAR(80) NULL');
      console.log(`${tag} widened sort_ges_cita_previa.motivo to VARCHAR(80)`);
    }
  }

  // 7. Sort_IPS tables (created once; IF NOT EXISTS makes this safe on every start)
  const tableExists = async (table) => {
    const [rows] = await pool.query(
      'SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', [table]
    );
    return rows.length > 0;
  };
  if (!(await tableExists('sort_ip_candidates'))) {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS sort_ip_candidates (
        id              INT AUTO_INCREMENT PRIMARY KEY,
        nombre_completo VARCHAR(200) NOT NULL,
        guest_id        INT NULL,                        -- Cloud IPS login (guests.id), optional
        status          VARCHAR(30) NOT NULL DEFAULT 'activo',
        created_by      INT NULL,
        created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_sort_ip_guest (guest_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    console.log(`${tag} created table sort_ip_candidates`);
  }
  if (!(await tableExists('sort_ip_sections'))) {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS sort_ip_sections (
        candidate_id INT NOT NULL,
        section      VARCHAR(30) NOT NULL,               -- alta | checklist | crio | preparacion | programa
        data         LONGTEXT NULL,                      -- JSON with that tab's fields
        updated_by   INT NULL,
        updated_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (candidate_id, section),
        CONSTRAINT fk_sort_ip_sections_candidate
          FOREIGN KEY (candidate_id) REFERENCES sort_ip_candidates (id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    console.log(`${tag} created table sort_ip_sections`);
  }

  console.log(`${tag} schema OK (CURP link, contrato, Sort_IPS)`);
};