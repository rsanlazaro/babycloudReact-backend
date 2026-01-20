import express from 'express';
import { login, logout, verifySpecialAccess } from '../controllers/auth.controller.js';

const router = express.Router();

router.post('/login', login);
router.post('/logout', logout);
router.post('/bills', verifySpecialAccess);

export default router;
