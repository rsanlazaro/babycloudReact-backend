import express from 'express';
import {
  getRegister,
  updateRegister,
  updatePhase,
  initRegister,
} from '../controllers/cloudIps.controller.js';

const router = express.Router();

router.get('/:guestId',          getRegister);
router.post('/:guestId',         updateRegister);
router.post('/:guestId/phase',   updatePhase);
router.post('/:guestId/init',    initRegister);

export default router;