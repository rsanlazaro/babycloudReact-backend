// backend/routes/guestPortal.routes.js — mounted at /api/guest-portal
// For guests with the IP profile (Baby Cloud → Inicio). The controller checks
// the guest session itself (guests don't pass the users-only auth middleware).
import { Router } from 'express';
import { getMe, updateMe } from '../controllers/guestPortal.controller.js';

const router = Router();

router.get('/me', getMe);
router.put('/me', updateMe);

export default router;