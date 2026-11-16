// backend/routes/guestPortal.routes.js — mounted at /api/guest-portal
// For guests with the IP profile (Baby Cloud → Inicio). The controller checks
// the guest session itself (guests don't pass the users-only auth middleware).
import { Router } from 'express';
import { getMe, updateMe, getDocSignature, saveDoc, streamDoc, findParejaByPasaporte } from '../controllers/guestPortal.controller.js';

const router = Router();

router.get('/me', getMe);
router.put('/me', updateMe);
// Linkar pareja: search another IP by passport
router.get('/pareja', findParejaByPasaporte);
// Documentos iniciales (their own Check list → Primer viaje PDFs)
router.get('/doc-signature', getDocSignature);
router.put('/doc', saveDoc);
router.get('/doc-stream', streamDoc);

export default router;