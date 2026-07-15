// routes/pnotes.routes.js
import { Router } from 'express';
import {
  getNotes, getUnreadCount, getNote,
  createNote, updateNote, updateNoteStatus,
  deleteNote, markRead,
} from '../controllers/pnotes.controller.js';

const router = Router();

router.get('/',             getNotes);
router.get('/unread-count', getUnreadCount);
router.get('/:id',          getNote);
router.post('/',            createNote);
router.put('/:id',          updateNote);
router.patch('/:id/status', updateNoteStatus);
router.delete('/:id',       deleteNote);
router.post('/:id/read',    markRead);

export default router;