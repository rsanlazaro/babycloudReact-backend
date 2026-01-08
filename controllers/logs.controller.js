import pool from '../db.js';

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

