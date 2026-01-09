import pool from '../db.js';
import { logActivity, logUpdate, logCreate, logDelete, logLogin, logLogout, ACTIVITY_TYPES, ENTITY_TYPES } from '../services/activityLogger.js';

// Update getMe to also return permissions
export const getMe = async (req, res) => {
  if (!req.session?.user) {
    return res.status(401).json({ message: 'Unauthorized' });
  }

  try {
    // Build dynamic column selection for access_1 to access_83
    const accessColumns = Array.from({ length: 83 }, (_, i) => `access_${i + 1}`).join(', ');

    const [rows] = await pool.query(
      `SELECT 
        id,
        username,
        mail,
        profile,
        profile_url,
        ${accessColumns}
       FROM users
       WHERE id = ?`,
      [req.session.user.id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: 'User not found' });
    }

    const user = rows[0];

    // Extract permissions
    const access = {};
    for (let i = 1; i <= 83; i++) {
      access[`access_${i}`] = user[`access_${i}`] ?? 0;
    }

    res.json({
      user: {
        id: user.id,
        username: user.username,
        email: user.mail,
        role: user.profile,
        profileImage: user.profile_url ? { url: user.profile_url } : null,
      },
      access, // Include permissions
    });
  } catch (err) {
    console.error('GET ME ERROR:', err);
    res.status(500).json({ message: 'Server error' });
  }
};

export const updateProfileImage = async (req, res) => {
  const today = new Date();

  if (!req.session?.user) {
    return res.status(401).json({ message: 'Unauthorized' });
  }

  const userId = req.session.user.id;
  const { profileUrl, publicId, version } = req.body;

  if (!profileUrl || !publicId || !version) {
    return res.status(400).json({ message: 'Missing required fields' });
  }

  try {
    // Update DB
    await pool.query(
      'UPDATE users SET profile_url = ? WHERE id = ?',
      [profileUrl, userId]
    );

    // Update session
    const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
    const url = `https://res.cloudinary.com/${cloudName}/image/upload/v${version}/${publicId}.jpg`;

    req.session.user.profileImage = { publicId, version, url };

    // Persist session (important for Redis)
    req.session.save(() => {
      res.json({ success: true });
    });

    await logUpdate(
      userId,
      'progestor',
      `${req.session.user.username} actualizó su foto de perfil`,
      today,
      publicId,
    );

  } catch (err) {
    console.error('PROFILE IMAGE UPDATE ERROR:', err);
    res.status(500).json({ message: 'Failed to update profile image' });
  }
};

export const updateProfile = async (req, res) => {
  const today = new Date();
  if (!req.session?.user) {
    return res.status(401).json({ message: 'Unauthorized' });
  }

  const userId = req.session.user.id;
  const { username, email, role, password } = req.body;

  // Basic validation
  if (!username || !email || !role) {
    return res.status(400).json({ message: 'Username, email, and role are required' });
  }

  try {
    // Check if username is already taken by another user
    const [existingUsername] = await pool.query(
      'SELECT id FROM users WHERE username = ? AND id != ?',
      [username, userId]
    );

    if (existingUsername.length > 0) {
      return res.status(409).json({ message: 'Username already taken' });
    }

    // Check if email is already taken by another user
    const [existingEmail] = await pool.query(
      'SELECT id FROM users WHERE mail = ? AND id != ?',
      [email, userId]
    );

    if (existingEmail.length > 0) {
      return res.status(409).json({ message: 'Email already taken' });
    }

    // Build update query dynamically based on whether password is provided
    let query;
    let params;
    let metadata;

    if (password && password.trim() !== '') {
      // Hash the new password
      // const saltRounds = 10;
      // const hashedPassword = await bcrypt.hash(password, saltRounds);

      query = `
        UPDATE users 
        SET username = ?, mail = ?, profile = ?, password = ?
        WHERE id = ?
      `;
      params = [username, email, role, password, userId];
      metadata = [email, password];
    } else {
      query = `
        UPDATE users 
        SET username = ?, mail = ?, profile = ?
        WHERE id = ?
      `;
      params = [username, email, role, userId];
      metadata = email;
    }

    await pool.query(query, params);

    await logUpdate(
      req.session.user.id,
      'progestor',
      `${req.session.user.username} actualizó sus datos`,
      today,
      metadata,
    );

    // Update session with new data
    req.session.user.username = username;
    req.session.user.email = email;
    req.session.user.role = role;

    req.session.save((err) => {
      if (err) {
        console.error('Session save error:', err);
        return res.status(500).json({ message: 'Failed to update session' });
      }

      res.json({
        success: true,
        user: {
          id: userId,
          username,
          email,
          role,
        },
      });
    });

  } catch (err) {
    console.error('PROFILE UPDATE ERROR:', err);
    res.status(500).json({ message: 'Failed to update profile' });
  }
};

export const getAllUsers = async (req, res) => {
  if (!req.session?.user) {
    return res.status(401).json({ message: 'Unauthorized' });
  }

  try {
    const [rows] = await pool.query(
      `SELECT 
        id,
        username,
        password,
        mail as email,
        profile,
        created_on,
        enabled
       FROM users
       ORDER BY created_on DESC`
    );

    res.json(rows);
  } catch (err) {
    console.error('GET ALL USERS ERROR:', err);
    res.status(500).json({ message: 'Server error' });
  }
};

export const createUser = async (req, res) => {
  const today = new Date();
  if (!req.session?.user) {
    return res.status(401).json({ message: 'Unauthorized' });
  }

  const { username, email, password, profile = 'recluta' } = req.body;

  if (!username || !email || !password) {
    return res.status(400).json({
      message: 'Username, email, and password are required',
    });
  }

  const allowedProfiles = [
    'super_admin',
    'admin_junior',
    'coordinador',
    'operador',
    'recluta',
  ];

  if (!allowedProfiles.includes(profile)) {
    return res.status(400).json({ message: 'Invalid profile' });
  }

  try {
    // Check if user already exists
    const [existing] = await pool.query(
      'SELECT id FROM users WHERE username = ? OR mail = ?',
      [username, email]
    );

    if (existing.length > 0) {
      return res.status(409).json({
        message: 'El usuario o correo ya existe',
      });
    }

    // Load access template for selected profile
    const accessColumns = Array.from(
      { length: 100 },
      (_, i) => `${profile}_${i + 1}`
    ).join(', ');

    const [accessRows] = await pool.query(
      `SELECT ${accessColumns} FROM access LIMIT 1`
    );

    if (accessRows.length === 0) {
      return res.status(500).json({
        message: 'Access profile configuration not found',
      });
    }

    const accessValues = Object.values(accessRows[0]);

    // Build INSERT dynamically
    const userAccessColumns = Array.from(
      { length: 100 },
      (_, i) => `access_${i + 1}`
    ).join(', ');

    const placeholders = Array(100).fill('?').join(', ');

    const [result] = await pool.query(
      `
      INSERT INTO users (
        username,
        mail,
        password,
        profile,
        enabled,
        created_on,
        ${userAccessColumns}
      )
      VALUES (
        ?, ?, ?, ?, 1, NOW(),
        ${placeholders}
      )
      `,
      [username, email, password, profile, ...accessValues]
    );

    const metadata = [username, email, password, profile];

    // Return created user (without access flags)
    const [newUser] = await pool.query(
      `
      SELECT
        id,
        username,
        mail AS email,
        profile,
        enabled,
        created_on
      FROM users
      WHERE id = ?
      `,
      [result.insertId]
    );

    await logCreate(
      req.session.user.id,
      'progestor',
      `${req.session.user.username} creó el usuario ${username}`,
      today,
      metadata,
    );

    res.status(201).json(newUser[0]);
  } catch (err) {
    console.error('CREATE USER ERROR:', err);
    res.status(500).json({ message: 'Server error' });
  }
};

// Update user
export const updateUser = async (req, res) => {
  if (!req.session?.user) {
    return res.status(401).json({ message: 'Unauthorized' });
  }

  const today = new Date();
  const { id } = req.params;
  const { username, email, password, profile, enabled } = req.body;

  try {
    // Build dynamic update query
    const updates = [];
    const params = [];

    if (username !== undefined) {
      // Check if username is taken by another user
      const [existing] = await pool.query(
        'SELECT id FROM users WHERE username = ? AND id != ?',
        [username, id]
      );
      if (existing.length > 0) {
        return res.status(409).json({ message: 'El nombre de usuario ya está en uso' });
      }
      updates.push('username = ?');
      params.push(username);
    }

    if (email !== undefined) {
      // Check if email is taken by another user
      const [existing] = await pool.query(
        'SELECT id FROM users WHERE mail = ? AND id != ?',
        [email, id]
      );
      if (existing.length > 0) {
        return res.status(409).json({ message: 'El correo electrónico ya está en uso' });
      }
      updates.push('mail = ?');
      params.push(email);
    }

    if (password !== undefined && password.trim() !== '') {
      // Store password as plain text (you mentioned you'll add hashing later)
      updates.push('password = ?');
      params.push(password);
    }

    if (profile !== undefined) {
      updates.push('profile = ?');
      params.push(profile);
    }

    if (enabled !== undefined) {
      updates.push('enabled = ?');
      params.push(enabled);
    }

    if (updates.length === 0) {
      return res.status(400).json({ message: 'No fields to update' });
    }

    params.push(id);

    await pool.query(
      `UPDATE users SET ${updates.join(', ')} WHERE id = ?`,
      params
    );

    await logUpdate(
      req.session.user.id,
      'progestor',
      `${req.session.user.username} actualizó estos datos: [${params}]`,
      today,
      `${params}`,
    );

    res.json({ success: true });
  } catch (err) {
    console.error('UPDATE USER ERROR:', err);
    res.status(500).json({ message: 'Server error' });
  }
};

// Delete user
export const deleteUser = async (req, res) => {
  if (!req.session?.user) {
    return res.status(401).json({ message: 'Unauthorized' });
  }

  const today = new Date();
  const { id } = req.params;

  const [DeletedRow] = await pool.query(
    `
      SELECT
        username
      FROM users
      WHERE id = ?
      `,
    [id]
  );

  if (DeletedRow.length === 0) {
    return res.status(404).json({ message: 'User not found' });
  }

  const username = DeletedRow[0].username;

  // Prevent self-deletion
  if (parseInt(id) === req.session.user.id) {
    return res.status(400).json({ message: 'No puedes eliminar tu propia cuenta' });
  }

  try {
    await pool.query('DELETE FROM users WHERE id = ?', [id]);
    res.json({ success: true });
    await logDelete(
      req.session.user.id,
      'progestor',
      `${req.session.user.username} eliminó al usuario ${username}`,
      today,
      `${id}`,
    );
  } catch (err) {
    console.error('DELETE USER ERROR:', err);
    res.status(500).json({ message: 'Server error' });
  }
};

// Bulk delete users
export const bulkDeleteUsers = async (req, res) => {
  if (!req.session?.user) {
    return res.status(401).json({ message: 'Unauthorized' });
  }

  const { ids } = req.body;
  const today = new Date();

  if (!ids || !Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ message: 'No user IDs provided' });
  }

  // Prevent self-deletion
  if (ids.includes(req.session.user.id)) {
    return res.status(400).json({ message: 'No puedes eliminar tu propia cuenta' });
  }

  try {
    const [rows] = await pool.query(
      'SELECT username FROM users WHERE id IN (?)',
      [ids]
    );

    const usernames = rows.map(r => r.username);
    await pool.query('DELETE FROM users WHERE id IN (?)', [ids]);
    await logDelete(
      req.session.user.id,
      'progestor',
      `${req.session.user.username} eliminó a los usuarios [${usernames}]`,
      today,
      `${ids}`,
    );
    res.json({ success: true, deleted: ids.length });
  } catch (err) {
    console.error('BULK DELETE USERS ERROR:', err);
    res.status(500).json({ message: 'Server error' });
  }
};

// Get user roles/permissions
export const getUserRoles = async (req, res) => {
  if (!req.session?.user) {
    return res.status(401).json({ message: 'Unauthorized' });
  }

  const { id } = req.params;

  try {
    // Build dynamic column selection for access_1 to access_83
    const accessColumns = Array.from({ length: 83 }, (_, i) => `access_${i + 1}`).join(', ');

    const [rows] = await pool.query(
      `SELECT 
        id,
        username,
        mail as email,
        ${accessColumns}
       FROM users
       WHERE id = ?`,
      [id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: 'User not found' });
    }

    const user = rows[0];

    // Extract permissions
    const permissions = {};
    for (let i = 1; i <= 83; i++) {
      permissions[`access_${i}`] = user[`access_${i}`] ?? 0;
    }

    res.json({
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
      },
      permissions,
    });
  } catch (err) {
    console.error('GET USER ROLES ERROR:', err);
    res.status(500).json({ message: 'Server error' });
  }
};

// Update user roles/permissions
export const updateUserRoles = async (req, res) => {
  if (!req.session?.user) {
    return res.status(401).json({ message: 'Unauthorized' });
  }

  const today = new Date();
  const { id } = req.params;
  const { permissions } = req.body;

  if (!permissions || typeof permissions !== 'object') {
    return res.status(400).json({ message: 'Invalid permissions data' });
  }

  try {
    // Build dynamic update query
    const updates = [];
    const params = [];

    for (let i = 1; i <= 83; i++) {
      const key = `access_${i}`;
      if (permissions[key] !== undefined) {
        const value = parseInt(permissions[key], 10);
        // Validate value is 0, 1, or 2
        if ([0, 1, 2].includes(value)) {
          updates.push(`${key} = ?`);
          params.push(value);
        }
      }
    }

    if (updates.length === 0) {
      return res.status(400).json({ message: 'No valid permissions to update' });
    }

    params.push(id);

    await pool.query(
      `UPDATE users SET ${updates.join(', ')} WHERE id = ?`,
      params
    );

    res.json({ success: true });

    const [modifiedUser] = await pool.query(
      `SELECT 
        username
       FROM users
       WHERE id = ?`,
      [id]
    );

    if (modifiedUser.length === 0) {
      return res.status(404).json({ message: 'User not found' });
    }
    const user = modifiedUser[0].username;

    await logUpdate(
      req.session.user.id,
      'progestor',
      `${req.session.user.username} actualizó los permisos de ${user}`,
      today,
      `${params}`,
    );
  } catch (err) {
    console.error('UPDATE USER ROLES ERROR:', err);
    res.status(500).json({ message: 'Server error' });
  }
};

// Get all access permissions
export const getAccessRoles = async (req, res) => {
  if (!req.session?.user) {
    return res.status(401).json({ message: 'Unauthorized' });
  }

  try {
    // Build column list for all profiles (1-83)
    const profiles = ['super_admin', 'admin_junior', 'coordinador', 'operador', 'recluta'];
    const columns = [];

    profiles.forEach((profile) => {
      for (let i = 1; i <= 83; i++) {
        columns.push(`${profile}_${i}`);
      }
    });

    const [rows] = await pool.query(
      `SELECT ${columns.join(', ')} FROM access LIMIT 1`
    );

    if (rows.length === 0) {
      // Return default values if no row exists
      const defaults = {};
      columns.forEach((col) => {
        defaults[col] = 0;
      });
      return res.json(defaults);
    }

    res.json(rows[0]);
  } catch (err) {
    console.error('GET ACCESS ROLES ERROR:', err);
    res.status(500).json({ message: 'Server error' });
  }
};

// Update access permissions
export const updateAccessRoles = async (req, res) => {
  if (!req.session?.user) {
    return res.status(401).json({ message: 'Unauthorized' });
  }

  const { permissions } = req.body;

  if (!permissions || typeof permissions !== 'object') {
    return res.status(400).json({ message: 'Invalid permissions data' });
  }

  try {
    const profiles = ['super_admin', 'admin_junior', 'coordinador', 'operador', 'recluta'];
    const updates = [];
    const params = [];
    const updatedProfiles = [];
    const today = new Date();

    profiles.forEach((profile) => {
      for (let i = 1; i <= 83; i++) {
        const key = `${profile}_${i}`;
        if (permissions[key] !== undefined) {
          const value = parseInt(permissions[key], 10);
          // Validate value is 0, 1, or 2
          if ([0, 1, 2].includes(value)) {
            updates.push(`${key} = ?`);
            params.push(value);
            if (!updatedProfiles.includes(profile)) {
              updatedProfiles.push(profile);
            }
          }
        }
      }
    });

    if (updates.length === 0) {
      return res.status(400).json({ message: 'No valid permissions to update' });
    }

    // Check if row exists
    const [existing] = await pool.query('SELECT COUNT(*) as count FROM access');

    if (existing[0].count === 0) {
      // Insert new row if none exists
      const columns = updates.map((u) => u.split(' = ')[0]);
      const placeholders = columns.map(() => '?').join(', ');

      await pool.query(
        `INSERT INTO access (${columns.join(', ')}) VALUES (${placeholders})`,
        params
      );
    } else {
      // Update existing row
      await pool.query(
        `UPDATE access SET ${updates.join(', ')} LIMIT 1`,
        params
      );

      await logUpdate(
        req.session.user.id,
        'progestor',
        `${req.session.user.username} actualizó los permisos de acceso generales de los perfiles`,
        today,
        ' ',
      );
    }

    res.json({ success: true });
  } catch (err) {
    console.error('UPDATE ACCESS ROLES ERROR:', err);
    res.status(500).json({ message: 'Server error' });
  }
};