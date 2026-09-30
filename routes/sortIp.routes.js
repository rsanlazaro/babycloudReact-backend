// backend/routes/sortIp.routes.js — mounted at /api/sort-ip
import { Router } from 'express';
import {
  getAllIps, getIp, getAvailableGuests, createIp, updateIp, saveSection, deleteIp,
} from '../controllers/sortIp.controller.js';

const router = Router();

router.get('/',                      getAllIps);
router.post('/',                     createIp);
router.get('/guests-available',      getAvailableGuests); // must be before '/:id'
router.get('/:id',                   getIp);
router.put('/:id',                   updateIp);
router.delete('/:id',                deleteIp);
router.put('/:id/sections/:section', saveSection);

export default router;