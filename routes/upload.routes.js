import express from 'express';
import { getUploadSignature } from '../controllers/upload.controller.js';
import authMiddleware from '../middleware/auth.js';

const router = express.Router();

router.get('/cloudinary-signature', authMiddleware, getUploadSignature);

export default router;
