// backend/routes/paymentsGest.routes.js

import express from 'express';
import { getAll, create, getById, update, remove, updateStatus, curpLookup } from '../controllers/paymentsGest.controller.js';

const router = express.Router();

// ── Collection ────────────────────────────────────────────────────────────────
router.get('/', getAll);       // GET  /api/payments-gest
router.post('/', create);       // POST /api/payments-gest

// ── CURP link with SORT_GES (must be before /:id) ─────────────────────────────
router.get('/curp-lookup/:curp', curpLookup); // GET /api/payments-gest/curp-lookup/:curp

// ── Single record ─────────────────────────────────────────────────────────────
router.get('/:id', getById);      // GET    /api/payments-gest/:id
router.put('/:id', update);        // PUT    /api/payments-gest/:id
router.delete('/:id', remove);        // DELETE /api/payments-gest/:id
router.patch('/:id/status', updateStatus);  // PATCH  /api/payments-gest/:id/status

export default router;