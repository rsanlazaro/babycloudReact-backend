import express from 'express';
import { getAll, create, getById, update, remove, updateStatus } from '../controllers/paymentsGest.controller.js';

const router = express.Router();

// ── Collection ────────────────────────────────────────────────────────────────
router.get('/', getAll);       // GET  /api/payments-gest
router.post('/', create);       // POST /api/payments-gest

// ── Single record ─────────────────────────────────────────────────────────────
router.get('/:id', getById);      // GET    /api/payments-gest/:id
router.put('/:id', update);        // PUT    /api/payments-gest/:id
router.delete('/:id', remove);        // DELETE /api/payments-gest/:id
router.patch('/:id/status', updateStatus);  // PATCH  /api/payments-gest/:id/status

export default router;
