import pool from '../db.js';
import { logActivity, ACTIVITY_TYPES, ENTITY_TYPES } from '../services/activityLogger.js';

// Accepts an activity log entry from the frontend for actions that don't go
// through a create/update/delete CRUD endpoint (e.g. previewing or generating
// a report/invoice/legal-document PDF).
export const createLog = async (req, res) => {
  if (!req.session?.user) {
    return res.status(401).json({ message: 'Unauthorized' });
  }

  const { activityType, entityType, description, metadata } = req.body;

  if (!activityType || !Object.values(ACTIVITY_TYPES).includes(activityType)) {
    return res.status(400).json({ message: 'activityType inválido' });
  }
  if (!entityType || !Object.values(ENTITY_TYPES).includes(entityType)) {
    return res.status(400).json({ message: 'entityType inválido' });
  }
  if (!description || !description.trim()) {
    return res.status(400).json({ message: 'description es obligatoria' });
  }

  const success = await logActivity({
    userId: req.session.user.id,
    activityType,
    entityType,
    description,
    created_at: new Date(),
    metadata,
  });

  if (!success) {
    return res.status(500).json({ message: 'Error al registrar la actividad' });
  }

  res.status(201).json({ message: 'Actividad registrada' });
};

export const getLogs = async (req, res) => {
  if (!req.session?.user) {
    return res.status(401).json({ message: 'Unauthorized' });
  }

  try {
    const {
      page = 1,
      limit = 20,
      userId,
      activityType,
      entityType,
      startDate,
      endDate,
      searchTerm,
    } = req.query;

    const offset = (page - 1) * limit;

    let where = [];
    let params = [];

    if (userId) {
      where.push('al.user_id = ?');
      params.push(userId);
    }

    if (activityType) {
      where.push('al.activity_type = ?');
      params.push(activityType);
    }

    if (entityType) {
      where.push('al.entity_type = ?');
      params.push(entityType);
    }

    if (startDate) {
      where.push('DATE(al.created_at) >= ?');
      params.push(startDate);
    }

    if (endDate) {
      where.push('DATE(al.created_at) <= ?');
      params.push(endDate);
    }

    if (searchTerm) {
      where.push('al.description LIKE ?');
      params.push(`%${searchTerm}%`);
    }

    const whereSQL = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const [rows] = await pool.query(
      `
      SELECT 
        al.*,
        u.username
      FROM activity_logs al
      JOIN users u ON u.id = al.user_id
      ${whereSQL}
      ORDER BY al.created_at DESC
      LIMIT ? OFFSET ?
      `,
      [...params, Number(limit), Number(offset)]
    );

    const [[{ total }]] = await pool.query(
      `
      SELECT COUNT(*) AS total
      FROM activity_logs al
      ${whereSQL}
      `,
      params
    );

    res.json({
      data: rows,
      total,
    });
  } catch (err) {
    console.error('GET LOGS ERROR:', err);
    res.status(500).json({ message: 'Server error' });
  }
};