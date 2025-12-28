import express from 'express';
// controllers/auth.controller.js
import pool from '../db.js';

export const login = async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({
      message: 'Ingrese usuario y contraseña',
    });
  }

  try {
    const [rows] = await pool.query(
      'SELECT id, username, password, profile_url FROM users WHERE username = ?',
      [username]
    );

    if (rows.length === 0) {
      return res.status(401).json({
        message: 'El usuario no coincide con la contraseña',
      });
    }

    const user = rows[0];

    const valid = password === user.password;
    if (!valid) {
      return res.status(401).json({
        message: 'Contraseña incorrecta',
      });
    }

    req.session.user = {
      id: user.id,
      username: user.username,
      profileImage: user.profile_url
        ? { url: user.profile_url }
        : null,
    };

    req.session.save(() => {
      res.json({ success: true });
    });
  } catch (err) {
    console.error('LOGIN ERROR:', err);
    res.status(500).json({ message: 'Server error' });
  }
};

export const logout = (req, res) => {
  req.session.destroy(err => {
    if (err) {
      return res.status(500).json({ message: 'Logout failed' });
    }

    res.clearCookie('connect.sid');
    res.json({ success: true });
  });
};