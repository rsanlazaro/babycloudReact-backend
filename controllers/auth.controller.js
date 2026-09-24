import pool from '../db.js';
import { logActivity, logUpdate, logCreate, logDelete, logLogin, logLogout, ACTIVITY_TYPES, ENTITY_TYPES } from '../services/activityLogger.js';

// Normalizes `enabled` from MySQL: TINYINT (0/1), BIT(1) (Buffer), strings ('0'/'1'/'true')
export const isEnabled = (value) => {
  if (Buffer.isBuffer(value)) return value[0] === 1;
  if (typeof value === 'string') return ['1', 'true', 'si', 'sí', 'yes'].includes(value.trim().toLowerCase());
  return Number(value) === 1 || value === true;
};

export const login = async (req, res) => {
  const today = new Date();
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ message: 'Username and password are required' });
  }

  try {
    // Build dynamic column selection for access_1 to access_95
    const accessColumns = Array.from({ length: 100 }, (_, i) => `access_${i + 1}`).join(', ');

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

    // Only a users row whose password matches (plain text for now) counts.
    // If it's missing or disabled, fall through to the guests table instead of
    // stopping here — a username/mail shared with a guest must not block them.
    const user = rows.find((r) => r.password === password);

    if (!user || !isEnabled(user.enabled)) {
      return loginAsGuest(req, res, username, password, !!user);
    }

    // Extract permissions (access_1 to access_95)
    const access = {};
    for (let i = 1; i <= 100; i++) {
      access[`access_${i}`] = user[`access_${i}`] ?? 0;
    }

    // ===== SPECIAL BUTTON ACCESS CONTROL =====
    // Define allowed users for the special button (ONLY IN BACKEND)
    const ALLOWED_USERS_FOR_BUTTON = [
      'admin',
      'Gerencia_Jr',
      'Hennanie',
      'AdminBabyCloud',
      'Junior',
      'Anthony',
      // Add more usernames here as needed
    ];

    // Check if current user is in the allowed list
    const hasSpecialButtonAccess = ALLOWED_USERS_FOR_BUTTON.includes(user.username);
    // =========================================

    // Create session with access permissions
    delete req.session.guest; // never keep a guest identity alongside a user one
    req.session.user = {
      id: user.id,
      username: user.username,
      email: user.mail,
      role: user.profile,
      profileImage: user.profile_url ? { url: user.profile_url } : null,
      access, // Include access in session
      hasSpecialButtonAccess, // Add special button permission
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
          hasSpecialButtonAccess, // Send permission to frontend
        },
        access, // { access_1: 1, access_2: 0, ... }
      });
    });
  } catch (err) {
    console.error('LOGIN ERROR:', err);
    res.status(500).json({ message: 'Server error' });
  }
};

// ─── Guest login ─────────────────────────────────────────────────────────────
// Guests live in a separate session key (req.session.guest) on purpose:
// every existing endpoint checks req.session.user, so a guest session is
// rejected everywhere by default. Only endpoints that explicitly opt in
// (see cloudIps getRegister) let a guest through.
// disabledUserMatched: a users row matched the password but is disabled
const loginAsGuest = async (req, res, username, password, disabledUserMatched = false) => {
  const [rows] = await pool.query(
    `SELECT id, username, mail, password, profile, enabled
       FROM guests
      WHERE username = ? OR mail = ?`,
    [username, username]
  );

  // Plain text for now, same as users
  const guest = rows.find((r) => r.password === password);

  if (!guest || !isEnabled(guest.enabled)) {
    // "Deshabilitado" only when the password was right for a disabled account
    const disabled = disabledUserMatched || !!guest;
    return res.status(401).json({ message: disabled ? 'Usuario deshabilitado' : 'Credenciales inválidas' });
  }

  delete req.session.user;
  req.session.guest = {
    id: guest.id,
    username: guest.username,
    email: guest.mail,
    profile: guest.profile,
  };

  req.session.save((err) => {
    if (err) {
      console.error('Session save error:', err);
      return res.status(500).json({ message: 'Error al iniciar sesión' });
    }

    res.json({
      user: buildGuestPayload(req.session.guest),
      access: {}, // guests have no access_N permissions
    });
  });
};

// Shape sent to the frontend for a guest (mirrors the user object + isGuest)
export const buildGuestPayload = (guest) => ({
  id: guest.id,
  username: guest.username,
  email: guest.email,
  role: guest.profile,
  profileImage: null,
  hasSpecialButtonAccess: false,
  isGuest: true,
});

export const logout = async (req, res) => {
  const today = new Date();
  if (!req.session.user && !req.session.guest) {
    return res.status(400).json({ message: 'User session not defined' });
  }

  // activity_logs.user_id points to the users table, so guest logouts are not logged
  if (req.session.user) {
    const { id, username } = req.session.user;
    logLogout(
      id,
      username,
      today,
      '',
    );
  }

  req.session.destroy((err) => {
    if (err) {
      console.error('LOGOUT ERROR:', err);
      return res.status(500).json({ message: 'Error al cerrar sesión' });
    }
    res.clearCookie('connect.sid');
    res.json({ success: true });
  });
};

export const verifySpecialAccess = async (req, res) => {
  if (!req.session?.user) {
    return res.status(401).json({ message: 'Unauthorized' });
  }

  const { password } = req.body;

  if (!password) {
    return res.status(400).json({ message: 'Contraseña es requerida' });
  }

  try {
    // Define the shared password (ONLY IN BACKEND)
    const SPECIAL_ACCESS_PASSWORD = 'adm@bbcloud'; // Change this!

    // Verify the password
    if (password === SPECIAL_ACCESS_PASSWORD) {
      // Optional: Store in session that user has verified access
      req.session.hasVerifiedSpecialAccess = true;
      
      return res.json({ 
        success: true,
        message: 'Acceso autorizado' 
      });
    } else {
      return res.status(403).json({ 
        message: 'Contraseña incorrecta' 
      });
    }
  } catch (err) {
    console.error('VERIFY SPECIAL ACCESS ERROR:', err);
    res.status(500).json({ message: 'Error del servidor' });
  }
};