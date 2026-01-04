import pool from '../db.js';

export const getMe = async (req, res) => {
  if (!req.session?.user) {
    return res.status(401).json({ message: 'Unauthorized' });
  }

  try {
    const [rows] = await pool.query(
      `SELECT 
        id,
        username,
        mail,
        profile,
        profile_url
       FROM users
       WHERE id = ?`,
      [req.session.user.id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: 'User not found' });
    }

    const user = rows[0];

    res.json({
      id: user.id,
      username: user.username,
      email: user.mail,
      role: user.profile,
      profileImage: user.profile_url
        ? { url: user.profile_url }
        : null,
    });
  } catch (err) {
    console.error('GET ME ERROR:', err);
    res.status(500).json({ message: 'Server error' });
  }
};

export const updateProfileImage = async (req, res) => {
  if (!req.session?.user) {
    return res.status(401).json({ message: 'Unauthorized' });
  }

  const userId = req.session.user.id;
  const { profileUrl, publicId, version } = req.body;

  if (!profileUrl || !publicId || !version) {
    return res.status(400).json({ message: 'Missing required fields' });
  }

  try {
    // ✅ Update DB
    await pool.query(
      'UPDATE users SET profile_url = ? WHERE id = ?',
      [profileUrl, userId]
    );

    // ✅ Update session
    const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
    const url = `https://res.cloudinary.com/${cloudName}/image/upload/v${version}/${publicId}.jpg`;

    req.session.user.profileImage = { publicId, version, url };

    // ✅ Persist session (important for Redis)
    req.session.save(() => {
      res.json({ success: true });
    });
  } catch (err) {
    console.error('PROFILE IMAGE UPDATE ERROR:', err);
    res.status(500).json({ message: 'Failed to update profile image' });
  }
};

export const updateProfile = async (req, res) => {
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
    } else {
      query = `
        UPDATE users 
        SET username = ?, mail = ?, profile = ?
        WHERE id = ?
      `;
      params = [username, email, role, userId];
    }

    await pool.query(query, params);

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

// Create new user
export const createUser = async (req, res) => {
  if (!req.session?.user) {
    return res.status(401).json({ message: 'Unauthorized' });
  }

  const { username, email, password, profile } = req.body;

  if (!username || !email || !password) {
    return res.status(400).json({ message: 'Username, email, and password are required' });
  }

  try {
    // Check if username or email already exists
    const [existing] = await pool.query(
      'SELECT id FROM users WHERE username = ? OR mail = ?',
      [username, email]
    );

    if (existing.length > 0) {
      return res.status(409).json({ message: 'El usuario o correo ya existe' });
    }

    // Insert new user (storing password as plain text for now)
    const [result] = await pool.query(
      `INSERT INTO users (username, mail, password, profile, enabled, created_on)
       VALUES (?, ?, ?, ?, 1, NOW())`,
      [username, email, password, profile || 'recluta']
    );

    // Return the created user
    const [newUser] = await pool.query(
      `SELECT id, username, mail as email, profile, created_on, enabled
       FROM users WHERE id = ?`,
      [result.insertId]
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

  const { id } = req.params;

  // Prevent self-deletion
  if (parseInt(id) === req.session.user.id) {
    return res.status(400).json({ message: 'No puedes eliminar tu propia cuenta' });
  }

  try {
    await pool.query('DELETE FROM users WHERE id = ?', [id]);
    res.json({ success: true });
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

  if (!ids || !Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ message: 'No user IDs provided' });
  }

  // Prevent self-deletion
  if (ids.includes(req.session.user.id)) {
    return res.status(400).json({ message: 'No puedes eliminar tu propia cuenta' });
  }

  try {
    await pool.query('DELETE FROM users WHERE id IN (?)', [ids]);
    res.json({ success: true, deleted: ids.length });
  } catch (err) {
    console.error('BULK DELETE USERS ERROR:', err);
    res.status(500).json({ message: 'Server error' });
  }
};