import express from 'express';
import {
  getAllGuests,
  createGuest,
  updateGuest,
  deleteGuest,
  bulkDeleteGuests,
} from '../controllers/guest.controller.js';

const router = express.Router();

// Guest management routes
router.get('/', getAllGuests);
router.post('/', createGuest);
router.post('/bulk-delete', bulkDeleteGuests);
router.put('/:id', updateGuest);
router.delete('/:id', deleteGuest);

export default router;