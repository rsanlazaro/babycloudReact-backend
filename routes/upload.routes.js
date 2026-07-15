import express from 'express';
import { getUploadSignature, getCandidateUploadSignature } from '../controllers/upload.controller.js';
import authMiddleware from '../middleware/auth.js';

const router = express.Router();

router.get('/cloudinary-signature', authMiddleware, getUploadSignature);
router.get('/candidate-cloudinary-signature', authMiddleware, getCandidateUploadSignature);

export default router;
