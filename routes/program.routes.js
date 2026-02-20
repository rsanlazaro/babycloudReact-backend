// routes/programRoutes.js
import express from 'express';
const router = express.Router();

import { getAllPrograms, getProgramStats, getProgramById, createProgram, bulkDeletePrograms, updateProgram, deleteProgram } from '../controllers/program.controller.js';
import isAuthenticated from '../middleware/auth.js';

// All routes require authentication
router.use(isAuthenticated);

// GET /api/programs - Get all programs
router.get('/', getAllPrograms);

// GET /api/programs/stats - Get program statistics
router.get('/stats', getProgramStats);

// GET /api/programs/:id - Get single program with phases and expenses
router.get('/:id', getProgramById);

// POST /api/programs - Create new program
router.post('/', createProgram);

// POST /api/programs/bulk-delete - Bulk delete programs
router.post('/bulk-delete', bulkDeletePrograms);

// PUT /api/programs/:id - Update program
router.put('/:id', updateProgram);

// DELETE /api/programs/:id - Delete program
router.delete('/:id', deleteProgram);

export default router;