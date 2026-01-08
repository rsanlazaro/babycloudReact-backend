import express from 'express';
import { getLogs } from '../controllers/logs.controller.js';

const router = express.Router();

router.get('/', getLogs);

export default router;