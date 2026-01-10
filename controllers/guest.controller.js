import pool from '../db.js';
import { logUpdate, logCreate, logDelete } from '../services/activityLogger.js';

// Get all guests
export const getAllGuests = async (req, res) => {
    if (!req.session?.user) {
        return res.status(401).json({ message: 'Unauthorized' });
    }

    try {
        const [rows] = await pool.query(
            `SELECT 
        id,
        username,
        password,
        mail,
        profile,
        created_on,
        enabled
       FROM guests
       ORDER BY created_on DESC`
        );

        res.json(rows);
    } catch (err) {
        console.error('GET ALL GUESTS ERROR:', err);
        res.status(500).json({ message: 'Server error' });
    }
};

// Create guest
export const createGuest = async (req, res) => {
    const today = new Date();
    if (!req.session?.user) {
        return res.status(401).json({ message: 'Unauthorized' });
    }

    const { username, email, password, profile } = req.body;

    if (!username || !email || !password || !profile) {
        return res.status(400).json({
            message: 'Username, email, password, and profile are required',
        });
    }

    try {
        // Check if guest already exists
        const [existing] = await pool.query(
            'SELECT id FROM guests WHERE username = ? OR mail = ?',
            [username, email]
        );

        if (existing.length > 0) {
            return res.status(409).json({
                message: 'El invitado o correo ya existe',
            });
        }

        const [result] = await pool.query(
            `
      INSERT INTO guests (
        username,
        mail,
        password,
        profile,
        enabled,
        created_on
      )
      VALUES (?, ?, ?, ?, 1, NOW())
      `,
            [username, email, password, profile]
        );

        const metadata = [username, email, password, profile];

        // Return created guest
        const [newGuest] = await pool.query(
            `
      SELECT
        id,
        username,
        mail,
        password,
        profile,
        enabled,
        created_on
      FROM guests
      WHERE id = ?
      `,
            [result.insertId]
        );

        await logCreate(
            req.session.user.id,
            'progestor',
            `Creó al invitado ${username}`,
            today,
            metadata,
        );

        res.status(201).json(newGuest[0]);
    } catch (err) {
        console.error('CREATE GUEST ERROR:', err);
        res.status(500).json({ message: 'Server error' });
    }
};

// Update guest
export const updateGuest = async (req, res) => {
    if (!req.session?.user) {
        return res.status(401).json({ message: 'Unauthorized' });
    }

    const today = new Date();
    const { id } = req.params;
    const { username, mail, password, profile, enabled } = req.body;

    try {
        // Build dynamic update query
        const updates = [];
        const params = [];

        if (username !== undefined) {
            // Check if username is taken by another guest
            const [existing] = await pool.query(
                'SELECT id FROM guests WHERE username = ? AND id != ?',
                [username, id]
            );
            if (existing.length > 0) {
                return res.status(409).json({ message: 'El nombre de usuario ya está en uso' });
            }
            updates.push('username = ?');
            params.push(username);
        }

        if (mail !== undefined) {
            // Check if email is taken by another guest
            const [existing] = await pool.query(
                'SELECT id FROM guests WHERE mail = ? AND id != ?',
                [mail, id]
            );
            if (existing.length > 0) {
                return res.status(409).json({ message: 'El correo electrónico ya está en uso' });
            }
            updates.push('mail = ?');
            params.push(mail);
        }

        if (password !== undefined && password.trim() !== '') {
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
            `UPDATE guests SET ${updates.join(', ')} WHERE id = ?`,
            params
        );

        const [UpdatedRow] = await pool.query(
            `
          SELECT
            username
          FROM guests
          WHERE id = ?
          `,
            id
        );

        if (UpdatedRow.length === 0) {
            return res.status(404).json({ message: 'Guest not found' });
        }

        const updatedUsername = UpdatedRow[0].username;

        await logUpdate(
            req.session.user.id,
            'progestor',
            `Actualizó los datos del invitado ${updatedUsername}`,
            today,
            `${params}`,
        );

        res.json({ success: true });
    } catch (err) {
        console.error('UPDATE GUEST ERROR:', err);
        res.status(500).json({ message: 'Server error' });
    }
};

// Delete guest
export const deleteGuest = async (req, res) => {
    if (!req.session?.user) {
        return res.status(401).json({ message: 'Unauthorized' });
    }

    const today = new Date();
    const { id } = req.params;

    const [deletedRow] = await pool.query(
        `
      SELECT
        username
      FROM guests
      WHERE id = ?
      `,
        [id]
    );

    if (deletedRow.length === 0) {
        return res.status(404).json({ message: 'Guest not found' });
    }

    const username = deletedRow[0].username;

    try {
        await pool.query('DELETE FROM guests WHERE id = ?', [id]);
        res.json({ success: true });
        await logDelete(
            req.session.user.id,
            'progestor',
            `Eliminó al invitado ${username}`,
            today,
            `${id}`,
        );
    } catch (err) {
        console.error('DELETE GUEST ERROR:', err);
        res.status(500).json({ message: 'Server error' });
    }
};

// Bulk delete guests
export const bulkDeleteGuests = async (req, res) => {
    if (!req.session?.user) {
        return res.status(401).json({ message: 'Unauthorized' });
    }

    const { ids } = req.body;
    const today = new Date();

    if (!ids || !Array.isArray(ids) || ids.length === 0) {
        return res.status(400).json({ message: 'No guest IDs provided' });
    }

    try {
        const [rows] = await pool.query(
            'SELECT username FROM guests WHERE id IN (?)',
            [ids]
        );

        const usernames = rows.map(r => r.username);
        await pool.query('DELETE FROM guests WHERE id IN (?)', [ids]);
        await logDelete(
            req.session.user.id,
            'progestor',
            `Eliminó a los invitados [${usernames}]`,
            today,
            `${ids}`,
        );
        res.json({ success: true, deleted: ids.length });
    } catch (err) {
        console.error('BULK DELETE GUESTS ERROR:', err);
        res.status(500).json({ message: 'Server error' });
    }
};