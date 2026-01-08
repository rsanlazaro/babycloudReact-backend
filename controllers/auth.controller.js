import pool from '../db.js';
import { logActivity, logUpdate, logCreate, logDelete, logLogin, logLogout, ACTIVITY_TYPES, ENTITY_TYPES } from '../services/activityLogger.js';

const today = new Date();

export const login = async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ message: 'Username and password are required' });
  }

  try {
    // Build dynamic column selection for access_1 to access_83
    const accessColumns = Array.from({ length: 83 }, (_, i) => `access_${i + 1}`).join(', ');

    const [rows] = await pool.query(
      `SELECT 
        id,
        username,
        mail,
        password,
        profile,
        profile_url,
        enabled,
        ${accessColumns}
       FROM users
       WHERE username = ? OR mail = ?`,
      [username, username]
    );

    if (rows.length === 0) {
      return res.status(401).json({ message: 'Credenciales inválidas' });
    }

    const user = rows[0];

    // Check if user is enabled
    if (!user.enabled) {
      return res.status(401).json({ message: 'Usuario deshabilitado' });
    }

    // Check password (plain text for now)
    if (password !== user.password) {
      return res.status(401).json({ message: 'Credenciales inválidas' });
    }

    // Extract permissions (access_1 to access_83)
    const access = {};
    for (let i = 1; i <= 83; i++) {
      access[`access_${i}`] = user[`access_${i}`] ?? 0;
    }

    // Create session
    req.session.user = {
      id: user.id,
      username: user.username,
      email: user.mail,
      role: user.profile,
      profileImage: user.profile_url ? { url: user.profile_url } : null,
    };

    const metadata = user.email;

    await logLogin(
      user.id,
      user.username,
      today,
      metadata,
    );

    // Save session and respond
    req.session.save((err) => {
      if (err) {
        console.error('Session save error:', err);
        return res.status(500).json({ message: 'Error al iniciar sesión' });
      }

      // IMPORTANTE: Devolver user Y access
      res.json({
        user: {
          id: user.id,
          username: user.username,
          email: user.mail,
          role: user.profile,
          profileImage: user.profile_url ? { url: user.profile_url } : null,
        },
        access, // { access_1: 1, access_2: 0, ... }
      });
    });
  } catch (err) {
    console.error('LOGIN ERROR:', err);
    res.status(500).json({ message: 'Server error' });
  }
};

export const logout = async (req, res) => {
  const { id, username } = req.session.user;
  logLogout(
    id,
    username,
    today,
    '',
  );

  req.session.destroy((err) => {
    if (err) {
      console.error('LOGOUT ERROR:', err);
      return res.status(500).json({ message: 'Error al cerrar sesión' });
    }
    res.clearCookie('connect.sid');
    res.json({ success: true });
  });
};