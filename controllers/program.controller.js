// controllers/programController.js
import pool from '../db.js';

// Get all programs with summary data
export const getAllPrograms = async (req, res) => {
  try {
    const query = `
      SELECT 
        p.*,
        COALESCE(SUM(ph.phase_value), 0) AS total_program_value,
        COUNT(DISTINCT ph.id) AS phase_count
      FROM programs p
      LEFT JOIN program_phases ph ON p.id = ph.program_id
      GROUP BY p.id
      ORDER BY p.created_at DESC
    `;
    
    const [programs] = await pool.query(query);
    res.json(programs);
  } catch (error) {
    console.error('Error fetching programs:', error);
    res.status(500).json({ message: 'Error al obtener los programas', error: error.message });
  }
};

// Get single program with phases and expenses
export const getProgramById = async (req, res) => {
  try {
    const { id } = req.params;
    
    // Get program
    const [programs] = await pool.query('SELECT * FROM programs WHERE id = ?', [id]);
    
    if (programs.length === 0) {
      return res.status(404).json({ message: 'Programa no encontrado' });
    }
    
    const program = programs[0];
    
    // Get phases
    const [phases] = await pool.query(
      'SELECT * FROM program_phases WHERE program_id = ? ORDER BY sort_order',
      [id]
    );
    
    // Get expenses
    const [expenses] = await pool.query(
      'SELECT * FROM program_expenses WHERE program_id = ? ORDER BY expense_date DESC',
      [id]
    );
    
    res.json({
      ...program,
      phases,
      expenses
    });
  } catch (error) {
    console.error('Error fetching program:', error);
    res.status(500).json({ message: 'Error al obtener el programa', error: error.message });
  }
};

// Create new program with phases and expenses
export const createProgram = async (req, res) => {
  const connection = await pool.getConnection();
  
  try {
    await connection.beginTransaction();
    
    const {
      ip_name,
      couple_name,
      country,
      contract_date,
      deposit_1,
      deposit_2,
      donor_select,
      select_2,
      select_3,
      select_r,
      catalog,
      catalog_value,
      crio_embryo,
      xx_count,
      xy_count,
      ni_count,
      tank,
      surrogate,
      birth_info,
      clabe,
      insurance,
      policy,
      manager,
      currency,
      exchange_rate,
      status,
      phases,
      expenses
    } = req.body;
    
    // Insert program
    const [programResult] = await connection.query(
      `INSERT INTO programs (
        ip_name, couple_name, country, contract_date, deposit_1, deposit_2,
        donor_select, select_2, select_3, select_r, catalog, catalog_value,
        crio_embryo, xx_count, xy_count, ni_count, tank, surrogate, birth_info,
        clabe, insurance, policy, manager, currency, exchange_rate, status,
        created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        ip_name, couple_name, country, contract_date, deposit_1, deposit_2,
        donor_select, select_2, select_3, select_r, catalog, catalog_value,
        crio_embryo, xx_count, xy_count, ni_count, tank, surrogate, birth_info,
        clabe, insurance, policy, manager, currency, exchange_rate, status || 'active',
        req.user?.id || null
      ]
    );
    
    const programId = programResult.insertId;
    
    // Insert phases and track their new IDs by index
    const phaseIdsByIndex = {};
    if (phases && phases.length > 0) {
      for (let i = 0; i < phases.length; i++) {
        const phase = phases[i];
        const [phaseResult] = await connection.query(
          `INSERT INTO program_phases (
            program_id, phase_name, phase_value,
            payment_1_amount, payment_1_date,
            payment_2_amount, payment_2_date,
            payment_3_amount, payment_3_date,
            invoiced_to, notes, sort_order
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            programId, phase.phase_name, phase.phase_value,
            phase.payment_1_amount, phase.payment_1_date,
            phase.payment_2_amount, phase.payment_2_date,
            phase.payment_3_amount, phase.payment_3_date,
            phase.invoiced_to, phase.notes, phase.sort_order
          ]
        );
        // Store the new phase ID by its index
        phaseIdsByIndex[i] = phaseResult.insertId;
      }
    }
    
    // Insert expenses - resolve phase_index to actual phase_id
    if (expenses && expenses.length > 0) {
      for (const expense of expenses) {
        // Determine the correct phase_id
        let phaseId = null;
        if (expense.phase_id) {
          phaseId = expense.phase_id;
        } else if (expense.phase_index !== null && expense.phase_index !== undefined) {
          // Look up the newly created phase ID by index
          phaseId = phaseIdsByIndex[expense.phase_index] || null;
        }
        
        await connection.query(
          `INSERT INTO program_expenses (
            program_id, phase_id, expense_date, movement_type, reason,
            origin, destination, bank, amount, currency, notes,
            is_auto_generated, payment_number
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            programId, phaseId, expense.expense_date, expense.movement_type,
            expense.reason, expense.origin, expense.destination, expense.bank,
            expense.amount, expense.currency, expense.notes,
            expense.is_auto_generated || false, expense.payment_number
          ]
        );
      }
    }
    
    await connection.commit();
    
    res.status(201).json({ 
      id: programId, 
      message: 'Programa creado correctamente' 
    });
  } catch (error) {
    await connection.rollback();
    console.error('Error creating program:', error);
    res.status(500).json({ message: 'Error al crear el programa', error: error.message });
  } finally {
    connection.release();
  }
};

// Update program with phases and expenses
export const updateProgram = async (req, res) => {
  const connection = await pool.getConnection();
  
  try {
    await connection.beginTransaction();
    
    const { id } = req.params;
    const {
      ip_name,
      couple_name,
      country,
      contract_date,
      deposit_1,
      deposit_2,
      donor_select,
      select_2,
      select_3,
      select_r,
      catalog,
      catalog_value,
      crio_embryo,
      xx_count,
      xy_count,
      ni_count,
      tank,
      surrogate,
      birth_info,
      clabe,
      insurance,
      policy,
      manager,
      currency,
      exchange_rate,
      status,
      phases,
      expenses
    } = req.body;
    
    // Update program
    await connection.query(
      `UPDATE programs SET
        ip_name = ?, couple_name = ?, country = ?, contract_date = ?,
        deposit_1 = ?, deposit_2 = ?, donor_select = ?, select_2 = ?,
        select_3 = ?, select_r = ?, catalog = ?, catalog_value = ?,
        crio_embryo = ?, xx_count = ?, xy_count = ?, ni_count = ?,
        tank = ?, surrogate = ?, birth_info = ?, clabe = ?,
        insurance = ?, policy = ?, manager = ?, currency = ?,
        exchange_rate = ?, status = ?, updated_by = ?
      WHERE id = ?`,
      [
        ip_name, couple_name, country, contract_date,
        deposit_1, deposit_2, donor_select, select_2,
        select_3, select_r, catalog, catalog_value,
        crio_embryo, xx_count, xy_count, ni_count,
        tank, surrogate, birth_info, clabe,
        insurance, policy, manager, currency,
        exchange_rate, status, req.user?.id || null, id
      ]
    );
    
    // Handle phases - get existing phase IDs
    const [existingPhases] = await connection.query(
      'SELECT id FROM program_phases WHERE program_id = ?',
      [id]
    );
    const existingPhaseIds = existingPhases.map(p => p.id);
    const updatedPhaseIds = phases?.filter(p => p.id).map(p => p.id) || [];
    
    // Delete phases that are no longer in the list
    const phasesToDelete = existingPhaseIds.filter(pid => !updatedPhaseIds.includes(pid));
    if (phasesToDelete.length > 0) {
      await connection.query(
        'DELETE FROM program_phases WHERE id IN (?)',
        [phasesToDelete]
      );
    }
    
    // Update or insert phases and track new phase IDs by index
    const phaseIdsByIndex = {};
    if (phases && phases.length > 0) {
      for (let i = 0; i < phases.length; i++) {
        const phase = phases[i];
        if (phase.id && existingPhaseIds.includes(phase.id)) {
          // Update existing phase
          await connection.query(
            `UPDATE program_phases SET
              phase_name = ?, phase_value = ?,
              payment_1_amount = ?, payment_1_date = ?,
              payment_2_amount = ?, payment_2_date = ?,
              payment_3_amount = ?, payment_3_date = ?,
              invoiced_to = ?, notes = ?, sort_order = ?
            WHERE id = ?`,
            [
              phase.phase_name, phase.phase_value,
              phase.payment_1_amount, phase.payment_1_date,
              phase.payment_2_amount, phase.payment_2_date,
              phase.payment_3_amount, phase.payment_3_date,
              phase.invoiced_to, phase.notes, phase.sort_order,
              phase.id
            ]
          );
          // Store existing phase ID by index
          phaseIdsByIndex[i] = phase.id;
        } else {
          // Insert new phase
          const [phaseResult] = await connection.query(
            `INSERT INTO program_phases (
              program_id, phase_name, phase_value,
              payment_1_amount, payment_1_date,
              payment_2_amount, payment_2_date,
              payment_3_amount, payment_3_date,
              invoiced_to, notes, sort_order
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              id, phase.phase_name, phase.phase_value,
              phase.payment_1_amount, phase.payment_1_date,
              phase.payment_2_amount, phase.payment_2_date,
              phase.payment_3_amount, phase.payment_3_date,
              phase.invoiced_to, phase.notes, phase.sort_order
            ]
          );
          // Store new phase ID by index
          phaseIdsByIndex[i] = phaseResult.insertId;
        }
      }
    }
    
    // Handle expenses - similar logic
    const [existingExpenses] = await connection.query(
      'SELECT id FROM program_expenses WHERE program_id = ?',
      [id]
    );
    const existingExpenseIds = existingExpenses.map(e => e.id);
    const updatedExpenseIds = expenses?.filter(e => e.id).map(e => e.id) || [];
    
    // Delete expenses that are no longer in the list
    const expensesToDelete = existingExpenseIds.filter(eid => !updatedExpenseIds.includes(eid));
    if (expensesToDelete.length > 0) {
      await connection.query(
        'DELETE FROM program_expenses WHERE id IN (?)',
        [expensesToDelete]
      );
    }
    
    // Update or insert expenses - resolve phase_index to actual phase_id
    if (expenses && expenses.length > 0) {
      for (const expense of expenses) {
        // Determine the correct phase_id
        let phaseId = null;
        if (expense.phase_id) {
          phaseId = expense.phase_id;
        } else if (expense.phase_index !== null && expense.phase_index !== undefined) {
          // Look up the phase ID by index (either existing or newly created)
          phaseId = phaseIdsByIndex[expense.phase_index] || null;
        }
        
        if (expense.id && existingExpenseIds.includes(expense.id)) {
          // Update existing expense
          await connection.query(
            `UPDATE program_expenses SET
              phase_id = ?, expense_date = ?, movement_type = ?, reason = ?,
              origin = ?, destination = ?, bank = ?, amount = ?,
              currency = ?, notes = ?, is_auto_generated = ?, payment_number = ?
            WHERE id = ?`,
            [
              phaseId, expense.expense_date, expense.movement_type,
              expense.reason, expense.origin, expense.destination, expense.bank,
              expense.amount, expense.currency, expense.notes,
              expense.is_auto_generated, expense.payment_number,
              expense.id
            ]
          );
        } else {
          // Insert new expense
          await connection.query(
            `INSERT INTO program_expenses (
              program_id, phase_id, expense_date, movement_type, reason,
              origin, destination, bank, amount, currency, notes,
              is_auto_generated, payment_number
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              id, phaseId, expense.expense_date, expense.movement_type,
              expense.reason, expense.origin, expense.destination, expense.bank,
              expense.amount, expense.currency, expense.notes,
              expense.is_auto_generated, expense.payment_number
            ]
          );
        }
      }
    }
    
    await connection.commit();
    
    res.json({ message: 'Programa actualizado correctamente' });
  } catch (error) {
    await connection.rollback();
    console.error('Error updating program:', error);
    res.status(500).json({ message: 'Error al actualizar el programa', error: error.message });
  } finally {
    connection.release();
  }
};

// Delete single program
export const deleteProgram = async (req, res) => {
  try {
    const { id } = req.params;
    
    // Phases and expenses will be deleted automatically due to CASCADE
    await pool.query('DELETE FROM programs WHERE id = ?', [id]);
    
    res.json({ message: 'Programa eliminado correctamente' });
  } catch (error) {
    console.error('Error deleting program:', error);
    res.status(500).json({ message: 'Error al eliminar el programa', error: error.message });
  }
};

// Bulk delete programs
export const bulkDeletePrograms = async (req, res) => {
  try {
    const { ids } = req.body;
    
    if (!ids || ids.length === 0) {
      return res.status(400).json({ message: 'No se proporcionaron IDs para eliminar' });
    }
    
    await pool.query('DELETE FROM programs WHERE id IN (?)', [ids]);
    
    res.json({ message: `${ids.length} programa(s) eliminado(s) correctamente` });
  } catch (error) {
    console.error('Error bulk deleting programs:', error);
    res.status(500).json({ message: 'Error al eliminar los programas', error: error.message });
  }
};

// Get program summary/stats
export const getProgramStats = async (req, res) => {
  try {
    const [stats] = await pool.query(`
      SELECT 
        COUNT(*) as total_programs,
        SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active_count,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed_count,
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending_count,
        SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) as cancelled_count
      FROM programs
    `);
    
    const [financialStats] = await pool.query(`
      SELECT 
        p.currency,
        COUNT(DISTINCT p.id) as program_count,
        COALESCE(SUM(ph.phase_value), 0) as total_value
      FROM programs p
      LEFT JOIN program_phases ph ON p.id = ph.program_id
      GROUP BY p.currency
    `);
    
    res.json({
      counts: stats[0],
      financials: financialStats
    });
  } catch (error) {
    console.error('Error fetching program stats:', error);
    res.status(500).json({ message: 'Error al obtener estadísticas', error: error.message });
  }
};