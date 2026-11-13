import pool from '../db.js';
import { logUpdate, logCreate, logDelete } from '../services/activityLogger.js';
import { pushGuestToIp } from '../services/ipGuestSync.js';
import {
    normalizeGuestPasaporte, GUEST_PASAPORTE_REGEX, findGuestByPasaporte, autoLinkGuestByPasaporte,
} from '../services/ipGuestLink.js';

// Passport of an IP account: the key that links it with its Sort_IPS register.
// Returns { value } (null = empty) or { error }.
const parsePasaporte = (raw) => {
    const value = normalizeGuestPasaporte(raw);
    if (!value) return { value: null };
    if (!GUEST_PASAPORTE_REGEX.test(value)) return { error: 'El pasaporte debe tener entre 5 y 20 letras o números' };
    return { value };
};
// Generate the next sequential "Recluta" code for the current year
// Format: R + YYYY + 3-digit increasing number (e.g. R2026001, R2026002, ...)
const generateReclutaCode = async () => {
    const year = new Date().getFullYear();
    const prefix = `R${year}`;

    const [rows] = await pool.query(
        `SELECT codigo FROM guests
     WHERE codigo LIKE ?
     ORDER BY codigo DESC
     LIMIT 1`,
        [`${prefix}%`]
    );

    let nextNumber = 1;
    if (rows.length > 0 && rows[0].codigo) {
        const lastNumber = parseInt(rows[0].codigo.slice(prefix.length), 10);
        if (!isNaN(lastNumber)) {
            nextNumber = lastNumber + 1;
        }
    }

    if (nextNumber > 999) {
        throw new Error(`Se alcanzó el máximo de códigos Recluta (999) para el año ${year}`);
    }

    const paddedNumber = String(nextNumber).padStart(3, '0');
    return `${prefix}${paddedNumber}`;
};

// Get all guests
export const getAllGuests = async (req, res) => {
    if (!req.session?.user) {
        return res.status(401).json({ message: 'Unauthorized' });
    }

    try {
        // pasaporte + the Sort_IPS register linked to the account (sort_ip_id / sort_ip_nombre)
        const [rows] = await pool.query(
            `SELECT 
        g.id,
        g.username,
        g.password,
        g.mail,
        g.profile,
        g.phone,
        g.pasaporte,
        g.codigo,
        g.created_on,
        g.enabled,
        c.id AS sort_ip_id,
        c.nombre_completo AS sort_ip_nombre
       FROM guests g
       LEFT JOIN sort_ip_candidates c ON c.guest_id = g.id
       ORDER BY g.created_on DESC`
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

    const { username, email, password, profile, phone } = req.body;
    const pas = parsePasaporte(req.body.pasaporte);
    if (pas.error) return res.status(400).json({ message: pas.error });

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
        if (pas.value) {
            const other = await findGuestByPasaporte(pas.value);
            if (other) return res.status(409).json({ message: `El pasaporte ${pas.value} ya lo tiene la cuenta ${other.username}` });
        }

        // Auto-generate the Código only for Recluta guests (R + year + 001-999)
        let codigo = null;
        if (profile === 'recluta') {
            codigo = await generateReclutaCode();
        }

        const [result] = await pool.query(
            `
      INSERT INTO guests (
        username,
        mail,
        password,
        profile,
        phone,
        pasaporte,
        codigo,
        enabled,
        created_on
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, NOW())
      `,
            [username, email, password, profile, phone || null, pas.value, codigo]
        );

        const metadata = [username, email, password, profile, phone || null, codigo];

        // Return created guest
        const [newGuest] = await pool.query(
            `
      SELECT
        id,
        username,
        mail,
        password,
        profile,
        phone,
        pasaporte,
        codigo,
        enabled,
        created_on
      FROM guests
      WHERE id = ?
      `,
            [result.insertId]
        );
        // Same passport as a Sort_IPS register without account → linked
        let link = null;
        try {
            link = await autoLinkGuestByPasaporte(result.insertId, req.session.user.id);
        } catch (linkErr) {
            console.error('GUEST → SORT_IPS LINK ERROR:', linkErr);
        }

        await logCreate(
            req.session.user.id,
            'progestor',
            `Creó al invitado ${username}`,
            today,
            metadata,
        );

        res.status(201).json({
            ...newGuest[0],
            sort_ip_id: link?.ipId || null,
            sort_ip_nombre: link?.nombre_completo || null,
        });
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
    const { username, mail, password, profile, phone, enabled } = req.body;

    try {
        // Build dynamic update query
        const updates = [];
        const params = [];
        let pasaporteChanged = false;
        if (req.body.pasaporte !== undefined) {
            const pas = parsePasaporte(req.body.pasaporte);
            if (pas.error) return res.status(400).json({ message: pas.error });
            const [[cur]] = await pool.query(
                'SELECT g.pasaporte, c.id AS sort_ip_id FROM guests g LEFT JOIN sort_ip_candidates c ON c.guest_id = g.id WHERE g.id = ?',
                [id]
            );
            if (cur?.sort_ip_id && (pas.value || null) !== (cur.pasaporte || null)) {
                return res.status(400).json({ message: 'Esta cuenta está vinculada a un registro de Sort_IPS: el pasaporte se cambia desde Sort_IPS → Alta IP' });
            }
            if (pas.value) {
                const other = await findGuestByPasaporte(pas.value);
                if (other && Number(other.id) !== Number(id)) {
                    return res.status(409).json({ message: `El pasaporte ${pas.value} ya lo tiene la cuenta ${other.username}` });
                }
            }
            updates.push('pasaporte = ?');
            params.push(pas.value);
            pasaporteChanged = true;
        }

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

        if (phone !== undefined) {
            updates.push('phone = ?');
            params.push(phone);
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

        // Two-way sync: name/email/phone also go to the linked Sort_IPS register
        try {
            await pushGuestToIp(id, { username, mail, phone }, req.session.user.id);
        } catch (syncErr) {
            console.error('GUEST → SORT_IPS SYNC ERROR:', syncErr);
        }

        // New passport (or profile changed to IP) → link with the Sort_IPS register that has it
        let link = null;
        if (pasaporteChanged || profile !== undefined) {
            try {
                link = await autoLinkGuestByPasaporte(id, req.session.user.id);
            } catch (linkErr) {
                console.error('GUEST → SORT_IPS LINK ERROR:', linkErr);
            }
        }

        await logUpdate(
            req.session.user.id,
            'progestor',
            `Actualizó los datos del invitado ${updatedUsername}`,
            today,
            `${id}`,   // was the list of new values — it included the password
        );

        res.json({ success: true, sort_ip_id: link?.ipId || null, sort_ip_nombre: link?.nombre_completo || null });
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